import fs from "node:fs";
import type { SubtitleCue, WordTiming } from "./types";

const ACCENT = "&H0040D0FF&"; // warm amber in ASS BGR order
const WHITE = "&H00FFFFFF&";

/**
 * Edge's word events carry no punctuation, so cue boundaries fall in the wrong
 * place ("the moment Everything around"). Zip the timings back onto the
 * narration's own words to recover full stops and commas.
 */
export function alignWords(words: WordTiming[], narration: string): WordTiming[] {
  const tokens = narration.split(/\s+/).filter(Boolean);
  if (!tokens.length || Math.abs(tokens.length - words.length) > Math.max(2, tokens.length * 0.12)) {
    return words;
  }
  return words.map((word, i) => ({ ...word, w: tokens[i] ?? word.w }));
}

/**
 * Group word boundaries into subtitle cues: one or two lines, 6-9 words,
 * never crossing a full stop. Timings come from the voice itself, so captions
 * land on the syllable instead of drifting across a scene.
 */
export function cuesFromWords(
  words: WordTiming[],
  opts: { maxWords?: number; maxChars?: number } = {},
): SubtitleCue[] {
  const maxWords = opts.maxWords ?? 7;
  const maxChars = opts.maxChars ?? 44;
  const cues: SubtitleCue[] = [];
  let current: WordTiming[] = [];
  let chars = 0;
  let prevEnd = -1;

  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    const last = current[current.length - 1];
    const end = Math.max(last.t + Math.max(0.18, last.d), first.t + 0.9);
    cues.push({
      start: Math.round(first.t * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text: current.map((w) => w.w.trim()).join(" ").replace(/\s+([,.;:!?])/g, "$1"),
    });
    current = [];
    chars = 0;
  };

  for (const word of words) {
    const text = word.w.trim();
    if (!text) continue;
    // Edge strips punctuation from word events, but it leaves a real pause at
    // commas and full stops. A pause is the most reliable cue boundary.
    const pause = prevEnd >= 0 ? word.t - prevEnd : 0;
    const nextChars = chars + (current.length ? 1 : 0) + text.length;
    if (
      current.length &&
      (current.length >= maxWords ||
        nextChars > maxChars ||
        (current.length >= 3 && pause > 0.16))
    ) {
      flush();
    }
    current.push(word);
    chars += (current.length > 1 ? 1 : 0) + text.length;
    prevEnd = word.t + word.d;
    if (/[.!?]$/.test(text) || (current.length >= 4 && /[,;:—]$/.test(text))) flush();
  }
  flush();

  // Never let a cue bleed into the next one: a hard overlap reads as flicker.
  for (let i = 0; i < cues.length - 1; i++) {
    const nextStart = cues[i + 1].start;
    if (cues[i].end > nextStart - 0.04) {
      cues[i].end = Math.max(cues[i].start + 0.45, nextStart - 0.04);
    }
  }
  return cues.filter((c) => c.end - c.start >= 0.2 && c.text.trim());
}

/** Split an SRT sentence cue into readable clause-sized cues, proportionally. */
export function splitLongCues(cues: SubtitleCue[], maxChars = 84): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (text.length <= maxChars) {
      out.push(cue);
      continue;
    }
    const parts = text
      .split(/(?<=[,;:])\s+/)
      .reduce<string[]>((acc, part) => {
        if (!acc.length) return [part];
        const joined = `${acc[acc.length - 1]} ${part}`;
        if (joined.length <= maxChars) {
          acc[acc.length - 1] = joined;
          return acc;
        }
        return [...acc, part];
      }, []);
    const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
    let cursor = cue.start;
    const span = Math.max(0.5, cue.end - cue.start);
    parts.forEach((part, i) => {
      const share = (part.length / totalChars) * span;
      const start = cursor;
      const end = i === parts.length - 1 ? cue.end : Math.min(cue.end, cursor + share);
      out.push({ start, end, text: part.trim() });
      cursor = end;
    });
  }
  return out;
}

/** Caption-only fallback when the engine produced no boundary data. */
export function fallbackCues(caption: string, seconds: number): SubtitleCue[] {
  const text = caption.replace(/\s+/g, " ").trim();
  if (!text) return [];
  return [{ start: 0.35, end: Math.max(1.4, Math.min(seconds - 0.2, seconds)), text }];
}

function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines;
  // Force exactly two balanced lines rather than a three-line block.
  const total = text.length;
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ").length;
    const gap = Math.abs(left - (total - left));
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.round((safe - Math.floor(safe)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(
    Math.min(99, cs),
  ).padStart(2, "0")}`;
}

function escapeAss(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\s+/g, " ")
    .trim();
}

/** Accent years and proper names so key facts read at a glance. */
function accent(text: string): string {
  let first = true;
  return text
    .split(/\s+/)
    .map((word) => {
      const plain = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const keep = first;
      first = false;
      if (keep) return word;
      const important =
        /\b(1[89]\d{2}|20\d{2})s?\b/.test(plain) ||
        (/^[A-Z][\p{L}'’-]{2,}/u.test(plain) && !/^(The|And|But|When|After|Before|This|That|They|Their)$/i.test(plain));
      return important ? `{\\c${ACCENT}}${word}{\\c${WHITE}}` : word;
    })
    .join(" ");
}

/**
 * Render cues to an ASS file. libass gives real typography (outline, shadow,
 * safe margins) and two-line wrapping that drawtext cannot match.
 */
export function writeAss(opts: {
  cues: SubtitleCue[];
  outPath: string;
  dims: { w: number; h: number };
  maxChars?: number;
  marginBottom?: number;
}): void {
  const { w, h } = opts.dims;
  const fontSize = Math.round(Math.min(h * 0.038, w * 0.046));
  const marginV = Math.round(opts.marginBottom ?? h * 0.06);
  const marginSide = Math.round(w * 0.07);
  const maxChars = opts.maxChars ?? (w >= 1600 ? 46 : 40);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Doc,Arial,${fontSize},${WHITE},${ACCENT},&H00101010,&H78000000,1,0,0,0,100,100,0.3,0,1,${(
      fontSize * 0.035
    ).toFixed(2)},${(fontSize * 0.018).toFixed(2)},2,${marginSide},${marginSide},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = opts.cues.map((cue) => {
    const text = wrapLines(cue.text, maxChars)
      .map((line) => accent(escapeAss(line)))
      .join("\\N");
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Doc,,0,0,0,,{\\fad(120,120)}${text}`;
  });

  fs.writeFileSync(opts.outPath, `${header.join("\n")}\n${events.join("\n")}\n`, "utf8");
}
