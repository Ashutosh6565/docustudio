import { GoogleGenAI } from "@google/genai";
import type { DocumentaryInput } from "./types";
import { wordsPerScene } from "./estimate";

export interface PlannedScene {
  narration: string;
  caption: string;
  imagePrompt: string;
  imageQuery?: string;
}
export interface PlannedChapter {
  title: string;
  scenes: PlannedScene[];
}
export interface PlannedScript {
  title: string;
  logline: string;
  tagline: string;
  chapters: PlannedChapter[];
}

function extractText(res: unknown): string {
  const anyRes = res as {
    text?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (typeof anyRes.text === "string" && anyRes.text.trim()) return anyRes.text;
  const parts = anyRes.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

function slugTitle(input: DocumentaryInput): string {
  if (input.title?.trim()) return input.title.trim();
  const words = input.story.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.replace(/[.,;:!?]+$/, "") || "Untitled Documentary";
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "of", "in", "on", "at", "to", "for", "from", "with", "by", "as", "into", "over", "after",
  "before", "during", "between", "under", "about", "against", "through", "across", "is", "was",
  "were", "are", "be", "been", "being", "he", "she", "it", "they", "we", "you", "his", "her",
  "their", "our", "its", "had", "has", "have", "not", "no", "so", "yet", "when", "while", "who",
  "whom", "whose", "which", "what", "where", "why", "how", "would", "could", "should", "would",
  "may", "might", "must", "can", "will", "one", "two", "also", "more", "most", "some", "any",
  "within", "without", "upon", "since", "until", "despite", "although", "though", "however",
  "meanwhile", "later", "afterwards", "soon", "still", "even", "only", "just",
]);

const TITLE_WORDS = new Set([
  "president", "chancellor", "minister", "general", "colonel", "captain", "sir", "mr", "mrs",
  "ms", "dr", "king", "queen", "prince", "princess", "pope", "saint", "professor", "lord",
]);

// Words that appear in hundreds of thousands of Commons files. Searching with
// them returns the first modern tourist photo of any tower, anywhere.
export const GENERIC_VISUAL = new Set([
  "tower", "light", "night", "day", "time", "city", "house", "building", "street",
  "water", "river", "road", "view", "scene", "world", "people", "person", "man",
  "woman", "men", "women", "work", "life", "story", "history", "year", "years",
  "power", "state", "war", "place", "part", "thing", "case", "point", "side",
  "line", "area", "level", "group", "number", "name", "end", "home", "land",
  "country", "nation", "government", "office", "system", "order", "record",
  // Verbs and abstract nouns. A shared "returns" once pulled an airman's
  // portrait into a scene about a boat coming home; an archive query needs a
  // thing you can photograph, not the grammar around it.
  "returns", "returned", "survives", "survive", "survived", "wasted", "mattered",
  "explained", "recorded", "moved", "moves", "turned", "turns", "shifted",
  "looked", "asked", "meant", "means", "wanted", "seemed", "felt", "knew",
  "thought", "saw", "told", "said", "came", "became", "began", "begun",
  "detail", "details", "decision", "decisions", "motive", "motives", "reason",
  "reasons", "question", "questions", "answer", "answers", "evidence",
  "archive", "archives", "paperwork", "pattern", "attention", "consequence",
  "consequences", "witness", "witnesses", "inference", "silence", "language",
  "procedure", "permission", "assumption", "document", "documents", "ledger",
  "file", "files", "report", "account", "version", "argument", "justice",
  "memory", "moment", "hour", "minute", "week", "month", "date", "dates",
]);

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/u)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 3);
}

/**
 * Beat = one clause of the source story, paired with its whole sentence for
 * captions and archive searches. Used by every director tier so the AI is
 * never handed the built-in director's own padding as "factual beats".
 */
function clauseBeats(story: string): { clause: string; full: string }[] {
  const beats: { clause: string; full: string }[] = [];
  for (const sentence of splitSentences(story)) {
    const clauses = sentence
      .split(/;\s*|,\s+(?=[\p{L}])|\s+(?=(?:and|but|while|when|before|after|until|because)\s)/iu)
      .map((p) => p.trim().replace(/[.,;:!?]+$/u, ""))
      .filter((p) => countWords(p) >= 4);
    if (clauses.length > 1) {
      for (const clause of clauses) beats.push({ clause: sentenceCase(clause), full: sentence });
    } else {
      beats.push({ clause: sentence, full: sentence });
    }
  }
  if (!beats.length) {
    beats.push({ clause: sentenceCase(story.slice(0, 120)), full: story });
  }
  return beats;
}

export function properNouns(text: string): string[] {
  const matches =
    text.match(/\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)*/gu) ?? [];
  const out: string[] = [];
  for (const match of matches) {
    const words = match
      .split(/\s+/)
      .filter((w) => !TITLE_WORDS.has(w.toLowerCase()) && w.length > 1);
    while (words.length && STOPWORDS.has(words[0].toLowerCase())) words.shift();
    while (words.length && STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    if (words.length) out.push(words.join(" "));
  }
  return [...new Set(out)];
}

function yearsIn(text: string): string[] {
  return [...new Set(text.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? [])];
}

function archiveQuery(text: string, context: string[], input: DocumentaryInput): string {
  // Visual nouns first. A single-word personal name ("Elias") matches random
  // portraits on Commons, so only full names or place-like words are allowed.
  const themes = storyThemes(text).filter((w) => !GENERIC_VISUAL.has(w)).slice(0, 2);
  const years = yearsIn(text);
  const names = [...properNouns(text), ...context].filter(
    (n) => n.includes(" ") || n.length >= 8,
  );
  // Two specific words plus a name or year: longer queries return nothing on
  // Commons' AND search, and the broad fallback fills with modern stock.
  const parts = [...new Set([...themes, ...years.slice(0, 1), ...names.slice(0, 1)])];
  if (parts.length >= 2) return parts.join(" ").split(" ").slice(0, 4).join(" ");

  const keywords = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(
      (w) => w.length > 3 && !STOPWORDS.has(w) && !GENERIC_VISUAL.has(w),
    )
    .slice(0, 3);
  const era = input.era
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 1);
  return [...new Set([...keywords, ...era])].slice(0, 4).join(" ");
}

function captionFor(text: string): string {
  const cleaned = text
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ");
  const shown = words.slice(0, 24);
  let out = shown.join(" ");
  if (shown.length < words.length) out = `${out.replace(/[,;:]+$/u, "")}…`;
  return out.length > 3 ? out : "The record";
}

function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Story-specific opening hook used when no AI director is available. */
export function freeTagline(input: DocumentaryInput, title: string): string {
  const names = [...properNouns(title), ...properNouns(input.story)];
  let subject = names.find((n) => n.length > 2) ?? title;
  subject = subject
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
  if (subject.length > 58) subject = `${subject.slice(0, 58).replace(/\s+\S*$/u, "")}…`;
  const years = yearsIn(input.story);
  const span =
    years.length >= 2
      ? `${years[0]}–${years[years.length - 1]}`
      : years.length === 1
        ? years[0]
        : "";

  const pool = span
    ? [
        `${subject}: ${span} — the story the record almost buried.`,
        `How ${subject} changed everything — and what it cost.`,
        `${subject}. ${span}. One story, told from the archive.`,
        `The rise, the reckoning, and what remains of ${subject}.`,
        `${span}: the decisions that made it all inevitable.`,
      ]
    : [
        `${subject}: the story the record almost buried.`,
        `How ${subject} changed everything — and what it cost.`,
        `The rise, the reckoning, and what remains of ${subject}.`,
        `What really happened — told from the archive.`,
      ];
  return pool[hashText(input.story) % pool.length];
}

const FRAMES = {
  open: [
    "The record begins here, with a world that believed it would last.",
    "What follows is drawn from the historical record, and from the gaps inside it.",
    "This is where the story starts — long before anyone understood what it would become.",
    "The details matter more than the headlines.",
    "By the time the world noticed, the pattern was already set.",
    "Nothing about the beginning looked inevitable.",
    "The first decisions seemed small enough to ignore.",
  ],
  middle: [
    "Each decision narrowed the choices that came after it.",
    "The pattern becomes clearer only in hindsight.",
    "No single moment explains it; the accumulation does.",
    "Later accounts would disagree about the meaning, never the facts.",
    "What looked ordinary at the time would soon carry enormous weight.",
    "The people closest to events rarely saw the whole shape of them.",
    "Power rarely announces itself; it arrives through procedure and permission.",
    "Every institution that could have stopped it found a reason to wait.",
    "The record preserves what was said, and some of what was avoided.",
    "Consequences gather slowly, then all at once.",
    "The machinery of a state is built from ordinary people doing ordinary work.",
    "What was legal and what was right began to pull apart.",
    "The warning signs were public, and easy to explain away.",
    "A society can adapt to almost anything, one concession at a time.",
    "The story turns on details that seemed trivial when they happened.",
    "What survives is fragmentary: a photograph, a letter, a name in a ledger.",
  ],
  close: [
    "The consequences would outlast everyone in the room.",
    "What remains is not a single lesson but a set of questions.",
    "The past does not stay in the past; it becomes evidence.",
    "Memory is not the same as justice, but it is where justice begins.",
    "The story ends here. The argument about what it means does not.",
    "What could have been done differently is still a useful question.",
    "The record closes, but the responsibility does not.",
  ],
};

/** Analysis lines that carry the film when the source story is only a paragraph. */
const ANGLES = [
  "In {era}, the story of the {theme} was not yet the one anyone expected to tell.",
  "The story of the {theme} turns on a decision that looked routine at the time.",
  "Look closely at {year}: the record of the {theme} begins to strain there.",
  "The file on the {theme} is thin, and what it leaves out is telling.",
  "What survives of the {theme} is less revealing than what was lost.",
  "Every account of the {theme} begins with a detail someone thought unimportant.",
  "Nothing about the {theme} arrived suddenly; it was allowed, step by step.",
  "For the people inside it, the {theme} meant only the work in front of them.",
  "The photographs of the {theme} show a calm the documents do not support.",
  "By {year}, the question of the {theme} could no longer be quietly set aside.",
  "What is remembered about the {theme} is the decision, not the years that made it possible.",
  "There is a tidy version of the {theme}, and a version the archive supports.",
  "What remains of the {theme} is fragmentary, and the gaps have been filled with assumption.",
  "Officials described the {theme} as routine; the record suggests otherwise.",
  "What the {theme} cost was counted in places the ledger never reached.",
  "The story of the {theme} is about permission as much as about power.",
  "Later, the {theme} would be cited as a warning. At the time it was procedure.",
  "The language around the {theme} changed faster than anyone could track.",
  "Those closest to the {theme} disagreed about what they had witnessed.",
  "Nothing about the {theme} was inevitable, and that is the uncomfortable part.",
  "A single document about the {theme} survives; the rest is inference.",
  "Support for the {theme} was defended, then explained, then quietly withdrawn.",
  "What happened around the {theme} was reported accurately and understood poorly.",
  "The cost of the {theme} fell on people far from the room where it was decided.",
  "In the archive, the {theme} appears in the background of other people's stories.",
  "None of it was accident or conspiracy; it was accumulation.",
  "The clearest evidence about the {theme} comes from the people who resisted it.",
  "By the time the {theme} was questioned, the cost had already been paid.",
  "What the record of the {theme} reveals is how quickly the exceptional becomes ordinary.",
  "What the {theme} meant depended on who was asked, and when.",
  "What was left behind of the {theme} makes sense only in sequence.",
  "The turning point in the story of the {theme} looked, at the time, like a drift.",
  "No one photographed the moment everything around the {theme} changed.",
  "What made the {theme} possible was that too many people chose to wait.",
  "Years later, the {theme} would be studied for what it did not prevent.",
  "The story of the {theme} sits at the intersection of duty and doubt.",
  "Records about the {theme} were kept by the same hands that acted.",
  "Nothing in the record of the {theme} suggests it had to end this way.",
];

const BRIDGES = [
  "The record moves on to the {theme}.",
  "The story turns toward the {theme}.",
  "Attention shifts to the {theme}.",
  "The next part of the story concerns the {theme}.",
  "The archive returns to the {theme}.",
];

// Short, grammar-neutral lines used to fill the last second or two of a scene
// whose narration would otherwise run under its share of the run time.
const SHORT_LINES = [
  "That detail mattered.",
  "No one recorded it.",
  "The record is silent.",
  "The dates are exact.",
  "The motives are not.",
  "The file is thin.",
  "The rest was inference.",
  "The photographs survive.",
  "The names are missing.",
  "Nothing was wasted.",
  "The pattern held.",
  "It was never explained.",
  "The paperwork survives.",
  "No one asked why.",
  "The room was full.",
  "The decision stood.",
];

const DETAILS = [
  "The details are not incidental.",
  "The record is fragmentary but consistent.",
  "The stakes were not yet visible.",
  "The decision seemed routine at the time.",
  "The consequences arrived later.",
  "The pattern was already forming.",
  "The paperwork tells its own story.",
  "The witnesses disagreed about almost everything.",
  "The dates are precise; the motives are not.",
  "The silence around it is also evidence.",
];

function sentenceCase(text: string): string {
  const body = text.trim().replace(/[.,;:!?]+$/u, "");
  return body ? body.charAt(0).toUpperCase() + body.slice(1) + "." : body;
}

/** Concrete, frequently used story words — the visual vocabulary of the film. */
function storyThemes(text: string): string[] {
  const names = new Set(
    properNouns(text)
      .flatMap((n) => n.toLowerCase().split(/\s+/))
      .filter(Boolean),
  );
  // A word after a determiner or before "of" is likely a noun; verbs and
  // participles make broken narration ("the battered sits...").
  const boosted = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:the|a|an|his|her|their|its|our|this|that)\s+([a-zà-ÿ][a-zà-ÿ'-]{4,})/giu,
  )) {
    boosted.add(match[1].toLowerCase());
  }
  const participles = new Set([
    "spoken", "written", "given", "taken", "broken", "chosen", "known", "shown",
    "grown", "driven", "fallen", "hidden", "risen", "seen", "been", "done", "gone",
    "made", "said", "told", "kept", "left", "lost", "won", "found", "held",
  ]);

  const counts = new Map<string, { n: number; boost: number }>();
  for (const word of text.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ'-]{4,}/g) ?? []) {
    const clean = word.replace(/'s$/u, "").replace(/-/g, " ");
    for (const part of clean.split(/\s+/)) {
      if (part.length < 5 || STOPWORDS.has(part) || names.has(part) || TITLE_WORDS.has(part)) continue;
      if (participles.has(part)) continue;
      if (/(?:ing|ed|ly)$/u.test(part) && part.length < 9) continue;
      if (/\d/.test(part)) continue;
      const entry = counts.get(part) ?? { n: 0, boost: 0 };
      entry.n++;
      if (boosted.has(part)) entry.boost = 1;
      counts.set(part, entry);
    }
  }
  const all = [...counts.entries()];
  // When the story gives us enough determiner-anchored nouns, use only those:
  // they are the words that survive grammatically in narration and search.
  const anchored = all.filter(([, v]) => v.boost === 1);
  const pool = anchored.length >= 4 ? anchored : all;
  return pool
    .sort(
      (a, b) =>
        b[1].boost - a[1].boost ||
        b[1].n - a[1].n ||
        b[0].length - a[0].length,
    )
    .map(([word]) => word)
    .slice(0, 10);
}

function fillVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

/**
 * Deterministic, offline director. Honours the requested scene count, walks
 * the story once in order, and fills each scene with a different analytical
 * line so a short source paragraph never becomes the same five sentences on a
 * loop. No key, no network.
 */
export function storyScript(input: DocumentaryInput, requestedScenes: number): PlannedScript {
  const title = slugTitle(input);
  const sentences = splitSentences(input.story);
  const sceneCount = Math.max(6, Math.min(100, requestedScenes));

  const beats = clauseBeats(input.story);

  const targetWords = wordsPerScene(input.durationSeconds, sceneCount);
  // A chapter every ~100 s keeps each free-AI reply inside the anonymous
  // output cap: 19 scenes per reply truncated mid-JSON and cost two retries.
  const chapterCount = Math.min(sceneCount, Math.max(3, Math.min(6, Math.round(input.durationSeconds / 100))));
  const titles = chapterTitles(input.genre, chapterCount);
  const perChapter = Math.ceil(sceneCount / chapterCount);
  const themes = storyThemes(input.story);
  const years = yearsIn(input.story);
  const subject =
    properNouns(input.story).find((n) => n.split(/\s+/).length > 1) ??
    properNouns(title)[0] ??
    (themes[0] ? themes[0] : "the story");
  const usedLines = new Set<string>();

  const angleFor = (seed: number, theme: string, year: string): string => {
    const vars = { era: input.era, theme, year, subject };
    for (let k = 0; k < ANGLES.length; k++) {
      const raw = ANGLES[(seed * 7 + k * 5) % ANGLES.length];
      const line = fillVars(raw, vars);
      if (!usedLines.has(line)) {
        usedLines.add(line);
        return line;
      }
    }
    // Theme × detail pairings keep the commentary unique past the first pass.
    for (let k = 0; k < DETAILS.length; k++) {
      const detail = DETAILS[(seed + k) % DETAILS.length];
      const line = year
        ? `${detail} By ${year}, the ${theme} was impossible to ignore.`
        : `${detail} The ${theme} is where that becomes visible.`;
      if (!usedLines.has(line)) {
        usedLines.add(line);
        return line;
      }
    }
    return `The ${theme} is where the record becomes difficult.`;
  };

  const chapters: PlannedChapter[] = [];
  for (let c = 0; c < chapterCount; c++) {
    const count = Math.min(perChapter, sceneCount - c * perChapter);
    if (count <= 0) break;
    const scenes: PlannedScene[] = [];
    for (let s = 0; s < count; s++) {
      const index = c * perChapter + s;
      const beatIndex = Math.min(
        beats.length - 1,
        Math.floor((index * beats.length) / sceneCount),
      );
      const beat = beats[beatIndex];
      // The source sentence appears once per beat block; the scenes that
      // continue the block move the film with analysis instead of repeating it.
      const blockStart = Math.ceil((beatIndex * sceneCount) / beats.length);
      const firstInBlock = index === blockStart;
      const theme = themes[index % Math.max(1, themes.length)] ?? subject;
      const year = years.length ? years[index % years.length] : "";

      let narration = firstInBlock
        ? beat.clause
        : fillVars(BRIDGES[index % BRIDGES.length], { theme });
      let guard = 0;
      while (countWords(narration) < targetWords * 0.98 && guard < 6) {
        // Fill with a complete sentence that fits the remaining budget. The
        // analytical angles are long, so most short beats get a compact line.
        const angle = angleFor(index + guard * 11, theme, year);
        if (!narration.includes(angle) && countWords(`${narration} ${angle}`) <= targetWords) {
          narration += ` ${angle}`;
        } else {
          const line = SHORT_LINES[(index + guard * 3) % SHORT_LINES.length];
          if (!narration.includes(line) && countWords(`${narration} ${line}`) <= targetWords) {
            narration += ` ${line}`;
          }
        }
        guard++;
      }
      // A story clause that overflows its budget is kept whole, but appended
      // analysis is trimmed at a sentence boundary: a mid-sentence cut reads as
      // a fragment in the narration.
      if (!firstInBlock && countWords(narration) > targetWords * 1.15) {
        const sentences = narration.split(/(?<=[.!?])\s+/u);
        let kept = "";
        for (const sentence of sentences) {
          if (countWords(`${kept} ${sentence}`) > targetWords) break;
          kept = `${kept} ${sentence}`.trim();
        }
        if (kept) narration = kept;
      }

      const caption = captionFor(beat.clause);
      const visual = caption.length < 24 ? captionFor(`${beat.clause} ${theme}`) : caption;
      // Commons is searched with AND, so five niche words return nothing and
      // four generic words return a tourist photo of the wrong place. Two
      // concrete words from THIS scene plus a year is the reliable shape; the
      // scene's own narration supplies them so neighbours do not all search
      // the same phrase.
      const sceneWords = storyThemes(`${narration} ${beat.clause}`).filter(
        (w) => !GENERIC_VISUAL.has(w),
      );
      const beatWords = storyThemes(beat.clause).filter((w) => !GENERIC_VISUAL.has(w));
      const anchor = themes.find((w) => !GENERIC_VISUAL.has(w));
      const beatYear = yearsIn(`${beat.clause} ${beat.full}`)[0] ?? "";
      const primaryWord = sceneWords[index % Math.max(1, sceneWords.length)] ?? sceneWords[0];
      const secondaryWord = beatWords.find((w) => w !== primaryWord) ?? sceneWords.find((w) => w !== primaryWord);
      const queryWords = [
        ...new Set(
          (primaryWord
            ? [primaryWord, secondaryWord ?? anchor ?? "", beatYear]
            : [...themes.slice(0, 2), beatYear]
          ).filter(Boolean),
        ),
      ].slice(0, 3);

      scenes.push({
        narration,
        caption: visual,
        imageQuery: queryWords.join(" ") || caption,
        imagePrompt:
          `${input.style} documentary still: ${visual} ` +
          `Setting: ${input.era}. Archival texture, cinematic composition, no text.`,
      });
    }
    chapters.push({ title: `Chapter ${c + 1}: ${titles[c] ?? "The Story"}`, scenes });
  }

  const firstSentence = (input.story.trim().match(/^[^.!?]+[.!?]/u)?.[0] ?? input.story)
    .replace(/\s+/g, " ")
    .trim();
  const snippet =
    firstSentence.length <= 150
      ? firstSentence.replace(/[.,;:!?]+$/u, "")
      : `${firstSentence.slice(0, 150).replace(/\s+\S*$/u, "").replace(/[.,;:!?]+$/u, "")}…`;
  return {
    title,
    logline: snippet || `The story of ${title}`,
    tagline: freeTagline(input, title),
    chapters,
  };
}


function chapterTitles(genre: string, count: number): string[] {
  const g = genre.toLowerCase();
  let pool: string[];
  if (/histor|biograph|political/.test(g)) {
    pool = ["Origins", "The Rise", "Power and Terror", "The Turning Point", "War and Aftermath", "What Remains"];
  } else if (/crime|investigat/.test(g)) {
    pool = ["The Case", "The Evidence", "The Turn", "The Reckoning", "What Remains", "Aftermath"];
  } else if (/nature|science/.test(g)) {
    pool = ["The World", "First Signs", "The Discovery", "The Turning Point", "Consequences", "What Remains"];
  } else if (/sport/.test(g)) {
    pool = ["The Dream", "The Training", "The Break", "The Final", "What Remains", "Aftermath"];
  } else if (/business/.test(g)) {
    pool = ["The Idea", "The Rise", "The Bet", "The Fall", "What Remains", "Aftermath"];
  } else {
    pool = ["Beginnings", "The Tension", "The Turn", "The Cost", "What Remains", "Aftermath"];
  }
  return Array.from({ length: count }, (_, i) => pool[i] ?? `Chapter ${i + 1}`);
}

/** Deterministic fallback used for mock mode and when a planner fails. */
export function fallbackScript(input: DocumentaryInput, sceneCount: number): PlannedScript {
  return storyScript(input, sceneCount);
}

function sanitizeScenes(raw: unknown, input: DocumentaryInput): PlannedScene[] {
  if (!Array.isArray(raw)) return [];
  const scenes: PlannedScene[] = [];
  for (const sc of raw) {
    const s = sc as {
      narration?: unknown;
      caption?: unknown;
      imagePrompt?: unknown;
      image_prompt?: unknown;
      imageQuery?: unknown;
      image_query?: unknown;
    };
    const narration = String(s.narration ?? "").trim();
    if (narration.length < 20) continue;
    const caption = String(s.caption ?? "").trim() || narration.slice(0, 70);
    scenes.push({
      narration,
      caption,
      imagePrompt:
        String(s.imagePrompt ?? s.image_prompt ?? "").trim() || `${input.style} documentary still: ${narration.slice(0, 120)}`,
      imageQuery:
        String(s.imageQuery ?? s.image_query ?? "").trim() ||
        `${caption} ${input.era}`.replace(/\s+/g, " ").trim(),
    });
  }
  return scenes;
}

function sanitize(raw: unknown, input: DocumentaryInput, sceneCount: number): PlannedScript | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { title?: unknown; logline?: unknown; tagline?: unknown; hook?: unknown; chapters?: unknown };
  if (!Array.isArray(obj.chapters)) return null;
  const chapters: PlannedChapter[] = [];
  for (const ch of obj.chapters) {
    const c = ch as { title?: unknown; scenes?: unknown };
    const scenes = sanitizeScenes(c.scenes, input);
    if (scenes.length) chapters.push({ title: String(c.title ?? `Chapter ${chapters.length + 1}`).trim(), scenes });
  }
  if (!chapters.length) return null;

  // Fit total scenes to the requested count. Extra scenes get new commentary
  // (and a fresh visual query) instead of a verbatim duplicate.
  const base = chapters.flatMap((c) => c.scenes);
  const flat = [...base];
  while (flat.length < sceneCount && base.length) {
    const source = base[flat.length % base.length];
    const theme = storyThemes(`${source.caption} ${source.narration}`)[0] ?? "the record";
    const line = fillVars(ANGLES[(flat.length * 5 + 3) % ANGLES.length], {
      era: input.era,
      theme,
      year: yearsIn(source.narration)[0] ?? "",
      subject: theme,
    });
    flat.push({
      ...source,
      narration: `${source.narration} ${line}`.trim(),
      imageQuery: archiveQuery(`${source.caption} ${line}`, [], input) || source.imageQuery,
    });
  }
  const fitted = flat.slice(0, sceneCount);
  const rebuilt: PlannedChapter[] = [];
  let cursor = 0;
  for (const ch of chapters) {
    if (cursor >= fitted.length) break;
    const take = Math.min(ch.scenes.length, fitted.length - cursor);
    rebuilt.push({ title: ch.title, scenes: fitted.slice(cursor, cursor + take) });
    cursor += take;
  }
  if (cursor < fitted.length) rebuilt.push({ title: "Chapter", scenes: fitted.slice(cursor) });

  const title = String(obj.title ?? "").trim() || slugTitle(input);
  return {
    title,
    logline: String(obj.logline ?? "").trim() || `The story of ${title}`,
    tagline:
      String(obj.tagline ?? obj.hook ?? "").trim().replace(/\s+/g, " ").slice(0, 180) ||
      freeTagline(input, title),
    chapters: rebuilt,
  };
}

function parseJson(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The anonymous endpoint cuts replies mid-JSON at its output limit. Pull every
 * complete object out of a truncated document so finished scenes still ship.
 */
function salvageObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf("{", cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(raw.slice(start, end + 1)));
      cursor = end + 1;
    } catch {
      cursor = start + 1;
    }
  }
  return out;
}

function salvageScriptScenes(raw: string, input: DocumentaryInput): PlannedScene[] {
  const objects = salvageObjects(raw).filter(
    (o): o is Record<string, unknown> =>
      Boolean(o) &&
      typeof o === "object" &&
      typeof (o as { narration?: unknown }).narration === "string",
  );
  return sanitizeScenes(objects, input);
}

function planningPrompt(input: DocumentaryInput, sceneCount: number): { system: string; user: string } {
  const words = Math.round((input.durationSeconds / 60) * 150);
  const perScene = Math.max(28, Math.round(words / sceneCount));
  const chapterCount = Math.min(6, Math.max(3, Math.round(input.durationSeconds / 150)));
  const system = [
    "You are an award-winning documentary director and screenwriter for a cinematic YouTube channel.",
    "Write a story-specific, fact-faithful documentary script as strict JSON only.",
    'Shape: {"title":string,"tagline":string,"logline":string,"chapters":[{"title":string,"scenes":[{"narration":string,"caption":string,"imagePrompt":string,"imageQuery":string}]}]}.',
    `Produce exactly ${sceneCount} scenes across ${chapterCount} chapters. Every scene must advance the story; never repeat a framing sentence.`,
    `Each narration is about ${perScene} words of spoken voice-over (${sceneCount * perScene} total). Write narration and captions in ${input.language}.`,
    "Open on a hook: a concrete decision, fact or consequence from the story, never a generic 'this is the story of' line.",
    "tagline is the cinematic line shown over the opening shot: max 14 words, specific to this story. Never use 'A documentary about', 'uncover the truth', 'journey into', 'delve into' or other stock phrases.",
    "caption is 6-14 words distilled from that scene's own narration, suitable as a burned-in lower-third.",
    "imageQuery is 3-7 plain archive keywords naming the exact subject visible in THIS scene: person, event, place and year where known (e.g. 'Reichstag fire assembly chamber 1933'). It must describe this scene, not the broad topic. No style words, no punctuation.",
    "imagePrompt is a vivid visual description for an image generator: subject, action, setting, era, lighting, lens, mood.",
    "Use only the real names, dates and places from the provided story. Do not introduce facts not in it. Never invent quotations or events. Do not include timestamps, shot numbers or commentary.",
    "Keep people, palette and era consistent across scenes. Output JSON only, no markdown.",
  ].join(" ");

  const user = [
    `Story / topic: ${input.story}`,
    `Genre / tone: ${input.genre}`,
    `Era / setting: ${input.era || "unspecified"}`,
    `Language: ${input.language}`,
    `Visual style: ${input.style}`,
    `Target length: ${input.durationSeconds} seconds (about ${words} spoken words total).`,
  ].join("\n");
  return { system, user };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function countScenes(script: PlannedScript): number {
  return script.chapters.reduce((n, chapter) => n + chapter.scenes.length, 0);
}

function assertSceneCount(script: PlannedScript, sceneCount: number, source: string): PlannedScript {
  const actual = countScenes(script);
  // A short script would be padded with duplicate scenes, which repeats imagery
  // and narration. Better to fall back to the deterministic director.
  if (actual < Math.ceil(sceneCount * 0.7)) {
    throw new Error(`${source} returned ${actual}/${sceneCount} scenes`);
  }
  return script;
}

/** Pollinations allows one anonymous reply per IP every 45 seconds. */
let lastFreeCallAt = 0;

async function waitForFreeSlot(onLog?: (message: string) => void): Promise<void> {
  // The quota is measured from the previous reply, not from our request time,
  // so callers stamp lastFreeCallAt only after the response lands.
  const wait = lastFreeCallAt + 47_000 - Date.now();
  if (wait > 0) {
    onLog?.(`Free AI quota window — waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }
}

type FreeChunk = {
  title?: string;
  tagline?: string;
  logline?: string;
  chapterTitle: string;
  scenes: PlannedScene[];
};

function chunkPrompt(
  input: DocumentaryInput,
  totalScenes: number,
  want: number,
  chapterIndex: number,
  chapterCount: number,
  chapterTitle: string,
  beats: string[],
  nextBeat: string,
): { system: string; user: string } {
  // Match the pipeline's spoken budget exactly. A generic 150-words-per-minute
  // estimate asked for 30 words per scene on a 75-scene film, and the assembler
  // then cut every narration down to 12: the screenplay read as unfinished
  // sentences. The estimate module already knows the real pace and tail.
  const perScene = Math.max(6, wordsPerScene(input.durationSeconds, totalScenes));
  const withMeta = chapterIndex === 0;
  const schema = withMeta
    ? '{"title":string,"tagline":string,"logline":string,"chapterTitle":string,"scenes":[{"narration":string,"caption":string,"imagePrompt":string,"imageQuery":string}]}'
    : '{"chapterTitle":string,"scenes":[{"narration":string,"caption":string,"imagePrompt":string,"imageQuery":string}]}';
  const system = [
    "You are an award-winning documentary director and screenwriter for a cinematic YouTube channel.",
    "Write story-specific, fact-faithful narration as strict JSON only.",
    `Shape: ${schema}.`,
    `Write the scenes for chapter ${chapterIndex + 1} of ${chapterCount}: exactly ${want} scenes.`,
    `Each narration is about ${perScene} spoken words (never more than ${Math.ceil(perScene * 1.15)}). Write in ${input.language}.`,
    "Ground every scene in the provided factual beats and story text. Do not introduce names, dates, numbers or events that are not in them. Never invent quotations. Never repeat a line or a framing sentence.",
    chapterIndex === 0
      ? "Open on a concrete hook from the story, never a generic 'this is the story of' line."
      : "Continue the arc of this chapter without recapping earlier scenes.",
    ...(withMeta
      ? [
          "title is a specific, cinematic documentary title for this story.",
          "tagline is the line shown over the opening shot: max 14 words, specific to this story, no stock phrases.",
          "logline is one sentence summarising the film.",
        ]
      : []),
    "caption is 6-14 words distilled from that scene's own narration.",
    "imageQuery is 3-7 plain archive keywords naming the exact subject visible in THIS scene: the real person, event, place and year. Always include the main person's name when the scene is about a person; never rely on a role word alone (chancellor, leader, president). Prefer photographs of people, places and events; avoid documents, maps, posters and modern photos. No style words, no punctuation.",
    "imagePrompt is a vivid visual description for an image generator: subject, action, setting, era, lighting, lens, mood.",
    "Output JSON only, no markdown.",
  ].join(" ");
  const user = [
    `Story / topic: ${input.story}`,
    `Genre / tone: ${input.genre}`,
    `Era / setting: ${input.era || "unspecified"}`,
    `Language: ${input.language}`,
    `Visual style: ${input.style}`,
    `Full film target: ${input.durationSeconds} seconds, ${totalScenes} scenes.`,
    `This chapter: "${chapterTitle}" (${chapterIndex + 1}/${chapterCount}), write ${want} scenes.`,
    beats.length
      ? `Factual beats for this chapter (rewrite these into cinematic narration, keep their facts):\n${beats.map((b) => `- ${b}`).join("\n")}`
      : "",
    nextBeat ? `Stop before this next-chapter beat; do not narrate it yet:\n- ${nextBeat}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/**
 * One chapter-sized keyless request. The anonymous endpoint caps each reply at
 * roughly 2k output tokens, so a full 24-scene script always truncates; chapters
 * keep every reply short enough to finish as valid JSON.
 */
async function fetchFreeChunk(
  input: DocumentaryInput,
  totalScenes: number,
  want: number,
  chapterIndex: number,
  chapterCount: number,
  chapterTitle: string,
  beats: string[],
  nextBeat: string,
  onLog?: (message: string) => void,
): Promise<FreeChunk> {
  await waitForFreeSlot(onLog);
  const { system, user } = chunkPrompt(
    input,
    totalScenes,
    want,
    chapterIndex,
    chapterCount,
    chapterTitle,
    beats,
    nextBeat,
  );
  const model = process.env.FREE_TEXT_MODEL || "openai";
  const endpoint = process.env.FREE_TEXT_ENDPOINT || "https://text.pollinations.ai/openai";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      // The anonymous free model is a reasoning model: high reasoning effort
      // eats the whole output budget before it writes any JSON.
      reasoning_effort: process.env.FREE_REASONING || "low",
      max_tokens: 16000,
      private: true,
      referrer: "docustudio",
      seed: hashText(input.story + chapterTitle) % 1_000_000,
    }),
    signal: AbortSignal.timeout(240_000),
  }).finally(() => {
    lastFreeCallAt = Date.now();
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`screenwriter returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  };
  const content = data.error?.message ?? data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("screenwriter returned no text");
  const parsed = parseJson(content) as {
    title?: unknown;
    tagline?: unknown;
    logline?: unknown;
    chapterTitle?: unknown;
    scenes?: unknown;
  } | null;
  let scenes = sanitizeScenes(parsed?.scenes, input);
  if (!scenes.length) scenes = salvageScriptScenes(content, input);
  if (!scenes.length) {
    if (process.env.FREE_DEBUG === "1") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("tmpfree/free-raw.txt", content);
    }
    throw new Error(
      `screenwriter returned unusable JSON: ${content.slice(0, 160).replace(/\s+/g, " ")}`,
    );
  }
  const scraped = (key: string) =>
    content.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1]?.trim() ?? "";
  return {
    title: String(parsed?.title ?? scraped("title")).trim(),
    tagline: String(parsed?.tagline ?? scraped("tagline")).trim(),
    logline: String(parsed?.logline ?? scraped("logline")).trim(),
    chapterTitle: String(parsed?.chapterTitle ?? scraped("chapterTitle") ?? chapterTitle).trim(),
    scenes,
  };
}

/**
 * Free AI director, written chapter by chapter. The deterministic director
 * supplies the chapter spine and factual beats, so a failed chapter degrades
 * to coherent narration instead of breaking the film.
 */
async function planFreeChunked(
  input: DocumentaryInput,
  sceneCount: number,
  onLog?: (message: string) => void,
): Promise<PlannedScript> {
  const outline = storyScript(input, sceneCount);
  const chapterCount = outline.chapters.length;
  const base = Math.floor(sceneCount / chapterCount);
  const extra = sceneCount % chapterCount;
  // The AI rewrites the user's own clauses. An outline scene's first sentence
  // is often the deterministic bridge ("The story turns toward..."), and
  // handing that back as a "factual beat" is how a screenplay fills with
  // padding that has nothing to do with the story.
  const sourceBeats = clauseBeats(input.story);
  const beatsForChapter = (index: number) => {
    const from = Math.floor((index * sourceBeats.length) / chapterCount);
    const to = Math.floor(((index + 1) * sourceBeats.length) / chapterCount);
    return sourceBeats.slice(from, to).map((b) => b.clause);
  };

  const chapters: PlannedChapter[] = [];
  let title = outline.title;
  let logline = outline.logline;
  let tagline = outline.tagline;
  let aiChapters = 0;

  for (let i = 0; i < chapterCount; i++) {
    const want = base + (i < extra ? 1 : 0);
    const fallbackTitle = outline.chapters[i]?.title ?? `Chapter ${i + 1}`;
    const beats = beatsForChapter(i).length ? beatsForChapter(i) : sourceBeats.map((b) => b.clause);
    const nextBeat = beatsForChapter(i + 1)[0] ?? "";
    let chunk: FreeChunk | null = null;
    for (let attempt = 1; attempt <= 2 && !chunk; attempt++) {
      try {
        chunk = await fetchFreeChunk(
          input,
          sceneCount,
          want,
          i,
          chapterCount,
          fallbackTitle,
          beats,
          nextBeat,
          onLog,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onLog?.(
          `Free AI chapter ${i + 1}/${chapterCount} attempt ${attempt}/2 failed (${message.slice(0, 140)})`,
        );
        if (attempt < 2) {
          const limited = /FREE_LIMIT|\b402\b|\b429\b|rate limit/i.test(message);
          await sleep(limited ? 50_000 : 15_000);
        }
      }
    }

    // A reasoning-model reply can still exhaust its budget before writing a
    // single scene. Splitting the chapter is better than flat narration.
    if (!chunk && want >= 4) {
      const sizes = [Math.ceil(want / 2), want - Math.ceil(want / 2)];
      const parts: FreeChunk[] = [];
      for (let part = 0; part < sizes.length; part++) {
        if (sizes[part] < 1) continue;
        const partBeats = beats.slice(
          Math.floor((part * beats.length) / sizes.length),
          Math.floor(((part + 1) * beats.length) / sizes.length),
        );
        let piece: FreeChunk | null = null;
        try {
          piece = await fetchFreeChunk(
            input,
            sceneCount,
            sizes[part],
            i,
            chapterCount,
            fallbackTitle,
            partBeats.length ? partBeats : beats,
            nextBeat,
            onLog,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onLog?.(`Free AI chapter ${i + 1} part ${part + 1} failed (${message.slice(0, 120)})`);
        }
        if (!piece) break;
        parts.push(piece);
        onLog?.(`Free AI wrote chapter ${i + 1}/${chapterCount} · part ${part + 1}/${sizes.length}`);
      }
      if (parts.length) {
        chunk = { ...parts[0], scenes: parts.flatMap((p) => p.scenes).slice(0, want) };
      }
    }

    if (chunk) {
      aiChapters++;
      if (i === 0) {
        title = chunk.title || title;
        logline = chunk.logline || logline;
        tagline = chunk.tagline || tagline;
      }
      const heading = (chunk.chapterTitle || fallbackTitle)
        .replace(/^chapter\s+\d+\s*[:·-]\s*/i, "")
        .trim();
      chapters.push({
        title: `Chapter ${i + 1}: ${heading || "The Story"}`,
        scenes: chunk.scenes.slice(0, want),
      });
      onLog?.(`Free AI wrote chapter ${i + 1}/${chapterCount}`);
    } else {
      chapters.push({ title: fallbackTitle, scenes: outline.chapters[i]?.scenes ?? [] });
    }
  }

  if (!aiChapters) throw new Error("free AI could not write any chapter");

  // Never append leftover beats to the final chapter: the story would loop
  // back to its opening. A slightly shorter film is the correct trade.
  return { title, logline, tagline, chapters };
}

/**
 * Free screenplay generation through Pollinations' keyless text endpoint.
 * Falls back to the deterministic director script on failure.
 */
export async function planFreeDocumentary(
  input: DocumentaryInput,
  sceneCount: number,
  onLog?: (message: string) => void,
): Promise<PlannedScript> {
  try {
    return await planFreeChunked(input, sceneCount, onLog);
  } catch {
    onLog?.("Free AI director unavailable — using the built-in director script");
    return storyScript(input, sceneCount);
  }
}

async function geminiScript(
  apiKey: string,
  model: string,
  input: DocumentaryInput,
  sceneCount: number,
): Promise<PlannedScript> {
  const { system, user } = planningPrompt(input, sceneCount);
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: model || "gemini-2.5-flash",
    contents: user,
    config: { systemInstruction: system, responseMimeType: "application/json", temperature: 0.85 },
  });
  const parsed = sanitize(parseJson(extractText(res)), input, sceneCount);
  if (!parsed) throw new Error("Gemini returned unusable JSON");
  return assertSceneCount(parsed, sceneCount, "Gemini");
}

export type DirectorBrain = "gemini" | "free-ai" | "builtin";

/**
 * Three-tier director. Gemini is used only when a key is configured; otherwise
 * the free keyless AI writes the script, and the offline director is the final
 * fallback so a film always ships.
 */
export async function planSmartDocumentary(
  input: DocumentaryInput,
  sceneCount: number,
  apiKey: string,
  onLog?: (message: string) => void,
): Promise<{ script: PlannedScript; brain: DirectorBrain }> {
  if (apiKey) {
    try {
      const script = await geminiScript(
        apiKey,
        process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash",
        input,
        sceneCount,
      );
      onLog?.(`Gemini director wrote ${countScenes(script)} story-specific scenes`);
      return { script, brain: "gemini" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog?.(`Gemini director unavailable (${message.slice(0, 120)}) — trying free AI`);
    }
  }

  try {
    const script = await planFreeChunked(input, sceneCount, onLog);
    onLog?.(`Free AI director wrote ${countScenes(script)} story-specific scenes`);
    return { script, brain: "free-ai" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLog?.(`Free AI director unavailable (${message.slice(0, 120)}) — using built-in director`);
  }

  return { script: storyScript(input, sceneCount), brain: "builtin" };
}
