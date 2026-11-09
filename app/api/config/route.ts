import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  const mock = process.env.MOCK === "1";

  return NextResponse.json({
    free: true,
    provider: "free",
    hasKey,
    mock,
    limits: {
      minSeconds: 600,
      maxSeconds: 1200,
      sceneSeconds: 8,
      minSceneSeconds: 6,
      maxSceneSeconds: 30,
    },
    imageModes: [
      { id: "key", label: "Key beats · AI stills where they matter (recommended)" },
      { id: "all", label: "Every scene · slowest, most illustrated" },
      { id: "archive", label: "Archive only · fastest, real photographs" },
    ],
    musicStyles: [
      { id: "drone", label: "Cinematic drone" },
      { id: "pulse", label: "Tense pulse" },
      { id: "warm", label: "Warm strings" },
      { id: "none", label: "No score" },
    ],
    aiMotion: { available: hasKey, note: hasKey ? "Veo image-to-video" : "Needs a Gemini key" },
    smart: {
      default: true,
      gemini: hasKey,
      freeAi: true,
      model: hasKey ? process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash" : process.env.FREE_TEXT_MODEL || "openai",
    },
    // The free stack has no metered calls; kept for UI compatibility.
    costParams: { perImage: 0, per1kTtsChars: 0, perVeoSecond: 0 },
    models: {
      text: {
        default: "smart",
        options: [
          { id: "smart", label: "Smart director · story-aware (Gemini when keyed, else free AI)" },
          { id: "builtin", label: "Built-in director · instant, offline" },
          { id: "pollinations", label: "Pollinations screenwriter · free, rate limited" },
        ],
      },
      image: {
        default: "archive",
        options: [
          { id: "archive", label: "Wikimedia Commons archival · free" },
          { id: "flux", label: "Pollinations Flux · opening still" },
        ],
      },
      tts: {
        default: "edge",
        options: [
          { id: "edge", label: "Edge Neural TTS · free, no key" },
          { id: "sapi", label: "Windows SAPI · offline fallback" },
        ],
      },
      video: {
        default: "procedural",
        options: [
          { id: "procedural", label: "Procedural drone score · ffmpeg" },
          { id: "kenburns", label: "Shot montage · ffmpeg" },
        ],
      },
    },
    voices: [
      { id: "Kore", label: "Kore · warm female" },
      { id: "Leda", label: "Leda · youthful female" },
      { id: "Aoede", label: "Aoede · airy female" },
      { id: "Charon", label: "Charon · deep male" },
      { id: "Puck", label: "Puck · lively male" },
      { id: "Fenrir", label: "Fenrir · gravelled male" },
      { id: "Orus", label: "Orus · authoritative male" },
      { id: "Zephyr", label: "Zephyr · bright narrator" },
    ],
    languages: [
      "English",
      "Hindi",
      "Spanish",
      "French",
      "German",
      "Portuguese",
      "Japanese",
      "Arabic",
      "Italian",
      "Korean",
    ],
    genres: [
      "Investigative",
      "Historical",
      "Nature",
      "True crime",
      "Science",
      "Biographical",
      "Sports",
      "Business",
    ],
    styles: [
      "Cinematic realism",
      "Grainy archival film",
      "Painterly epic",
      "Noir, high contrast",
      "Sunlit naturalism",
      "Retro 1970s documentary",
      "Dark mythic fantasy",
      "Clean modern editorial",
    ],
    durations: [
      { seconds: 600, label: "10 min" },
      { seconds: 900, label: "15 min" },
      { seconds: 1200, label: "20 min" },
    ],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    singleApi: "No key needed · Wikimedia + Edge TTS + ffmpeg",
  });
}
