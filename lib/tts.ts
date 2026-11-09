import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { probeDuration, run } from "./media";
import type { SubtitleCue, WordTiming } from "./types";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SpeechResult {
  seconds: number;
  /** Word-level timings when the free Edge engine exposes them. */
  words?: WordTiming[];
  /** Sentence-level cues parsed from Edge's SRT fallback. */
  cues?: SubtitleCue[];
}

const EDGE_BY_VOICE: Record<string, string> = {
  Charon: "en-US-ChristopherNeural",
  Orus: "en-GB-RyanNeural",
  Fenrir: "en-US-GuyNeural",
  Puck: "en-US-BrianNeural",
  Kore: "en-US-AriaNeural",
  Leda: "en-US-JennyNeural",
  Aoede: "en-GB-SoniaNeural",
  Zephyr: "en-US-AvaNeural",
};

const FEMALE_VOICES = new Set(["Kore", "Leda", "Aoede", "Zephyr"]);

const EDGE_BY_LANGUAGE: Record<string, { male: string; female: string }> = {
  English: { male: "en-US-ChristopherNeural", female: "en-US-AriaNeural" },
  Hindi: { male: "hi-IN-MadhurNeural", female: "hi-IN-SwaraNeural" },
  Spanish: { male: "es-ES-AlvaroNeural", female: "es-ES-ElviraNeural" },
  French: { male: "fr-FR-HenriNeural", female: "fr-FR-DeniseNeural" },
  German: { male: "de-DE-ConradNeural", female: "de-DE-KatjaNeural" },
  Portuguese: { male: "pt-BR-AntonioNeural", female: "pt-BR-FranciscaNeural" },
  Japanese: { male: "ja-JP-KeitaNeural", female: "ja-JP-NanamiNeural" },
  Arabic: { male: "ar-EG-ShakirNeural", female: "ar-EG-SalmaNeural" },
  Italian: { male: "it-IT-DiegoNeural", female: "it-IT-ElsaNeural" },
  Korean: { male: "ko-KR-InJoonNeural", female: "ko-KR-SunHiNeural" },
};

export function edgeVoiceFor(voice: string, language: string): string {
  if (voice.includes("Neural")) return voice;
  const byLanguage = EDGE_BY_LANGUAGE[language];
  if (byLanguage) return FEMALE_VOICES.has(voice) ? byLanguage.female : byLanguage.male;
  return EDGE_BY_VOICE[voice] ?? EDGE_BY_VOICE.Charon;
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_#`~]/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSrtTime(value: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(value.trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parse Edge's SRT sidecar into sentence-level cues. */
export function srtToCues(srt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = srt.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const [from, to] = timing.split("-->");
    const text = lines
      .filter((l) => l !== timing && !/^\d+$/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ start: parseSrtTime(from), end: parseSrtTime(to), text });
  }
  return cues;
}

function readWords(file: string): WordTiming[] | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return undefined;
    const words = raw
      .map((w) => w as { t?: unknown; d?: unknown; w?: unknown })
      .filter((w) => Number.isFinite(Number(w.t)) && typeof w.w === "string" && w.w.trim())
      .map((w) => ({ t: Number(w.t), d: Math.max(0, Number(w.d) || 0), w: String(w.w) }));
    return words.length ? words : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Free narration: Microsoft Edge neural TTS (no key, no cost) rendered to mp3,
 * then converted to 48 kHz stereo WAV for the edit. The Python helper also
 * captures word boundaries so subtitles can follow the voice exactly. Falls
 * back to the CLI/SRT sidecar, then to the offline Windows SAPI voice.
 */
export async function synthesizeFreeSpeech(
  text: string,
  voice: string,
  language: string,
  outPath: string,
  cwd: string,
): Promise<SpeechResult> {
  const spoken = cleanForSpeech(text);
  const textFile = outPath.replace(/\.wav$/i, ".txt");
  const edgeFile = outPath.replace(/\.wav$/i, ".edge.mp3");
  const srtFile = outPath.replace(/\.wav$/i, ".edge.srt");
  const wordsFile = outPath.replace(/\.wav$/i, ".words.json");
  const sapiFile = outPath.replace(/\.wav$/i, ".sapi.wav");
  fs.writeFileSync(textFile, spoken);

  const python = process.env.EDGE_TTS_PYTHON || "python";
  const selected = edgeVoiceFor(voice, language);
  const helper = path.join(process.cwd(), "scripts", "edge_words.py");

  const toWav = async () => {
    await run(FFMPEG, [
      "-y",
      "-i",
      edgeFile,
      "-vn",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      outPath,
    ]);
    return probeDuration(outPath);
  };

  let edgeError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let words: WordTiming[] | undefined;
      if (fs.existsSync(helper)) {
        try {
          await run(
            python,
            [helper, textFile, edgeFile, selected, "-4%", "-2Hz", wordsFile],
            cwd,
          );
          words = readWords(wordsFile);
        } catch (helperError) {
          edgeError = helperError;
        }
      }
      if (!fs.existsSync(edgeFile) || fs.statSync(edgeFile).size < 1000) {
        // The Python API helper is newer than the CLI on some installs; the CLI
        // still delivers audio and a sentence-level SRT sidecar.
        await run(
          python,
          [
            "-m",
            "edge_tts",
            "--voice",
            selected,
            "--file",
            textFile,
            "--write-media",
            edgeFile,
            "--write-subtitles",
            srtFile,
            "--rate=-4%",
            "--pitch=-2Hz",
            "--no-progress",
          ],
          cwd,
        );
      }
      if (!fs.existsSync(edgeFile) || fs.statSync(edgeFile).size < 1000) {
        throw new Error("Edge TTS produced no audio");
      }
      const seconds = await toWav();
      if (seconds > 0.2) {
        const cues =
          words && words.length
            ? undefined
            : fs.existsSync(srtFile)
              ? srtToCues(fs.readFileSync(srtFile, "utf8"))
              : undefined;
        return { seconds, words: words?.length ? words : undefined, cues };
      }
      throw new Error("Edge TTS WAV was empty");
    } catch (err) {
      edgeError = err;
      if (attempt < 2) await sleep(2500);
    }
  }

  try {
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.Rate = -1",
      `$s.SetOutputToWaveFile('${sapiFile.replace(/'/g, "''")}')`,
      `$s.Speak([IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}'))`,
      "$s.Dispose()",
    ].join("; ");
    await run(process.env.SAPI_POWERSHELL || "powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    await run(FFMPEG, [
      "-y",
      "-i",
      sapiFile,
      "-vn",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      outPath,
    ]);
    return { seconds: await probeDuration(outPath) };
  } catch (sapiError) {
    const first = edgeError instanceof Error ? edgeError.message : String(edgeError);
    const second = sapiError instanceof Error ? sapiError.message : String(sapiError);
    throw new Error(`Narration failed. Edge: ${first.slice(0, 120)} · SAPI: ${second.slice(0, 120)}`);
  }
}

/** Wrap raw 16-bit PCM into a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Generate narration with Gemini TTS and write a WAV file.
 * Gemini TTS returns raw PCM (audio/L16; rate=24000) as base64.
 */
export async function synthesizeSpeech(
  apiKey: string,
  model: string,
  text: string,
  voice: string,
  outPath: string,
): Promise<{ seconds: number }> {
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model,
    contents: text,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    } as never,
  });

  const anyRes = res as unknown as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
  };
  const parts = anyRes.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  const data = inline?.data;
  if (!data) throw new Error("Gemini TTS returned no audio");

  const pcm = Buffer.from(data, "base64");
  const rate = Number(/rate=(\d+)/.exec(inline?.mimeType ?? "")?.[1] || 24000);
  fs.writeFileSync(outPath, pcmToWav(pcm, rate, 1, 16));
  return { seconds: pcm.length / (rate * 2) };
}
