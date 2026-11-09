import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { saveJob } from "@/lib/store";
import { runJob } from "@/lib/documentary";
import { clampDuration, clampSceneSeconds, sceneCountFor } from "@/lib/estimate";
import type {
  AspectRatio,
  DocumentaryInput,
  ImageMode,
  Job,
  MusicStyle,
  Resolution,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pick(value: unknown, allowed: string[], fallback: string): string {
  const v = String(value ?? "").trim();
  return allowed.includes(v) ? v : fallback;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const story = String(body.story ?? "").trim();
    if (story.length < 20) {
      return NextResponse.json(
        { error: "Tell us the story in at least 20 characters — a paragraph or two works best." },
        { status: 400 },
      );
    }
    if (story.length > 6000) {
      return NextResponse.json({ error: "Story is too long (max 6000 characters)." }, { status: 400 });
    }

    const durationSeconds = clampDuration(Number(body.durationSeconds));
    const sceneSeconds = clampSceneSeconds(body.sceneSeconds);
    const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());
    const provider = body.provider === "gemini" && hasKey ? "gemini" : "free";
    const imageMode: ImageMode =
      body.imageMode === "all" || body.imageMode === "archive" ? body.imageMode : "key";
    const music: MusicStyle =
      body.music === "none" || body.music === "pulse" || body.music === "warm"
        ? body.music
        : "drone";

    const input: DocumentaryInput = {
      story,
      title: String(body.title ?? "").trim().slice(0, 120),
      genre: String(body.genre || "Investigative").slice(0, 40),
      era: String(body.era || "Contemporary").slice(0, 60),
      language: String(body.language || "English").slice(0, 40),
      voice: pick(body.voice, ["Kore", "Leda", "Aoede", "Charon", "Puck", "Fenrir", "Orus", "Zephyr"], "Charon"),
      style: String(body.style || "Cinematic realism").slice(0, 60),
      aspectRatio: (body.aspectRatio === "9:16" ? "9:16" : "16:9") as AspectRatio,
      resolution: (body.resolution === "720p" ? "720p" : "1080p") as Resolution,
      durationSeconds,
      captions: body.captions !== false,
      ambient: music !== "none" && body.ambient !== false,
      heroShots: Boolean(body.heroShots),
      sceneSeconds,
      provider,
      smart: body.smart !== false,
      imageMode,
      music,
      aiMotion: provider === "gemini" && Boolean(body.aiMotion),
      imageModel: String(body.imageModel || "archive"),
      ttsModel: String(body.ttsModel || "edge"),
      textModel: String(body.textModel || "smart"),
      videoModel: String(body.videoModel || "procedural"),
    };

    const sceneCount = sceneCountFor(input.durationSeconds, input.sceneSeconds);
    const mock = process.env.MOCK === "1";

    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      input,
      status: "queued",
      message: "Queued",
      mock,
      title: input.title || "Untitled Documentary",
      logline: "",
      tagline: "",
      chapters: [],
      scenes: Array.from({ length: sceneCount }, (_, index) => ({
        index,
        chapter: 0,
        chapterTitle: "Chapter",
        narration: "",
        caption: "",
        imagePrompt: "",
        status: "queued" as const,
        hero: false,
      })),
      progress: 0,
      log: [
        {
          t: now,
          text: mock
            ? `Mock mode · placeholder narration, stills and sound bed · ~${sceneCount} scenes`
            : provider === "free"
              ? `Free mode · smart director (${hasKey ? "Gemini key detected" : "free AI, no key"}) · free AI scene stills + archival alternates · Edge neural narration · procedural score · ${sceneCount} scenes · $0`
              : `Gemini mode · ${input.textModel} · ${input.imageModel} · ${input.ttsModel} (${input.voice}) · ${sceneCount} scenes`,
        },
      ],
    };

    saveJob(job);
    void runJob(job.id);

    return NextResponse.json({
      jobId: job.id,
      mock,
      provider,
      free: provider === "free",
      scenes: sceneCount,
      durationSeconds,
      singleApi: provider === "free" ? "Free stack" : "Gemini",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
