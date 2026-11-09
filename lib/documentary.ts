import fs from "node:fs";
import path from "node:path";
import { getJob, saveJob } from "./store";
import {
  GENERIC_VISUAL,
  planSmartDocumentary,
  properNouns,
  storyScript,
  fallbackScript,
  type PlannedScript,
} from "./plan";
import { generateImage, generateFreeImage } from "./images";
import { fetchArchiveStill } from "./archives";
import { synthesizeSpeech, synthesizeFreeSpeech } from "./tts";
import { generateAmbience, proceduralAmbience } from "./ambience";
import { generateClip } from "./veo";
import {
  concatVideos,
  dimsFor,
  findFont,
  kenBurnsScene,
  makeEndCard,
  mixAmbience,
  mockAmbience,
  mockImage,
  mockSpeech,
  archivalStill,
  probeDuration,
  sceneMontage,
  wrapText,
  type SceneShot,
  type ShotMotion,
} from "./media";
import { alignWords, cuesFromWords, fallbackCues, splitLongCues, writeAss } from "./subtitles";
import { findNearDuplicate, perceptualHash } from "./phash";
import { runQualityControl } from "./qc";
import { sceneCountFor, wordsPerScene } from "./estimate";
import type { Chapter, Job, Scene, SubtitleCue } from "./types";

const END_SECONDS = 3;
const TAIL_SECONDS = 1.2;
const MIN_SECONDS = 600;
const MAX_SECONDS = 1200;

/** Cutting pattern cycled per scene so consecutive shots never repeat a move. */
const MOTIONS: ShotMotion[] = [
  "pushIn",
  "panRight",
  "handheld",
  "dollyIn",
  "craneUp",
  "pullOut",
  "tiltDown",
  "truckLeft",
  "sway",
  "rackFocus",
  "craneDown",
  "tiltUp",
  "truckRight",
  "dollyOut",
  "panLeft",
];

function shotMotions(index: number, seconds: number): ShotMotion[] {
  // Roughly one new shot every 2.5s. A six-second beat still gets three
  // distinct angles; a long beat never becomes a single slow drift.
  const count = Math.max(3, Math.min(20, Math.round(seconds / 2.5)));
  return Array.from(
    { length: count },
    (_, k) => MOTIONS[(index * 5 + k) % MOTIONS.length],
  );
}

type ImageBudget = {
  mode: NonNullable<Job["input"]["imageMode"]>;
  drawn: number;
  max: number;
  motionDrawn?: number;
  motionMax?: number;
};

function imageBudgetFor(input: Job["input"]): ImageBudget {
  const mode = input.imageMode ?? "key";
  const configured = Number(process.env.FREE_IMAGE_BUDGET);
  const max =
    mode === "archive"
      ? 0
      : mode === "all"
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(configured) && configured > 0
          ? configured
          : 28;
  // Veo bills per second, so AI motion is capped even when it is switched on.
  const motionMax = Number(process.env.AI_MOTION_CLIPS) || 6;
  return { mode, drawn: 0, max, motionDrawn: 0, motionMax };
}

/**
 * The free AI still is slow (one per ~47s), so by default it is spent on key
 * beats — every third scene and each chapter opening — while Commons carries
 * the rest. "Every scene" and "Archive only" are explicit user choices.
 */
function wantsAiStill(job: Job, scene: Scene, budget: ImageBudget): boolean {
  if (budget.mode === "archive" || budget.drawn >= budget.max) return false;
  if (budget.mode === "all") return true;
  const chapterStart = job.chapters[scene.chapter]?.sceneIndexes[0] === scene.index;
  return chapterStart || scene.index % 3 === 0;
}

/**
 * The free pipeline's "video model" options are local recipes, not Veo model
 * ids. Resolve to a real Veo model only when Gemini is the provider.
 */
function veoModelFor(input: Job["input"]): string {
  const local = new Set(["procedural", "kenburns", "archive", ""]);
  if (input.videoModel && !local.has(input.videoModel)) return input.videoModel;
  return process.env.VEO_MODEL || "veo-3.0-fast-generate-001";
}

/** AI motion is charged per second, so only chapter openings get a Veo clip. */
function wantsAiMotion(job: Job, scene: Scene, budget: ImageBudget): boolean {
  if (!job.input.aiMotion || job.input.provider !== "gemini") return false;
  if ((budget.motionDrawn ?? 0) >= (budget.motionMax ?? 6)) return false;
  return job.chapters[scene.chapter]?.sceneIndexes[0] === scene.index;
}

function splitShotDurations(seconds: number, count: number): number[] {
  const step = Math.floor((seconds / count) * 100) / 100;
  const durations = Array.from({ length: count }, () => step);
  durations[count - 1] = Math.max(0.6, seconds - step * (count - 1));
  return durations;
}

/** Historical stories are graded to archival monochrome so mixed sources mesh. */
function archivalMono(era?: string): boolean {
  const years = (era ?? "").match(/\b(1[89]\d{2}|20\d{2})\b/g)?.map(Number) ?? [];
  return years.length > 0 && Math.max(...years) <= 1975;
}

const FIT_STOP = new Set([
  "chapter", "because", "through", "between", "before", "after", "their", "there",
  "these", "those", "which", "while", "where", "would", "could", "should", "about",
  "other", "under", "years", "world", "first", "second", "power", "people", "nation",
  "country", "future", "began", "became", "every", "still", "without", "against",
  "toward", "towards", "during", "around", "later", "once", "never", "again",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function subjectWording(story: string): string {
  const text = story.toLowerCase();
  const female = (text.match(/\b(she|her|hers|woman|women)\b/g) ?? []).length;
  const male = (text.match(/\b(he|his|him|man|men)\b/g) ?? []).length;
  return female > male ? "a woman" : "a man";
}

/**
 * A free AI still is drawn from the scene's own prompt, so it always depicts
 * this scene. Real people's names are replaced with "a man/a woman": Flux can
 * put a recognizable historical figure in a period scene, but its faces drift
 * into uncanny territory, and a wide, face-light frame reads as archive.
 */
const PERSON_ROLE =
  /\b(student|soldier|officer|speaker|painter|artist|worker|guard|prisoner|politician|sailor|pilot|nurse|teacher|peasant|merchant|clerk|man|woman|figure)\b/i;
const GENDERED = /\b(man|woman|boy|girl|male|female|men|women|he|she|his|her)\b/i;
// Real historical names render as uncanny lookalikes in Flux. Replace them with
// an anonymous period person; titled names are genericised the same way.
const FIGURES =
  /\b(hitler|adolf|himmler|heinrich|hindenburg|goebbels|göring|goering|stalin|churchill|roosevelt|mussolini|lenin|trotsky|mao|franco|eisenhower|montgomery|rommel|speer|eichmann|heydrich|bormann|hess|röhm|rohm|streicher|schacht|papen|wilhelm)\b/gi;
const MILITARY = /\b(soldier|officer|sailor|pilot|guard|prisoner|commander|colonel|captain|general|admiral)\b/i;
const TITLED_NAME =
  /\b(?:[Pp]resident|[Cc]hancellor|[Mm]inister|[Gg]eneral|[Aa]dmiral|[Kk]ing|[Qq]ueen|[Pp]rince|[Pp]ope|[Ll]eader|[Dd]ictator|[Ss]enator|[Gg]overnor|[Aa]mbassador|[Cc]ommander|[Cc]olonel|[Cc]aptain|[Kk]aiser)\s+[A-Z][\p{L}'’-]+/gu;

function aiStillPrompt(scene: Scene, input: Job["input"], subject: string): string {
  const person = subjectWording(input.story);
  let text = (scene.imagePrompt || scene.caption || "").trim();
  // A screenwriter that runs out of output room often leaves a truncated line
  // of narration as the image prompt; the caption is a usable visual.
  if (text.length > 110) text = (scene.caption || "").trim() || text.slice(0, 100);
  if (subject) {
    text = text
      .replace(new RegExp(`\\byoung\\s+${escapeRe(subject)}\\b`, "gi"), `a young ${person.slice(2)}`)
      .replace(new RegExp(`\\b${escapeRe(subject)}\\b`, "gi"), person);
    for (const word of subject.split(/\s+/)) {
      if (word.length < 3) continue;
      text = text.replace(new RegExp(`\\b${escapeRe(word)}\\b`, "gi"), "");
    }
  }
  // A protagonist named only by a first name ("Elias eyes…") slips past the
  // subject filter above, so Flux invents a random face. Replace recurring
  // proper names with the story's gendered person; demonyms ("Scottish") are
  // places, not people, and stay. Short hair anchors male faces, which Flux
  // otherwise renders androgynous or female for emotional prompts.
  const named = person === "a man" ? "a man with short hair" : person;
  for (const name of properNouns(input.story)) {
    if (/^[A-Z][a-z]+(?:ish|ese|ian|ic|ern)$/.test(name)) continue;
    const hits = input.story.match(new RegExp(`\\b${escapeRe(name)}\\b`, "g")) ?? [];
    if (hits.length < 2) continue;
    text = text.replace(new RegExp(`\\b${escapeRe(name)}\\b`, "g"), named);
  }
  text = text
    .replace(TITLED_NAME, (m) => `the ${m.split(/\s+/)[0].toLowerCase()}`)
    .replace(FIGURES, person);
  text = text
    .replace(/^\s*close[- ]?up of\b/i, "Detail of")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
  // The screenplay says "art student", "speaker" without a gender; Flux then
  // picks a random face for every scene. Military roles already read as a
  // person, and "young" is enough of an anchor on its own.
  if (PERSON_ROLE.test(text) && !GENDERED.test(text) && !MILITARY.test(text) && !/\byoung\b/i.test(text)) {
    text = `${person.replace(/^a /, "a young ")}, ${text}`;
  }
  // A lone figure makes Flux render a face-on studio portrait. Turning the
  // figure away keeps the scene, kills the uncanny face, and reads as archive.
  const MANY = /\b(men|women|people|soldiers|troops|children|civilians|workers|crowd|crowds)\b/i;
  if (
    PERSON_ROLE.test(text) &&
    !MANY.test(text) &&
    !/\b(behind|back to camera|from the back)\b/i.test(text)
  ) {
    text = `${text.replace(/[.]+$/, "")}, seen from behind`;
  }
  const historical = archivalMono(input.era);
  // Flux follows the first tokens most strongly, so the scene goes first and
  // the archival style trails. A style-first prompt collapses every scene into
  // a blurred portrait or an empty room.
  const style = historical
    ? "Archival black-and-white newsreel photograph, wide shot, figures small in the frame, faces turned away or in shadow, motion blur, heavy 35mm grain, hard available light, no text, no watermark."
    : `Candid documentary photograph, wide shot, figures small in the frame, faces turned away, ${input.style || "natural light"}, 35mm grain, no text, no watermark.`;
  const era = input.era ? ` ${input.era}.` : "";
  const wide = /^(wide|aerial|overhead|panoram|establishing|detail)\b/i.test(text) ? "" : "Wide establishing shot: ";
  return `${wide}${text || scene.caption || scene.narration}.${era} ${style}`;
}

/** True when a Commons filename shares a concrete word or year with the scene. */
function stillFitsScene(title: string, scene: Scene, subjectGeneric: Set<string> = new Set()): boolean {
  const tokens = new Set(title.toLowerCase().match(/[a-zà-ÿ]{3,}/g) ?? []);
  // Whole words only: "light" used to match "lighthouse" and let a corridor
  // photo stand in for a beam over the sea.
  const hit = (word: string) =>
    tokens.has(word) ||
    tokens.has(`${word}s`) ||
    tokens.has(`${word}es`) ||
    (word.endsWith("s") && tokens.has(word.slice(0, -1)));
  const names = properNouns(`${scene.narration} ${scene.caption}`)
    .flatMap((n) => n.toLowerCase().split(/\s+/))
    .filter((w) => w.length >= 4);
  // The scene's own image keywords are evidence too, but only when they are not
  // the film's background vocabulary (see subjectGeneric in prepareSceneAssets).
  const source = `${scene.narration} ${scene.caption}`;
  const queryWords = (scene.imageQuery ?? "").toLowerCase().match(/[a-zà-ÿ]{5,}/g) ?? [];
  const content = [
    ...(source.toLowerCase().match(/[a-zà-ÿ]{5,}/g) ?? []),
    ...queryWords.filter(
      (w) => !subjectGeneric.has(w) && (w.length >= 9 || !/(?:ing|ed|ly)$/u.test(w)),
    ),
  ];
  const concrete = [...new Set(content)].filter((w) => !FIT_STOP.has(w) && !names.includes(w));
  // One specific word is enough. Generic words ("tower", "night") only say the
  // photo is of the same kind of thing: two of them together are how an Eiffel
  // Tower shot ends up in a story about a Scottish lighthouse.
  if (concrete.some((w) => !GENERIC_VISUAL.has(w) && hit(w))) return true;
  const sceneYears: string[] = `${scene.imageQuery ?? ""} ${scene.narration}`.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? [];
  const titleYears: string[] = title.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? [];
  // Sharing only the protagonist's name is not enough: a 1933 speech portrait
  // would otherwise stand in for a 1910 café scene.
  return titleYears.some((y) => sceneYears.includes(y));
}

/** Commons is an AND search: three concrete words find photos, six find nothing. */
function compactQuery(text: string, limit: number): string {
  const tokens = text
    .split(/[\s,.;:!?]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length >= 3 && !/^(1[89]\d{2}|20\d{2})s?$/i.test(w));
  return [...new Set(tokens.map((w) => w.toLowerCase()))].slice(0, limit).join(" ");
}

const pad = (n: number) => String(n).padStart(3, "0");

function log(job: Job, text: string): void {
  job.log.push({ t: Date.now(), text });
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
  saveJob(job);
}

function setStatus(job: Job, status: Job["status"], message: string, progress?: number): void {
  job.status = status;
  job.message = message;
  if (typeof progress === "number") job.progress = progress;
  saveJob(job);
}

/** Trim a scene's narration to the word budget so no single beat runs long. */
function fitNarration(text: string, maxWords: number): string {
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return clean;
  // Prefer ending on a complete sentence rather than a 14-word fragment of a
  // longer analytical line. A first sentence that fills most of the budget is
  // the cleanest cut point.
  const firstStop = clean.search(/[.!?](\s|$)/);
  if (firstStop > 0) {
    const first = clean.slice(0, firstStop + 1);
    const firstWords = first.split(/\s+/).filter(Boolean).length;
    if (firstWords >= maxWords * 0.6 && firstWords <= maxWords * 1.4) return first;
  }
  const slice = words.slice(0, maxWords).join(" ");
  // Cutting mid-clause leaves lines such as "…a storm-battered island off."
  // Break at the last natural clause boundary inside the budget instead.
  const breaks = [...slice.matchAll(/[,;:—]\s+/g)];
  const lastBreak = breaks[breaks.length - 1];
  if (lastBreak && lastBreak.index! >= slice.length * 0.55) {
    return `${slice.slice(0, lastBreak.index).replace(/[,;:—\s]+$/u, "")}.`;
  }
  // No clause boundary: never end on a word that needs the next one.
  const dangling = new Set([
    "a", "an", "the", "and", "but", "or", "nor", "of", "to", "in", "on", "at",
    "by", "for", "from", "into", "onto", "over", "under", "about", "with",
    "that", "which", "who", "whom", "whose", "where", "when", "while", "as",
    "than", "then", "if", "so", "yet", "his", "her", "their", "its", "our",
    "was", "were", "is", "are", "be", "been", "being", "off", "out", "up",
  ]);
  const cut = [...words.slice(0, maxWords)];
  while (cut.length > 5) {
    const tail = cut[cut.length - 1].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    if (!dangling.has(tail)) break;
    cut.pop();
  }
  return `${cut.join(" ").replace(/[.,;:!?—]+$/u, "")}.`;
}

function rebuildScenes(job: Job, script: PlannedScript): void {
  const totalScenes = script.chapters.reduce((n, chapter) => n + chapter.scenes.length, 0);
  // Narration plays from frame 0, so only the end card sits outside scene time.
  // Each scene also carries a short ambient tail after its last word. The word
  // budget scales with the scene: a fixed 30-word floor turned a 60-scene film
  // into 15 minutes of narration that the assembler had to cut.
  const maxWords = wordsPerScene(job.input.durationSeconds, totalScenes);
  const scenes: Scene[] = [];
  const chapters: Chapter[] = [];
  let index = 0;
  script.chapters.forEach((chapter, ci) => {
    const sceneIndexes: number[] = [];
    chapter.scenes.forEach((planned) => {
      scenes.push({
        index,
        chapter: ci,
        chapterTitle: chapter.title,
        narration: fitNarration(planned.narration, maxWords),
        caption: planned.caption,
        imagePrompt: planned.imagePrompt,
        imageQuery: planned.imageQuery,
        status: "queued",
        hero: false,
      });
      sceneIndexes.push(index);
      index++;
    });
    chapters.push({ index: ci, title: chapter.title, sceneIndexes });
  });
  job.scenes = scenes;
  job.chapters = chapters;
}

/**
 * Record the still's perceptual hash and keep repeated compositions apart.
 * When the primary already appeared earlier, the archive alternate is promoted
 * (it is a different photograph of the same beat), otherwise the scene is
 * flagged so the editor can regenerate it.
 */
async function settleVisual(
  job: Job,
  scene: Scene,
  imgPath: string,
  altPath: string,
  hashes: string[],
  redraw?: (attempt: number) => Promise<boolean>,
): Promise<string | undefined> {
  let hash = await perceptualHash(imgPath);
  if (!hash) return hash;
  if (findNearDuplicate(hash, hashes)) {
    const altHash = fs.existsSync(altPath) ? await perceptualHash(altPath) : undefined;
    if (altHash && !findNearDuplicate(altHash, hashes)) {
      const swap = imgPath.replace(/\.jpg$/i, ".swap.jpg");
      fs.copyFileSync(imgPath, swap);
      fs.copyFileSync(altPath, imgPath);
      fs.copyFileSync(swap, altPath);
      fs.rmSync(swap, { force: true });
      scene.imageAltFile = `/generated/${job.id}/scene_${pad(scene.index)}_b.jpg`;
      hash = altHash;
      log(job, `Scene ${scene.index + 1} repeat avoided — alternate framing promoted`);
    }
  }
  // A repeated primary is the one thing the montage cannot hide. Redraw it
  // rather than shipping the duplicate: two fresh frames are cheap next to a
  // film that shows the same photo twice.
  for (let attempt = 1; attempt <= 2 && findNearDuplicate(hash, hashes); attempt++) {
    if (!redraw) break;
    let drew = false;
    try {
      drew = await redraw(attempt);
    } catch {
      drew = false;
    }
    if (!drew) break;
    const fresh = await perceptualHash(imgPath);
    if (fresh && !findNearDuplicate(fresh, hashes)) {
      hash = fresh;
      log(job, `Scene ${scene.index + 1} repeat redrawn — new composition`);
    } else if (fresh) {
      hash = fresh;
    }
  }
  if (findNearDuplicate(hash, hashes)) {
    log(job, `Scene ${scene.index + 1} repeats an earlier composition — flagged in the quality report`);
  }
  scene.imageHash = hash;
  hashes.push(hash);
  return hash;
}

/**
 * Phase one: generate the still and the narration for one scene. Never throws —
 * every failure degrades to a locally generated placeholder so the film ships.
 */
async function prepareSceneAssets(
  job: Job,
  scene: Scene,
  outDir: string,
  dims: { w: number; h: number },
  apiKey: string,
  provider: "free" | "gemini",
  usedTitles: Set<string>,
  smart: boolean,
  budget: ImageBudget,
  hashes: string[],
  variation = 0,
  forceDraw = false,
): Promise<void> {
  const input = job.input;
  const i = scene.index;
  const imgPath = path.join(outDir, `scene_${pad(i)}.jpg`);
  const altPath = path.join(outDir, `scene_${pad(i)}_b.jpg`);
  const wavPath = path.join(outDir, `scene_${pad(i)}.wav`);
  const words = scene.narration.split(/\s+/).filter(Boolean).length;
  const mockSeconds = Math.min(38, Math.max(14, words / 2.4));

  const errors: string[] = [];
  scene.status = "image";
  saveJob(job);

  // Words every scene asks for ("lighthouse" in a lighthouse story) cannot prove
  // a photo shows the right thing: they accept any tower, interior or sketch.
  const queryCounts = new Map<string, number>();
  for (const other of job.scenes) {
    for (const word of new Set((other.imageQuery ?? "").toLowerCase().match(/[a-zà-ÿ]{5,}/g) ?? [])) {
      queryCounts.set(word, (queryCounts.get(word) ?? 0) + 1);
    }
  }
  const subjectGeneric = new Set(
    [...queryCounts]
      .filter(([, count]) => count >= Math.max(3, job.scenes.length * 0.2))
      .map(([word]) => word),
  );

  const imageTask = (async () => {
    if (job.mock) return mockImage(imgPath, dims, i);
    if (provider === "free") {
      // A generic role word ("chancellor inauguration") matches the wrong
      // country's modern photos. Scene names disambiguate the search; when the
      // narration only says "he", fall back to the film's subject name.
      const months = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;
      // A full name or place-like phrase is safe to keep in a drawn-still
      // prompt; a lone first name is not used for archive searches.
      const usableName = (n: string) => !months.test(n) && n.includes(" ") && n.length >= 5;
      const bare = (n: string) => n.replace(/['’]s$/i, "").trim();
      const subject = properNouns(input.story).map(bare).filter(usableName).slice(0, 1);
      // The AI writes 5-6 rich keywords ("Elias lighthouse Scottish coast
      // stormy 1970s"), which return nothing on an AND search. Three words is
      // the shape Commons answers; years stay out because filenames rarely
      // carry them, and a leading proper name ("Elias") matches book scans and
      // the wrong Cape St. Elias, so it is dropped before searching.
      const rawQuery = scene.imageQuery || scene.caption || input.story.slice(0, 90);
      const tokens = rawQuery.split(/\s+/).filter(Boolean);
      const dropLeading =
        tokens.length > 2 &&
        /^[A-Z][\p{L}'’-]+$/u.test(tokens[0]) &&
        !/^(The|A|An)$/i.test(tokens[0]);
      const cleaned = (dropLeading ? tokens.slice(1) : tokens).join(" ");
      const query = compactQuery(cleaned, 3) || compactQuery(rawQuery, 3) || rawQuery;
      const looseQuery = compactQuery(cleaned, 2) || compactQuery(rawQuery, 2) || query;
      let primary = false;
      let missReason = "";
      let archivalTitle = "";
      let altTitle = "";
      const accept = (title: string) => stillFitsScene(title, scene, subjectGeneric);
      if (!forceDraw) {
        try {
          const still = await fetchArchiveStill(query, dims, imgPath, {
            variant: 0,
            used: usedTitles,
            narration: scene.narration,
            caption: scene.caption,
            era: input.era,
            rerank: smart && Boolean(apiKey),
            accept,
          });
          usedTitles.add(still.title.toLowerCase());
          archivalTitle = still.title;
          primary = true;
          log(
            job,
            `Scene ${i + 1} still: ${still.title.slice(0, 70)}${still.license ? ` · ${still.license}` : ""}`,
          );
        } catch (err) {
          missReason = err instanceof Error ? err.message : String(err);
        }

        // Even when the first pick 429s, a second still can save the scene. A
        // failed primary also gets one looser two-word query before the scene
        // falls back to a drawing.
        try {
          const alt = await fetchArchiveStill(primary ? query : looseQuery, dims, altPath, {
            variant: 1,
            used: usedTitles,
            narration: scene.narration,
            caption: scene.caption,
            era: input.era,
            rerank: smart && Boolean(apiKey),
            accept,
          });
          usedTitles.add(alt.title.toLowerCase());
          altTitle = alt.title;
          if (primary) {
            scene.imageAltFile = `/generated/${job.id}/scene_${pad(i)}_b.jpg`;
          } else {
            fs.copyFileSync(altPath, imgPath);
            archivalTitle = alt.title;
            primary = true;
            log(
              job,
              `Scene ${i + 1} primary miss (${missReason.slice(0, 80)}) — using second archive still`,
            );
          }
        } catch {
          // A single still is enough for the montage; shot moves still vary.
        }

        // Drop an archival alternate that has no word or year in common with the
        // scene: a random Commons hit is worse than a second crop.
        if (altTitle && !stillFitsScene(altTitle, scene, subjectGeneric)) {
          fs.rmSync(altPath, { force: true });
          scene.imageAltFile = undefined;
        }
        if (!fs.existsSync(altPath) && archivalTitle && stillFitsScene(archivalTitle, scene, subjectGeneric)) {
          fs.copyFileSync(imgPath, altPath);
          scene.imageAltFile = `/generated/${job.id}/scene_${pad(i)}_b.jpg`;
        }
      }

      // Free AI draws the primary frame from the scene's own prompt. The
      // screenplay is story-aware, so this is the still that actually matches
      // the narration; Commons remains the period-texture alternate. The pass
      // is slow (one image per ~47s), so the budget decides which beats get it.
      // A scene with no relevant archival photo gets one regardless of rotation:
      // a drawn still beats both a tourist snapshot and a dark plate.
      const canDraw =
        forceDraw ||
        (process.env.FREE_SCENE_IMAGES !== "0" &&
          budget.mode !== "archive" &&
          budget.drawn < (primary ? budget.max : budget.max + 6));
      if (canDraw && (!primary || wantsAiStill(job, scene, budget))) {
        try {
          const prompt = aiStillPrompt(scene, input, subject.join(" "));
          await generateFreeImage(prompt, dims, imgPath, 7919 * (i + 1) + 13 + variation);
          budget.drawn++;
          primary = true;
          log(job, `Scene ${i + 1} still drawn from the scene`);
          if (forceDraw) log(job, `Scene ${i + 1} draw prompt: ${prompt.slice(0, 180)}`);
        } catch (err) {
          log(job, `Scene ${i + 1} AI still skipped (${(err as Error).message.slice(0, 80)})`);
        }
      }

      if (!primary) {
        const hero = path.join(outDir, "hero.jpg");
        if (fs.existsSync(hero)) {
          fs.copyFileSync(hero, imgPath);
          log(job, `Scene ${i + 1} archive unavailable (${missReason.slice(0, 80)}) — opening still reused`);
        } else {
          log(job, `Scene ${i + 1} archive miss (${missReason.slice(0, 90)}) — lit plate`);
          await archivalStill(imgPath, dims, i);
        }
      }
      await settleVisual(job, scene, imgPath, altPath, hashes, async (attempt) => {
        if (
          process.env.FREE_SCENE_IMAGES === "0" ||
          budget.mode === "archive" ||
          budget.drawn >= budget.max
        ) {
          return false;
        }
        const variation = attempt === 1 ? "different camera angle, fresh composition" : "wide establishing view, new framing";
        const prompt = `${aiStillPrompt(scene, input, subject.join(" "))}, ${variation}`;
        await generateFreeImage(prompt, dims, imgPath, 104729 * (i + 3) + attempt);
        budget.drawn++;
        return true;
      });
      return;
    }
    await generateImage(apiKey, input.imageModel, scene.imagePrompt, input.aspectRatio, imgPath);
    await settleVisual(job, scene, imgPath, altPath, hashes, async (attempt) => {
      const variation = attempt === 1 ? "different camera angle, fresh composition" : "wide establishing view, new framing";
      await generateImage(
        apiKey,
        input.imageModel,
        `${scene.imagePrompt}. ${variation}.`,
        input.aspectRatio,
        imgPath,
      );
      return true;
    });
    if (wantsAiMotion(job, scene, budget)) {
      const clipPath = path.join(outDir, `scene_${pad(i)}_motion.mp4`);
      try {
        budget.motionDrawn = (budget.motionDrawn ?? 0) + 1;
        await generateClip(
          apiKey,
          {
            model: veoModelFor(input),
            prompt: `${scene.imagePrompt}. Slow, steady cinematic camera move with natural parallax. No text, no cuts, no lip movement.`,
            aspectRatio: input.aspectRatio,
            resolution: input.resolution,
            audio: false,
            startImage: {
              imageBytes: fs.readFileSync(imgPath).toString("base64"),
              mimeType: "image/jpeg",
            },
          },
          clipPath,
          (m) => log(job, `Scene ${i + 1} motion: ${m.slice(0, 110)}`),
        );
        scene.motionFile = `/generated/${job.id}/scene_${pad(i)}_motion.mp4`;
        log(job, `Scene ${i + 1} animated with Veo`);
      } catch (err) {
        log(job, `Scene ${i + 1} Veo motion skipped (${(err as Error).message.slice(0, 90)})`);
      }
    }
  })();

  const audioTask = (async () => {
    if (job.mock) return mockSpeech(wavPath, mockSeconds);
    if (provider === "free") {
      const speech = await synthesizeFreeSpeech(
        scene.narration,
        input.voice,
        input.language,
        wavPath,
        outDir,
      );
      // Captions come from the voice itself. The helper reports word
      // boundaries, so cue breaks land on real pauses instead of guesses.
      if (speech.words?.length) {
        scene.subtitleCues = cuesFromWords(alignWords(speech.words, scene.narration), {
          maxChars: 50,
        });
      } else if (speech.cues?.length) {
        scene.subtitleCues = splitLongCues(speech.cues, 50);
      }
      return;
    }
    await synthesizeSpeech(apiKey, input.ttsModel, scene.narration, input.voice, wavPath);
  })();

  await Promise.all([
    imageTask.catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`still: ${message}`);
      log(job, `Scene ${i + 1} still failed (${message.slice(0, 140)}) — using placeholder`);
      await mockImage(imgPath, dims, i);
    }),
    audioTask.catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`voice: ${message}`);
      log(job, `Scene ${i + 1} narration failed (${message.slice(0, 140)}) — using silence`);
      await mockSpeech(wavPath, mockSeconds);
    }),
  ]);

  scene.imageFile = `/generated/${job.id}/scene_${pad(i)}.jpg`;
  scene.audioFile = `/generated/${job.id}/scene_${pad(i)}.wav`;
  scene.status = "narration";
  if (errors.length) scene.error = errors.join(" · ").slice(0, 220);
  saveJob(job);
}

/** Phase two: cut the prepared stills and narration into a run of short moving shots. */
async function renderSceneVideo(
  job: Job,
  scene: Scene,
  outDir: string,
  dims: { w: number; h: number },
  fontsAvailable: boolean,
  tailSeconds = TAIL_SECONDS,
): Promise<string | undefined> {
  const input = job.input;
  const i = scene.index;
  const imgPath = path.join(outDir, `scene_${pad(i)}.jpg`);
  const altPath = path.join(outDir, `scene_${pad(i)}_b.jpg`);
  const wavPath = path.join(outDir, `scene_${pad(i)}.wav`);
  const vidPath = path.join(outDir, `scene_${pad(i)}.mp4`);

  try {
    if (!fs.existsSync(imgPath) || !fs.existsSync(wavPath)) throw new Error("scene assets missing");

    const narrationSeconds = await probeDuration(wavPath);
    // A short ambient tail after each narration gives the edit room to breathe
    // and lands the run time on target without a long end card.
    const tail = job.mock ? 0.7 : tailSeconds;
    const seconds = Math.min(60, Math.max(3, narrationSeconds || 18)) + tail;
    scene.durationSeconds = seconds;
    scene.status = "video";
    saveJob(job);

    // Subtitles are cut from the narration's own word timings. A scene that
    // fell back to SAPI (no timings) still gets sentence cues, never nothing.
    const speechSeconds = Math.max(1, narrationSeconds || Math.min(seconds - tail, 20));
    const cues = scene.subtitleCues?.length
      ? scene.subtitleCues
      : fallbackCues(scene.narration, speechSeconds);
    // Persist whichever cues are burned so the report can prove subtitle
    // coverage and the editor can show the real timing.
    scene.subtitleCues = cues;
    let assFile: string | undefined;
    if (input.captions && fontsAvailable && cues.length) {
      const assName = `scene_${pad(i)}.ass`;
      writeAss({ cues, outPath: path.join(outDir, assName), dims });
      assFile = assName;
    }

    let titleFile: string | undefined;
    let subtitleFile: string | undefined;
    let chapterFile: string | undefined;
    if (fontsAvailable) {
      if (i === 0) {
        titleFile = "open_title.txt";
        subtitleFile = "open_subtitle.txt";
        fs.writeFileSync(
          path.join(outDir, titleFile),
          wrapText(job.title.slice(0, 120), Math.max(14, Math.round(dims.w / 45))) + "\n",
        );
        fs.writeFileSync(
          path.join(outDir, subtitleFile),
          wrapText((job.tagline || job.logline).slice(0, 220), Math.max(24, Math.round(dims.w * 0.068))) +
            "\n",
        );
      } else if (job.chapters[scene.chapter]?.sceneIndexes[0] === i) {
        chapterFile = `scene_${pad(i)}.chapter.txt`;
        const label = scene.chapterTitle
          .replace(/^chapter\s+\d+\s*[:.\-–—]\s*/i, "")
          .toUpperCase();
        fs.writeFileSync(
          path.join(outDir, chapterFile),
          `PART ${scene.chapter + 1} · ${label}\n`,
        );
      }
    }

    // Two or three photographs per beat, cut into a new angle every ~2.5s.
    // The framing and move change per shot, so a recurring source never reads
    // as the same still held; with an alternate it becomes a real cut.
    const sources: string[] = [];
    const heroImg = path.join(outDir, "hero.jpg");
    if (i === 0 && fs.existsSync(heroImg)) sources.push(heroImg);
    sources.push(imgPath);
    if (fs.existsSync(altPath)) sources.push(altPath);

    const motions = shotMotions(i, seconds);
    const motionPath = path.join(outDir, `scene_${pad(i)}_motion.mp4`);
    const hasMotion = fs.existsSync(motionPath);
    const shots: SceneShot[] = motions.map((_, k) =>
      k === 0 && hasMotion
        ? { type: "video", src: motionPath }
        : {
            type: "image",
            src: sources[(k + (hasMotion ? 1 : 0)) % sources.length],
          },
    );
    const chapterStart = i === 0 || job.chapters[scene.chapter]?.sceneIndexes[0] === i;
    const lastScene = i === job.scenes.length - 1;
    try {
      await sceneMontage({
        shots,
        motions,
        shotDurations: splitShotDurations(seconds, motions.length),
        audio: wavPath,
        outPath: vidPath,
        duration: seconds,
        dims,
        cwd: outDir,
        subtitleFile: assFile,
        titleFile,
        chapterFile,
        mono: archivalMono(input.era),
        fadeIn: chapterStart ? 0.35 : undefined,
        fadeOut: lastScene ? 0.6 : undefined,
      });
      scene.shotCount = shots.length;
    } catch (err) {
      // Keep the narration intact: retry the scene as one slow push.
      log(job, `Scene ${i + 1} montage retry (${(err as Error).message.slice(0, 90)})`);
      await kenBurnsScene({
        image: imgPath,
        audio: wavPath,
        outPath: vidPath,
        duration: seconds,
        dims,
        cwd: outDir,
        subtitleFile: assFile,
        mono: archivalMono(input.era),
      });
      scene.shotCount = 1;
    }

    scene.videoFile = `/generated/${job.id}/scene_${pad(i)}.mp4`;
    scene.status = "done";
    scene.finishedAt = Date.now();
    saveJob(job);
    return vidPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(job, `Scene ${i + 1} cut failed: ${message.slice(0, 160)}`);
    // Last resort: placeholder still + silence so the film completes.
    try {
      await mockImage(imgPath, dims, i);
      await mockSpeech(wavPath, 18);
      await kenBurnsScene({
        image: imgPath,
        audio: wavPath,
        outPath: vidPath,
        duration: 18.7,
        dims,
        cwd: outDir,
      });
      scene.durationSeconds = 18.7;
      scene.imageFile = `/generated/${job.id}/scene_${pad(i)}.jpg`;
      scene.videoFile = `/generated/${job.id}/scene_${pad(i)}.mp4`;
      scene.status = "done";
      scene.error = [scene.error, message.slice(0, 160)].filter(Boolean).join(" · ");
      scene.finishedAt = Date.now();
      saveJob(job);
      return vidPath;
    } catch (fallbackErr) {
      scene.status = "error";
      scene.error = (fallbackErr as Error).message.slice(0, 200);
      saveJob(job);
      log(job, `Scene ${i + 1} failed and fallback failed`);
      return undefined;
    }
  }
}

/** One render per job at a time: a re-cut must never race the assembler. */
const activeJobs = new Set<string>();

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Cut the scene clips into the finished film: score, end card, concat, ducked
 * mix, loudness normalisation and the quality report. Used by the full render
 * and by single-scene regeneration, so both paths deliver the same file.
 */
async function assembleFilm(
  job: Job,
  outDir: string,
  dims: { w: number; h: number },
  provider: "free" | "gemini",
  apiKey: string,
): Promise<void> {
  const input = job.input;
  const missing = job.scenes.filter(
    (s) => !fs.existsSync(path.join(outDir, `scene_${pad(s.index)}.mp4`)),
  );
  if (missing.length) {
    throw new Error(
      `Missing ${missing.length} scene cut(s): ${missing.slice(0, 5).map((s) => s.index + 1).join(", ")}`,
    );
  }

  setStatus(job, "assembling", "Scoring the film", 88);

  const music = input.music ?? "drone";
  let ambiencePath: string | undefined;
  if (input.ambient && music !== "none") {
    const bed = path.join(outDir, "ambience.wav");
    if (job.mock) {
      ambiencePath = bed;
      if (!fs.existsSync(bed)) await mockAmbience(bed, 30);
    } else if (provider === "free") {
      ambiencePath = bed;
      await proceduralAmbience(bed, 90, music);
    } else {
      ambiencePath = await generateAmbience(apiKey, veoModelFor(input), input.story, outDir, (m) =>
        log(job, m),
      );
    }
  }

  // The film opens on scene one, so the only standalone card is the outro.
  const plannedScenes = job.scenes.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  const target = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, input.durationSeconds));
  // The outro absorbs a shortfall (up to 30s of credits), but narration is never
  // trimmed to hit the target: cutting the tail would delete the conclusion.
  const endSeconds =
    plannedScenes >= target
      ? END_SECONDS
      : Math.min(END_SECONDS + 27, target - plannedScenes);
  const planned = plannedScenes + endSeconds;
  if (planned < target - 1) {
    log(
      job,
      `Narration ran short by ${Math.round(target - planned)}s — delivering ${Math.round(planned)}s`,
    );
  }
  if (planned > target + 1) {
    log(
      job,
      `Narration runs ${Math.round(planned - target)}s over the ${Math.round(target)}s target — keeping the full ending`,
    );
  }
  const endPath = path.join(outDir, "end.mp4");
  await makeEndCard({
    outPath: endPath,
    dims,
    seconds: endSeconds,
    cwd: outDir,
    title: job.title,
    subtitle: job.tagline || job.logline,
    credit:
      "Archival photography: Wikimedia Commons (public domain / CC) · " +
      `Narration: ${input.voice} · Score: ${input.ambient && music !== "none" ? music : "room tone"} · ` +
      "Made with free tools",
    backdrop: fs.existsSync(path.join(outDir, `scene_${pad(job.scenes.length - 1)}.jpg`))
      ? path.join(outDir, `scene_${pad(job.scenes.length - 1)}.jpg`)
      : path.join(outDir, "hero.jpg"),
  });

  job.progress = 92;
  saveJob(job);

  setStatus(job, "assembling", "Stitching the film", 93);
  const stitched = path.join(outDir, "stitched.mp4");
  await concatVideos(
    [...job.scenes.map((s) => path.join(outDir, `scene_${pad(s.index)}.mp4`)), endPath],
    stitched,
    outDir,
  );

  const finalSeconds = planned;
  setStatus(job, "mixing", "Mixing narration and sound", 97);
  const mixed = path.join(outDir, "mixed.mp4");
  await mixAmbience({
    video: stitched,
    ambience: ambiencePath,
    outPath: mixed,
    seconds: finalSeconds,
    volume: music === "pulse" ? 0.32 : 0.4,
  });

  const finalPath = path.join(outDir, "final.mp4");
  fs.copyFileSync(mixed, finalPath);

  const actual = await probeDuration(finalPath);
  job.actualDurationSeconds = Math.round(actual);
  job.finalUrl = `/generated/${job.id}/final.mp4`;

  setStatus(job, "mixing", "Checking the finished cut", 99);
  try {
    job.quality = await runQualityControl(job, finalPath, dims);
    const failed = job.quality.checks.filter((c) => c.status === "fail");
    const warned = job.quality.checks.filter((c) => c.status === "warn");
    log(
      job,
      `QC: ${job.quality.passed ? "passed" : "needs attention"} · ${failed.length} fail · ${warned.length} warn`,
    );
    for (const check of failed) log(job, `QC fail — ${check.label}: ${check.detail}`);
  } catch (err) {
    log(job, `QC skipped (${(err as Error).message.slice(0, 120)})`);
  }

  job.progress = 100;
  const grade = job.quality && !job.quality.passed ? " · QC flagged" : "";
  setStatus(
    job,
    "done",
    `Ready · ${Math.floor(actual / 60)}m ${Math.round(actual % 60)}s${grade}`,
  );
  log(job, `Done: ${Math.floor(actual / 60)}m ${Math.round(actual % 60)}s → /generated/${job.id}/final.mp4`);
}

export async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  if (activeJobs.has(job.id)) return;
  activeJobs.add(job.id);

  const input = job.input;
  const provider = input.provider === "gemini" ? "gemini" : "free";
  const outDir = path.join(process.cwd(), "public", "generated", job.id);
  fs.mkdirSync(outDir, { recursive: true });
  const dims = dimsFor(input.aspectRatio, input.resolution);
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const fontsAvailable = Boolean(findFont());
  const label = job.mock
    ? "mock"
    : provider === "free"
      ? apiKey
        ? "free · Gemini director keyed"
        : "free · no key"
      : "gemini";

  try {
    setStatus(job, "planning", "Writing the documentary script", 2);
    log(job, `Job ${job.id} · ${label} · target ${Math.round(input.durationSeconds / 60)} min`);

    const sceneCount = job.scenes.length || sceneCountFor(input.durationSeconds, input.sceneSeconds);
    const smart = input.smart !== false;
    let script: PlannedScript;
    if (job.mock) {
      script = fallbackScript(input, sceneCount);
    } else if (smart) {
      const planned = await planSmartDocumentary(input, sceneCount, apiKey, (m) => log(job, m));
      script = planned.script;
      log(
        job,
        `Director brain: ${
          planned.brain === "gemini"
            ? "Gemini"
            : planned.brain === "free-ai"
              ? "free AI (no key needed)"
              : "built-in fallback"
        }`,
      );
    } else {
      script = storyScript(input, sceneCount);
      log(job, "Director brain: built-in director (smart direction off)");
    }
    job.title = script.title;
    job.logline = script.logline;
    job.tagline = script.tagline;
    rebuildScenes(job, script);
    saveJob(job);
    log(job, `Script ready: "${script.title}" · ${job.scenes.length} scenes in ${script.chapters.length} chapters`);

    // Opening still: the literal first frame of the film, under the first line
    // of narration. No silent intro clip, so the voice starts at t=0.
    if (input.heroShots) {
      const heroPrompt =
        `Cinematic opening shot for a ${input.genre.toLowerCase()} documentary about ${input.story}. ` +
        `${input.style}, ${input.era}. Slow, atmospheric, filmic, no text.`;
      const heroImg = path.join(outDir, "hero.jpg");
      try {
        if (job.mock) await mockImage(heroImg, dims, 97);
        else if (provider === "free") await generateFreeImage(heroPrompt, dims, heroImg, 4242);
        else await generateImage(apiKey, input.imageModel, heroPrompt, input.aspectRatio, heroImg);
        log(job, "Opening still ready — narration starts on frame one");
      } catch (err) {
        log(job, `Opening still skipped (${(err as Error).message.slice(0, 90)}) — using archive`);
        try {
          await fetchArchiveStill(
            `${input.title || input.story.slice(0, 80)} ${input.era}`,
            dims,
            heroImg,
          );
        } catch {
          await archivalStill(heroImg, dims, 97);
        }
      }
    }

    const total = job.scenes.length;
    const budget = imageBudgetFor(input);
    const hashes: string[] = [];

    // Phase one runs ahead of the edit: stills + narration, a few scenes at a time.
    const concurrency = Math.max(1, Math.min(4, Number(process.env.FREE_CONCURRENCY) || 3));
    const usedTitles = new Set<string>();
    let prepared = 0;
    let cursor = 0;
    const prepWorker = async () => {
      while (true) {
        const n = cursor++;
        if (n >= total) return;
        const scene = job.scenes[n];
        const task = prepareSceneAssets(
          job,
          scene,
          outDir,
          dims,
          apiKey,
          provider,
          usedTitles,
          smart,
          budget,
          hashes,
        )
          .finally(() => {
            prepared++;
            job.progress = Math.max(job.progress, Math.round(4 + (prepared / total) * 38));
            job.status = "images";
            job.message = `Stills + narration ${prepared}/${total}`;
            saveJob(job);
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log(job, `Scene ${n + 1} prep failed (${message.slice(0, 140)})`);
          });
        await task;
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => prepWorker());

    // Phase two: once every still and voice track exists, size the per-scene
    // ambient tail so the finished edit lands on the requested run time without
    // cutting into the last narration line.
    await Promise.all(workers);

    const narrationSeconds = await Promise.all(
      job.scenes.map((s) => probeDuration(path.join(outDir, `scene_${pad(s.index)}.wav`))),
    );
    const narrationTotal = narrationSeconds.reduce((sum, n) => sum + n, 0);
    const targetForTail = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, input.durationSeconds));
    const tailSpace = targetForTail - END_SECONDS - narrationTotal;
    const tailSeconds = Math.max(1, Math.min(8, tailSpace / Math.max(1, total)));
    log(
      job,
      `Voice total ${Math.round(narrationTotal)}s · ${tailSeconds.toFixed(1)}s tail per scene`,
    );

    for (let n = 0; n < total; n++) {
      const scene = job.scenes[n];
      job.status = "assembling";
      job.message = `Editing scene ${n + 1}/${total} · ${scene.chapterTitle}`;
      saveJob(job);
      log(job, `Scene ${n + 1}/${total}: ${scene.chapterTitle}`);
      await renderSceneVideo(job, scene, outDir, dims, fontsAvailable, tailSeconds);
      job.progress = Math.max(job.progress, Math.round(42 + ((n + 1) / total) * 45));
      saveJob(job);
      if (scene.durationSeconds) log(job, `Scene ${n + 1} cut (${scene.durationSeconds.toFixed(0)}s)`);
    }

    job.narrationSeconds = Math.round(narrationTotal);
    job.tailSeconds = tailSeconds;
    saveJob(job);

    await assembleFilm(job, outDir, dims, provider, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    job.status = "error";
    job.message = "Failed";
    saveJob(job);
    log(job, `ERROR: ${message}`);
  } finally {
    activeJobs.delete(job.id);
  }
}

/**
 * Re-cut one scene and re-assemble the film. Edits are applied to the job
 * before anything is deleted, so a failed re-cut keeps the old take until the
 * new one is written.
 */
export async function regenerateScene(
  jobId: string,
  index: number,
  edits: {
    narration?: string;
    caption?: string;
    imagePrompt?: string;
    imageQuery?: string;
    forceDraw?: boolean;
  } = {},
  options: { assemble?: boolean } = {},
): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  if (activeJobs.has(job.id)) throw new Error("This film is still rendering");
  const scene = job.scenes.find((s) => s.index === index);
  if (!scene) throw new Error("Scene not found");

  activeJobs.add(job.id);
  const provider = job.input.provider === "gemini" ? "gemini" : "free";
  const outDir = path.join(process.cwd(), "public", "generated", job.id);
  const dims = dimsFor(job.input.aspectRatio, job.input.resolution);
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const fontsAvailable = Boolean(findFont());

  try {
    if (typeof edits.narration === "string" && edits.narration.trim()) {
      scene.narration = fitNarration(edits.narration, 150);
    }
    if (typeof edits.caption === "string" && edits.caption.trim()) scene.caption = edits.caption.trim();
    if (typeof edits.imagePrompt === "string" && edits.imagePrompt.trim()) {
      scene.imagePrompt = edits.imagePrompt.trim();
    }
    if (typeof edits.imageQuery === "string") scene.imageQuery = edits.imageQuery.trim();
    scene.subtitleCues = undefined;
    scene.error = undefined;
    scene.imageHash = undefined;
    scene.motionFile = undefined;
    scene.status = "queued";
    job.quality = undefined;
    job.error = undefined;
    setStatus(job, "images", `Re-cutting scene ${index + 1}`, 10);
    log(job, `Re-cut scene ${index + 1}: ${scene.chapterTitle}`);
    saveJob(job);

    // The old still and voice are removed only once the edit is persisted.
    for (const file of [
      `scene_${pad(index)}.jpg`,
      `scene_${pad(index)}_b.jpg`,
      `scene_${pad(index)}.wav`,
      `scene_${pad(index)}.mp4`,
      `scene_${pad(index)}_motion.mp4`,
      `scene_${pad(index)}.ass`,
    ]) {
      fs.rmSync(path.join(outDir, file), { force: true });
    }

    const usedTitles = new Set(
      job.scenes
        .filter((s) => s.index !== index && s.imageQuery)
        .map((s) => s.imageQuery!.toLowerCase()),
    );
    const hashes: string[] = job.scenes
      .filter((s) => s.index !== index && s.imageHash)
      .map((s) => s.imageHash!);
    const budget = imageBudgetFor(job.input);
    budget.max = Math.max(1, budget.max);

    await prepareSceneAssets(
      job,
      scene,
      outDir,
      dims,
      apiKey,
      provider,
      usedTitles,
      job.input.smart !== false,
      budget,
      hashes,
      // A re-cut must produce a new drawing, not the same seeded frame again.
      Date.now() % 1000003,
      edits.forceDraw === true,
    );

    let tail = job.tailSeconds;
    if (!tail) {
      const seconds = await Promise.all(
        job.scenes.map((s) => probeDuration(path.join(outDir, `scene_${pad(s.index)}.wav`))),
      );
      const totalNarration = seconds.reduce((sum, n) => sum + n, 0);
      const target = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, job.input.durationSeconds));
      tail = Math.max(
        1,
        Math.min(8, (target - END_SECONDS - totalNarration) / Math.max(1, job.scenes.length)),
      );
      job.tailSeconds = tail;
    }

    await renderSceneVideo(job, scene, outDir, dims, fontsAvailable, tail);
    if (options.assemble === false) {
      scene.status = "done";
      setStatus(job, "images", `Scene ${index + 1} re-cut`, 30);
      saveJob(job);
    } else {
      await assembleFilm(job, outDir, dims, provider, apiKey);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    job.status = "error";
    job.message = "Re-cut failed";
    saveJob(job);
    log(job, `Re-cut failed: ${message}`);
    throw err;
  } finally {
    activeJobs.delete(job.id);
  }
}

/**
 * Re-cut several scenes in one pass and assemble the film once, so a batch of
 * image fixes does not pay the full montage cost for every scene.
 */
export async function regenerateScenes(
  jobId: string,
  edits: Array<{
    index: number;
    narration?: string;
    caption?: string;
    imagePrompt?: string;
    imageQuery?: string;
    forceDraw?: boolean;
  }>,
): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  if (activeJobs.has(job.id)) throw new Error("This film is still rendering");
  if (!edits.length) throw new Error("No scenes to re-cut");

  for (const edit of edits) {
    await regenerateScene(jobId, edit.index, edit, { assemble: false });
  }

  const current = getJob(jobId);
  if (!current) throw new Error("Job not found");
  activeJobs.add(current.id);
  const provider = current.input.provider === "gemini" ? "gemini" : "free";
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  const outDir = path.join(process.cwd(), "public", "generated", current.id);
  const dims = dimsFor(current.input.aspectRatio, current.input.resolution);
  try {
    setStatus(current, "assembling", `Re-assembling after ${edits.length} scene re-cuts`, 88);
    log(current, `Re-assembled after ${edits.length} scene re-cuts`);
    saveJob(current);
    await assembleFilm(current, outDir, dims, provider, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    current.error = message;
    current.status = "error";
    current.message = "Batch re-cut failed";
    saveJob(current);
    log(current, `Batch re-cut failed: ${message}`);
    throw err;
  } finally {
    activeJobs.delete(current.id);
  }
}
