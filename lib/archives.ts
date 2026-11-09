import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { run } from "./media";
import { geminiPickImage } from "./brain";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const UA = "DOCUSTUDIO/1.0 (local documentary renderer)";
const API = "https://commons.wikimedia.org/w/api.php";
const OPENVERSE = "https://api.openverse.org/v1/images/";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wikimedia asks clients not to burst; serialize requests with a small gap.
let gate: Promise<void> = Promise.resolve();
async function throttle(ms = 900): Promise<void> {
  const run = gate.then(() => sleep(ms));
  gate = run.catch(() => undefined);
  await run;
}

interface WikimediaPage {
  index?: number;
  title?: string;
  origin?: "commons" | "openverse";
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    mime?: string;
    width?: number;
    height?: number;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

export interface ArchiveStill {
  title: string;
  license: string;
  artist: string;
}

const STYLE_WORDS =
  /\b(cinematic|documentary|still|photo|photograph|image|shot|film|grain|35mm|16mm|lighting|light|shallow|depth|field|mood|muted|palette|high|detail|dramatic|atmospheric|composition|close-up|wide|angle|portrait|scene|frame|realism|archival|style|era|no text)\b/gi;

function cleanQuery(raw: string): string {
  return raw
    .replace(/[“”"'()[\]{}:;,.!?/\\|]/g, " ")
    .replace(STYLE_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

/** Repeat searches inside one film are served from memory instead of Commons. */
const searchCache = new Map<string, { at: number; pages: WikimediaPage[] }>();

async function search(query: string): Promise<WikimediaPage[]> {
  const hit = searchCache.get(query);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.pages;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: "2000",
  });
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    const res = await fetch(`${API}?${params.toString()}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(45_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { query?: { pages?: WikimediaPage[] } };
      const pages = data.query?.pages ?? [];
      if (pages.length) {
        if (searchCache.size > 60) searchCache.clear();
        searchCache.set(query, { at: Date.now(), pages });
      }
      return pages;
    }
    status = res.status;
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(15_000, retryAfter * 1000)
        : 2500 * (attempt + 1),
    );
  }
  throw new Error(`Wikimedia search returned ${status}`);
}

interface OpenverseResult {
  id?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  license?: string;
  license_version?: string;
  creator?: string;
  source?: string;
  tags?: Array<{ name?: string }>;
}

// Openverse ranks by relevance rather than AND-matching every word, so it
// finds "Scottish lighthouse" where Commons' full-text search returns nothing.
// The anonymous tier allows 20 requests/minute, 200/day.
let ovGate: Promise<void> = Promise.resolve();
let ovLast = 0;
async function throttleOpenverse(): Promise<void> {
  // The wait must be computed inside the chain: computing it up front let
  // concurrent callers all sleep in parallel and burst the endpoint.
  const run = ovGate.then(async () => {
    const gap = 3200 - (Date.now() - ovLast);
    if (gap > 0) await sleep(gap);
    ovLast = Date.now();
  });
  ovGate = run.catch(() => undefined);
  await run;
}

const openverseCache = new Map<string, { at: number; pages: WikimediaPage[] }>();

async function searchOpenverse(query: string): Promise<WikimediaPage[]> {
  const hit = openverseCache.get(query);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.pages;

  const params = new URLSearchParams({
    q: query,
    page_size: "20",
    license: "cc0,pdm,by,by-sa",
    mature: "false",
  });
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttleOpenverse();
    const res = await fetch(`${OPENVERSE}?${params.toString()}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { results?: OpenverseResult[] };
      const pages: WikimediaPage[] = (data.results ?? [])
        .filter((r) => r.url && (r.width ?? 0) >= 640 && (r.height ?? 0) >= 400)
        .map((r, i) => ({
          index: i,
          title: r.title || r.id || "",
          origin: "openverse" as const,
          imageinfo: [
            {
              url: r.url,
              thumburl: r.thumbnail,
              mime: /\.png(\?|$)/i.test(r.url!) ? "image/png" : "image/jpeg",
              width: r.width,
              height: r.height,
              extmetadata: {
                Artist: { value: r.creator ?? "" },
                LicenseShortName: {
                  value: [r.license?.toUpperCase(), r.license_version].filter(Boolean).join(" "),
                },
                ImageDescription: {
                  value: [r.title, ...(r.tags ?? []).map((t) => t.name ?? "")].join(" "),
                },
              },
            },
          ],
        }));
      if (openverseCache.size > 60) openverseCache.clear();
      openverseCache.set(query, { at: Date.now(), pages });
      return pages;
    }
    status = res.status;
    if (res.status === 429) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    break;
  }
  if (process.env.ARCHIVE_DEBUG === "1") {
    process.stderr.write(`  [openverse] search failed (${status})\n`);
  }
  return [];
}

interface Candidate {
  page: WikimediaPage;
  info: NonNullable<WikimediaPage["imageinfo"]>[number];
  url: string;
  score: number;
}

function fileTitle(page: WikimediaPage): string {
  return (page.title ?? "").replace(/^File:/, "").replace(/_/g, " ").trim();
}

const DOC_TITLE =
  /\b(passport|document|documents|stamp|banknote|poster|leaflet|letter|diary|page|book|cover|logo|insignia|organisationsbuch|chart|diagram|plaque|seal|coin|badge|emblem|coat of arms|manual|form|receipt|map|laws?|enabling act|translation|decree|transcript|newspaper|magazine|clipping|headline|brochure|programme|program|announcement|notice|bulletin|communique|stammbaum|genealogy|pedigree)\b/i;

const ART_TITLE =
  /\b(postcard|painting|drawing|illustration|cartoon|comic|woodcut|engraving|lithograph|sketch|watercolour|watercolor|artwork|print)\b/i;

const MODERN_TITLE =
  /\b(museum|exhibition|display case|memorial|tourist|tourism|replica|reconstruction|modern|present day|today|then and now|panoramio|anniversary|site of|location of|place of|standing above|gedenktafel|panel|promotional|apartment|parking|hotel|own work|flickr|infosys|graffiti|mural|street art|sticker|statue|sculpture|monument|reenactment|re-enactment|cosplay|201\d|202\d)\b/i;

const CAPTION_STOP = new Set([
  "the", "and", "that", "with", "from", "this", "which", "were", "their", "when", "what",
  "into", "before", "after", "about", "would", "could", "there", "where", "while", "been",
  "have", "also", "over", "then", "they", "than", "them", "these", "those", "such", "more",
]);

function metadataDates(info: NonNullable<WikimediaPage["imageinfo"]>[number]): string {
  const meta = info.extmetadata ?? {};
  // DateTime/Date are upload timestamps on Commons (often this year) and would
  // make every archival scan look like a modern photo. Only the capture date
  // says when the photograph was actually taken.
  return meta.DateTimeOriginal?.value ?? "";
}

function metadataText(info: NonNullable<WikimediaPage["imageinfo"]>[number]): string {
  const meta = info.extmetadata ?? {};
  // Descriptions and categories carry facts (birth years, "painting", "map")
  // that must never be mistaken for the capture date of the image itself.
  return [
    metadataDates(info),
    meta.ImageDescription?.value,
    meta.Categories?.value,
    meta.ObjectName?.value,
    meta.Artist?.value,
  ]
    .filter(Boolean)
    .join(" ");
}

function yearsInText(text: string): number[] {
  // "1930s" / "1940s" are decades, not exact years, but they still date a photo.
  return [...new Set((text.match(/\b(1[89]\d{2}|20\d{2})s?\b/g) ?? []).map((s) => Number(s.slice(0, 4))))];
}

function eraRange(era?: string): [number, number] | null {
  const years = yearsInText(era ?? "");
  if (!years.length) return null;
  return [Math.min(...years), Math.max(...years)];
}

export interface RankContext {
  narration?: string;
  caption?: string;
  era?: string;
  /** Proper names that must appear in a candidate's filename to be relevant. */
  must?: string[];
}

const NAME_STOP = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "president", "chancellor",
  "minister", "general", "colonel", "captain", "king", "queen", "prince",
  "princess", "pope", "professor", "lord", "sir", "the", "this", "that",
  "when", "after", "before", "during", "within", "inside", "city", "war",
]);

function strongNames(query: string): string[] {
  const words = (query.match(/\b[A-Z][\p{L}'’-]{3,}\b/gu) ?? [])
    .map((w) => w.replace(/['’]s$/i, "").toLowerCase())
    .filter((w) => !NAME_STOP.has(w));
  return [...new Set(words)];
}

function ranked(
  pages: WikimediaPage[],
  dims: { w: number; h: number },
  query: string,
  ctx: RankContext = {},
): Candidate[] {
  const target = dims.w / dims.h;
  const tokens = [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4),
    ),
  ];
  const captionTokens = [
    ...new Set(
      `${ctx.caption ?? ""}`
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 5 && !CAPTION_STOP.has(t)),
    ),
  ].slice(0, 8);
  const sceneYears = yearsInText(`${query} ${ctx.narration ?? ""}`);
  const era = eraRange(ctx.era);
  // A role word ("chancellor", "president") is what pulls in modern photos of
  // the wrong country's officials; the gate only applies to those queries.
  const roleCollision =
    /\b(chancellor|president|minister|general|admiral|king|queen|prince|pope|leader|dictator|senator|governor|ambassador)\b/i.test(
      query,
    );
  const destruction = /\b(burn|burned|burning|destroy|destroyed|ruin|ruins|rubble|flames|razed|wreck|wrecked|aftermath)\b/i.test(
    `${ctx.narration ?? ""} ${ctx.caption ?? ""}`,
  );

  const usable = pages
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info) return undefined;
      const mime = info.mime ?? "";
      const width = info.width ?? 0;
      const height = info.height ?? 0;
      // Iconic period photographs are often only ~500px wide; at 720p with
      // motion they still read better than a sharp modern photo of the site.
      if (!/jpeg|png|webp/i.test(mime) || width < 520 || height < 320) return undefined;
      const url = info.thumburl || info.url;
      if (!url) return undefined;
      const aspect = width / height;
      const aspectPenalty = Math.abs(Math.log(aspect / target));
      const resolution = Math.min(width, 3000) / 3000;
      const title = fileTitle(page).toLowerCase();
      const overlap = tokens.reduce((n, t) => n + (title.includes(t) ? 1 : 0), 0);
      const captionOverlap = captionTokens.reduce((n, t) => n + (title.includes(t) ? 1 : 0), 0);
      // Commons descriptions often name the event even when the filename is
      // generic ("Bundesarchiv Bild 183-..."), so they count at a lower weight.
      // Openverse tags are too broad to be evidence, and its own relevance
      // order already carries the signal.
      const metaWords = metadataText(info).toLowerCase();
      const metaOverlap =
        page.origin === "openverse"
          ? 0
          : tokens.reduce((n, t) => n + (metaWords.includes(t) ? 1 : 0), 0);
      // Names are a tiebreaker, not a trump card: a Hitler portrait must not
      // outrank the actual beer hall, prison or protest the scene describes.
      const must = ctx.must ?? [];
      const nameHits = must.filter((name) => title.includes(name)).length;
      const nameGate = roleCollision && must.length && !nameHits ? 1.8 : 0;
      const nameBonus = Math.min(nameHits, 2) * 0.35;

      // "Vienna, Va." and Library of Congress scans are US material; in a
      // European story they are always a search accident.
      const eraLower = (ctx.era ?? "").toLowerCase();
      const euroStory =
        /\b(german|germany|austria|france|britain|england|italy|russia|soviet|poland|europe|spain|netherlands|belgium|reich)\b/.test(
          eraLower,
        );
      const usCue =
        /,\s*(va|w\.?\s?va|pa|n\.?\s?y|calif|ill|ohio|tex|ala|ga|fla|mich|minn|wis|ore|wash|colo|ariz|n\.?\s?mex|okla|kan|neb|iowa|ind|ky|tenn|miss|ark|la|s\.?\s?c|n\.?\s?c|s\.?\s?d|n\.?\s?d)\.|\bvirginia\b|\blibrary of congress\b|\blccn\b|\bnational historic\b|\bnational park\b/i.test(
          title,
        );
      const regionPenalty = euroStory && usCue ? 1.8 : 0;

      // Documents and scans match keywords but look nothing like a period
      // photograph. Artwork and museum shots are also wrong for an archival film.
      // Captions frequently reveal a map when the filename does not.
      const metaLower = metadataText(info).toLowerCase();
      const docPenalty =
        (DOC_TITLE.test(title) ? 1.4 : 0) +
        (/\b(map|diagram|chart|locator|infographic|documents|treaties)\b/i.test(metaLower) ? 1.2 : 0);
      const artPenalty =
        ART_TITLE.test(title) ||
        /\b(painter|graphic artist|print by|paintings?|watercolours?|watercolors?|drawing|sketch|engraving|etchings?|lithograph|artwork)\b/i.test(
          metaLower,
        )
          ? 1.6
          : 0;
      const modernPenalty = MODERN_TITLE.test(title) ? 1.3 : 0;
      // Categories such as "2023 photographs" mean a contemporary photograph,
      // even when the uploader gave it a historical filename.
      const categoryYears = yearsInText(info.extmetadata?.Categories?.value ?? "");
      const modernCategory = categoryYears.some((y) => y >= 2000) ? 1.6 : 0;
      // NAC scans carry a burned-in archive caption bar across the bottom.
      const watermarkPenalty = /images from narodowe archiwum cyfrowe/i.test(metaLower) ? 1.2 : 0;
      // Period photographs are almost always JPEG; PNG uploads are usually
      // maps, diagrams or screenshots.
      const pngPenalty = /png/i.test(mime) ? 0.7 : 0;
      // A long numeric id in the filename is a Flickr/event upload, which is
      // almost always a contemporary photograph.
      const uploadIdPenalty = /\b\d{9,}\b/.test(title) ? 0.9 : 0;
      // Openverse has no description field worth trusting, so a result whose
      // title shares none of the query is a relevance miss.
      const noTitleMatch =
        page.origin === "openverse" && tokens.length > 0 && overlap === 0 ? 1.6 : 0;

      // A photo from the wrong decade is the biggest source of mismatches.
      // Commons' capture dates catch modern site photos whose titles carry no year.
      const metaText = metadataText(info);
      const titleYears = [...new Set([...yearsInText(title), ...yearsInText(metadataDates(info))])];
      let yearScore = 0;
      if (titleYears.length) {
        if (sceneYears.length) {
          if (titleYears.some((y) => sceneYears.includes(y))) yearScore -= 1.2;
          else if (era && titleYears.every((y) => y >= era[0] - 1 && y <= era[1] + 1)) {
            const gap = Math.min(
              ...titleYears.map((y) => Math.min(...sceneYears.map((s) => Math.abs(y - s)))),
            );
            yearScore += gap <= 3 ? 0.15 : gap <= 10 ? 0.9 : 2.4;
          } else yearScore += 1.4;
        } else if (era && titleYears.every((y) => y >= era[0] - 1 && y <= era[1] + 1)) {
          yearScore -= 0.25;
        } else if (era && titleYears.every((y) => y > era[1] + 10)) {
          // An explicit post-war date on a historical story is a modern photo.
          yearScore += 2.2;
        }
      }
      if (era && titleYears.some((y) => y > era[1] + 10)) yearScore += 2.2;

      // Match the image state to the line: a burning-synagogue scene needs a
      // photo of the ruin, not the building before it was attacked.
      const destructionScore =
        destruction &&
        /zerstört|destroyed|ruin|rubble|brenn|burn|flame|aftermath|debris/i.test(
          `${title} ${metaText.toLowerCase()}`,
        )
          ? -2
          : 0;
      // Bundesarchiv scans are period photographs and rarely modern site shots.
      const archivalScore = /bundesarchiv/i.test(title) ? -0.35 : 0;

      return {
        page,
        info,
        url,
        score:
          aspectPenalty * 4 -
          resolution -
          (page.index ?? 0) * 0.02 -
          Math.min(overlap, 3) * 0.7 -
          Math.min(captionOverlap, 2) * 0.45 -
          Math.min(metaOverlap, 2) * 0.25 +
          docPenalty +
          artPenalty +
          modernPenalty +
          modernCategory +
          watermarkPenalty +
          pngPenalty +
          uploadIdPenalty +
          noTitleMatch +
          nameGate -
          nameBonus +
          regionPenalty +
          yearScore +
          destructionScore +
          archivalScore,
      };
    })
    .filter(Boolean) as Candidate[];

  usable.sort((a, b) => a.score - b.score);
  // If the query has enough clean matches, never surface scans, artwork or
  // museum displays.
  const clean = usable.filter((c) => {
    const title = fileTitle(c.page);
    const meta = metadataText(c.info).toLowerCase();
    const catYears = yearsInText(c.info.extmetadata?.Categories?.value ?? "");
    return (
      !DOC_TITLE.test(title) &&
      !ART_TITLE.test(title) &&
      !MODERN_TITLE.test(title) &&
      !catYears.some((y) => y >= 2000) &&
      !/png/i.test(c.info.mime ?? "") &&
      !/\b(map|diagram|chart|locator|infographic|documents|treaties)\b/i.test(meta) &&
      !/\b(painter|graphic artist|print by|paintings?|watercolours?|watercolors?|drawing|sketch|engraving|etchings?|lithograph|artwork)\b/i.test(
        meta,
      )
    );
  });
  // One clean photo is enough to rule out the scans, plans and cartoons: a
  // single lantern-slide or architectural plan reads as a mistake beside
  // photographs, even when it is top-ranked.
  const result = clean.length ? clean : usable;
  if (process.env.ARCHIVE_DEBUG === "1") {
    for (const c of result.slice(0, 8)) {
      process.stderr.write(`  [archive] ${c.score.toFixed(2)} ${fileTitle(c.page)}\n`);
    }
  }
  return result;
}

export interface ArchiveOptions {
  /** Scene index; rotates through the candidate pool so scenes differ. */
  variant?: number;
  /** Images already used in this film, so two scenes never share a still. */
  used?: Set<string>;
  /** Scene narration/caption/era used to score candidates for relevance. */
  narration?: string;
  caption?: string;
  era?: string;
  /** Ask Gemini to pick among the top candidates (requires a key). */
  rerank?: boolean;
  /** Reject a title that shares nothing concrete with the scene. */
  accept?: (title: string) => boolean;
}

/**
 * Free archival still from Wikimedia Commons (public domain / CC).
 * Real photographs suit documentaries better than generated stills, need no
 * key, have no watermark and are not rate limited like AI endpoints.
 */
export async function fetchArchiveStill(
  query: string,
  dims: { w: number; h: number },
  outPath: string,
  options: ArchiveOptions = {},
): Promise<ArchiveStill> {
  const cleaned = cleanQuery(query);
  // A query like "chancellor inauguration 1933" drowns in modern inauguration
  // photos. Searching the proper names directly guarantees period photographs
  // of the actual people are in the pool before ranking.
  const must = strongNames(query);
  const nameYear = yearsInText(query).sort((a, b) => a - b)[0];
  const nameQuery = must.length
    ? `${must.slice(0, 3).join(" ")}${nameYear ? ` ${nameYear}` : ""}`
    : "";
  const attempts = [
    cleaned,
    nameQuery,
    cleaned.split(" ").slice(0, 4).join(" "),
    cleaned.split(" ").slice(0, 2).join(" "),
  ].filter((q, i, all) => q.length > 1 && all.indexOf(q) === i);

  // Merge the specific query with broader fallbacks, then rank the whole pool
  // against the exact scene wording. A narrow query can return one perfect
  // photo; discarding it for a broader list of mediocre matches was worse.
  const pages: WikimediaPage[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  for (const [attemptIndex, q] of attempts.entries()) {
    try {
      const found = await search(q);
      for (const page of found) {
        const key = page.title ?? "";
        if (key && !seen.has(key)) {
          seen.add(key);
          pages.push(page);
        }
      }
      if (pages.length >= 45) break;
    } catch (err) {
      lastError = err;
    }
    // One Openverse pass per scene, on the main query. Its relevance ranking
    // is the best source for real-world subjects Commons cannot AND-match.
    if (attemptIndex === 0) {
      try {
        for (const page of await searchOpenverse(cleaned)) {
          const key = page.title ?? "";
          if (key && !seen.has(key)) {
            seen.add(key);
            pages.push(page);
          }
        }
      } catch {
        // Openverse is an upgrade, not a dependency.
      }
    }
  }
  let candidates: Candidate[] = pages.length
    ? ranked(pages, dims, cleaned, {
        narration: options.narration,
        caption: options.caption,
        era: options.era,
        must,
      })
    : [];
  if (!candidates.length) {
    throw lastError instanceof Error ? lastError : new Error("No suitable archival image found");
  }

  // Optional second opinion: Gemini reads the shortlist titles against the
  // scene's narration and promotes the best match. No key, no extra request.
  if (options.rerank && candidates.length > 1) {
    const shortlist = candidates.slice(0, 6);
    const pick = await geminiPickImage(
      shortlist.map((c) => fileTitle(c.page)),
      `${options.caption ?? ""}. ${options.narration ?? ""}`.trim(),
    );
    if (pick !== null) {
      const chosen = shortlist[pick];
      candidates = [chosen, ...candidates.filter((c) => c !== chosen)];
    }
  }

  // The relevance gate runs before the pick, not after: a wrong photograph that
  // merely shares a generic word ("tower", "night") is worse than a miss.
  if (options.accept) {
    const relevant = candidates.filter((c) => options.accept!(fileTitle(c.page)));
    if (!relevant.length) throw new Error("No relevant archival image found");
    candidates = relevant;
  }

  const fresh = options.used
    ? candidates.filter((c) => !options.used!.has(fileTitle(c.page).toLowerCase()))
    : candidates;
  // Rotate only within the best handful of matches; a wider pool lets a weak
  // tenth-place result (a scan, a stamp) land in the film.
  const pool = (fresh.length ? fresh : candidates).slice(0, 4);
  const start = (options.variant ?? 0) % pool.length;
  const ordered = [...pool.slice(start), ...pool.slice(0, start)];

  const cacheDir = path.join(process.cwd(), "data", "archive-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  let picked: Candidate | undefined;
  let downloadNote = "";

  // Walk the ranked pool until one file actually downloads: a single 429
  // should cost a candidate, not the scene.
  for (const candidate of ordered) {
    const file = fileTitle(candidate.page);
    const cacheKey = createHash("sha1").update(`${candidate.page.origin ?? "commons"}:${file}`).digest("hex");
    const cached = path.join(cacheDir, `${cacheKey}.jpg`);

    if (fs.existsSync(cached)) {
      fs.copyFileSync(cached, outPath);
      picked = candidate;
      break;
    }

    // Commons' Special:Redirect proxies through thumb.wikimedia.org, which is far
    // less rate limited than upload.wikimedia.org for anonymous clients.
    // Openverse files live on Flickr/other hosts, so they are fetched directly.
    const redirectUrl = `https://commons.wikimedia.org/w/index.php?${new URLSearchParams({
      title: `Special:Redirect/file/${file}`,
      width: "1920",
    })}`;
    const urls: string[] = [];
    if (candidate.page.origin === "openverse") {
      urls.push(candidate.url);
      // Openverse often points at the original Commons file, and Wikimedia
      // rate limits anonymous original downloads. Retry through the thumbnail
      // redirect, which serves the same photo.
      const name = decodeURIComponent(candidate.url.split("/").pop() ?? "");
      if (/upload\.wikimedia\.org/.test(candidate.url) && /\.(jpe?g|png|webp)$/i.test(name)) {
        urls.push(
          `https://commons.wikimedia.org/w/index.php?${new URLSearchParams({
            title: `Special:Redirect/file/${name}`,
            width: "1920",
          })}`,
        );
      }
    } else {
      urls.push(redirectUrl, candidate.url);
    }

    let res: Response | undefined;
    for (const url of urls) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await throttle(3000);
        try {
          res = await fetch(url, {
            headers: {
              "User-Agent": UA,
              // Some archive hosts answer 406 to a bare `image/*`; a browser-like
              // list keeps them serving the file.
              Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(90_000),
            redirect: "follow",
          });
        } catch (err) {
          res = undefined;
          downloadNote = err instanceof Error ? err.message : String(err);
          continue;
        }
        if (res.ok) break;
        downloadNote = `HTTP ${res.status}`;
        if (res.status !== 429 && res.status < 500) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(30_000, retryAfter * 1000)
            : 4000 * (attempt + 1),
        );
      }
      if (res?.ok) break;
    }
    if (!res?.ok) {
      if (process.env.ARCHIVE_DEBUG === "1") {
        process.stderr.write(
          `  [archive] download failed ${res?.status ?? "network"} ${file.slice(0, 60)} · ${urls[0].slice(0, 90)}\n`,
        );
      }
      continue;
    }

    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 12_000) continue;

    const raw = outPath.replace(/\.jpe?g$/i, "_raw.jpg");
    fs.writeFileSync(raw, bytes);
    try {
      await run(FFMPEG, [
        "-y",
        "-i",
        raw,
        "-vf",
        "scale='min(2400,iw)':-2",
        "-q:v",
        "2",
        outPath,
      ]);
      fs.copyFileSync(outPath, cached);
      picked = candidate;
      break;
    } catch (err) {
      downloadNote = err instanceof Error ? err.message : String(err);
    } finally {
      fs.rmSync(raw, { force: true });
    }
  }

  if (!picked) throw new Error(`Archive download failed (${downloadNote || "no response"})`);

  const meta = picked.info.extmetadata ?? {};
  const strip = (v?: string) => (v ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return {
    title: strip(picked.page.title).replace(/^File:/, ""),
    license: strip(meta.LicenseShortName?.value) || "Wikimedia Commons",
    artist: strip(meta.Artist?.value),
  };
}
