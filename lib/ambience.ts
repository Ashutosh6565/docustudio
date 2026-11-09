import path from "node:path";
import { generateClip } from "./veo";
import { extractAudio, run } from "./media";
import type { MusicStyle } from "./types";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const RECIPES: Record<Exclude<MusicStyle, "none">, { inputs: string[]; filter: string }> = {
  drone: {
    inputs: [
      "sine=frequency=55:sample_rate=48000",
      "sine=frequency=82.41:sample_rate=48000",
      "sine=frequency=110:sample_rate=48000",
      "anoisesrc=color=brown:amplitude=0.5:sample_rate=48000",
    ],
    filter: [
      "[0:a]volume=0.45,tremolo=f=0.1:d=0.45[p0]",
      "[1:a]volume=0.22,tremolo=f=0.12:d=0.55[p1]",
      "[2:a]volume=0.10[p2]",
      "[3:a]lowpass=f=320,volume=0.30[p3]",
      "[p0][p1][p2][p3]amix=inputs=4:normalize=0,lowpass=f=1600,aecho=0.8:0.55:220|440:0.25|0.15,volume=1.5[mix]",
    ].join(";"),
  },
  pulse: {
    inputs: [
      "sine=frequency=48:sample_rate=48000",
      "sine=frequency=96.5:sample_rate=48000",
      "sine=frequency=220:sample_rate=48000",
      "anoisesrc=color=brown:amplitude=0.45:sample_rate=48000",
    ],
    filter: [
      "[0:a]volume=0.5,tremolo=f=0.82:d=0.72[p0]",
      "[1:a]volume=0.14,tremolo=f=0.82:d=0.6[p1]",
      "[2:a]volume=0.06,tremolo=f=0.1:d=0.4[p2]",
      "[3:a]lowpass=f=260,volume=0.24[p3]",
      "[p0][p1][p2][p3]amix=inputs=4:normalize=0,lowpass=f=1300,aecho=0.8:0.5:180|360:0.18|0.1,volume=1.35[mix]",
    ].join(";"),
  },
  warm: {
    inputs: [
      "sine=frequency=110:sample_rate=48000",
      "sine=frequency=164.81:sample_rate=48000",
      "sine=frequency=220:sample_rate=48000",
      "anoisesrc=color=pink:amplitude=0.4:sample_rate=48000",
    ],
    filter: [
      "[0:a]volume=0.34,tremolo=f=0.1:d=0.25[p0]",
      "[1:a]volume=0.2,tremolo=f=0.1:d=0.3[p1]",
      "[2:a]volume=0.12,tremolo=f=0.1:d=0.2[p2]",
      "[3:a]lowpass=f=1100,volume=0.16[p3]",
      "[p0][p1][p2][p3]amix=inputs=4:normalize=0,lowpass=f=3000,aecho=0.75:0.45:300|600:0.2|0.12,volume=1.25[mix]",
    ].join(";"),
  },
};

/**
 * Free cinematic score synthesized entirely by ffmpeg. No network, no key,
 * no cost. The recipe changes the harmonic bed, not just the volume, so two
 * films do not sound identical.
 */
export async function proceduralAmbience(
  outPath: string,
  seconds = 60,
  style: MusicStyle = "drone",
): Promise<void> {
  const recipe = RECIPES[style === "none" ? "drone" : style] ?? RECIPES.drone;
  const args: string[] = ["-y"];
  for (const input of recipe.inputs) {
    args.push("-f", "lavfi", "-i", `${input}:duration=${seconds}`);
  }
  args.push(
    "-filter_complex",
    recipe.filter,
    "-map",
    "[mix]",
    "-ar",
    "48000",
    "-ac",
    "2",
    outPath,
  );
  await run(FFMPEG, args);
}

/**
 * Generate a subtle cinematic sound bed with Veo (native audio) and extract it
 * to WAV. Returns undefined if the model/key cannot produce audio.
 */
export async function generateAmbience(
  apiKey: string,
  model: string,
  context: string,
  outDir: string,
  log: (msg: string) => void,
): Promise<string | undefined> {
  try {
    const clip = path.join(outDir, "ambience.mp4");
    await generateClip(
      apiKey,
      {
        model,
        prompt:
          `Seamless cinematic ambient soundscape for a documentary about ${context}. ` +
          "Deep atmospheric drone, soft room tone, subtle wind and texture. No dialogue, no melody, no sudden hits.",
        aspectRatio: "16:9",
        resolution: "720p",
        audio: true,
      },
      clip,
      log,
    );
    const wav = path.join(outDir, "ambience.wav");
    await extractAudio(clip, wav);
    return wav;
  } catch (err) {
    log(`Ambience skipped (${(err as Error).message.slice(0, 140)})`);
    return undefined;
  }
}
