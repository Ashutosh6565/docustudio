import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { run } from "./media";
import type { AspectRatio } from "./types";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FREE_IMAGE_ENDPOINT = "https://image.pollinations.ai/prompt";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IMAGE_FALLBACKS = [
  "imagen-4.0-generate-001",
  "imagen-4.0-fast-generate-001",
  "imagen-3.0-generate-002",
];

/**
 * Free, keyless still generation through Pollinations (Flux/SANA).
 * The anonymous tier allows one image every 45 s, so calls queue and space
 * themselves out instead of hammering the endpoint with 402s.
 * Retries with backoff, then crops the bottom-right watermark away.
 */
let imageQueue: Promise<unknown> = Promise.resolve();
let lastImageAt = 0;

async function imageSlot(): Promise<void> {
  const wait = lastImageAt + 47_000 - Date.now();
  if (wait > 0) await sleep(wait);
}

export function generateFreeImage(
  prompt: string,
  dims: { w: number; h: number },
  outPath: string,
  seed: number,
): Promise<void> {
  const task = imageQueue.then(() => generateFreeImageNow(prompt, dims, outPath, seed));
  imageQueue = task.catch(() => undefined);
  return task;
}

async function generateFreeImageNow(
  prompt: string,
  dims: { w: number; h: number },
  outPath: string,
  seed: number,
): Promise<void> {
  const model = process.env.FREE_IMAGE_MODEL || "flux";
  const clean = prompt.replace(/\s+/g, " ").trim().slice(0, 900);
  const url =
    `${FREE_IMAGE_ENDPOINT}/${encodeURIComponent(clean)}` +
    `?width=${dims.w}&height=${dims.h}&model=${encodeURIComponent(model)}` +
    `&seed=${seed}&nologo=true&enhance=true&private=true`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await imageSlot();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) {
        const body = await res.text();
        const limited = /FREE_LIMIT|\b402\b/i.test(body);
        if (!limited && res.status >= 400 && res.status < 500) {
          throw new Error(body.slice(0, 140) || `image endpoint returned ${res.status}`);
        }
        throw new Error(`image endpoint returned ${res.status}`);
      }
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("image/")) {
        const body = await res.text();
        throw new Error(body.slice(0, 140) || "image endpoint returned no image");
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 8_000) throw new Error("image response was too small");

      const raw = outPath.replace(/\.(png|jpe?g|webp)$/i, `_raw${path.extname(outPath) || ".jpg"}`);
      fs.writeFileSync(raw, bytes);
      // Pollinations stamps a small wordmark in the bottom-right corner and
      // Flux sometimes paints a thin light frame: drop the right/bottom band,
      // then shave the edges evenly so no border survives into the montage.
      // Sources come back at 1024x576, so scale to the target instead of
      // letting the montage stretch a 952px frame.
      await run(FFMPEG, [
        "-y",
        "-i",
        raw,
        "-vf",
        `crop=iw*0.93:ih*0.93:0:0,scale=iw*1.08:ih*1.08,crop=iw/1.08:ih/1.08,scale=${dims.w}:${dims.h}:flags=lanczos,unsharp=5:5:0.55:5:5:0`,
        outPath,
      ]);
      fs.rmSync(raw, { force: true });
      lastImageAt = Date.now();
      return;
    } catch (err) {
      lastError = err;
      // A quota 402 is over once the slot is available; other failures back off.
      if (attempt < 3) await sleep(/FREE_LIMIT|\b402\b|rate limit/i.test(String(err)) ? 0 : 6000);
    } finally {
      lastImageAt = Date.now();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Free image generation failed");
}

/**
 * Generate one image with Imagen through the Gemini API and write it to disk.
 * Tries the configured model first, then known-available fallbacks.
 */
export async function generateImage(
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: AspectRatio,
  outPath: string,
): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  const models = [model, ...IMAGE_FALLBACKS.filter((m) => m !== model)];
  let lastError: unknown;

  for (const m of models) {
    try {
      const res = await ai.models.generateImages({
        model: m,
        prompt,
        config: { numberOfImages: 1, aspectRatio } as never,
      });
      const anyRes = res as unknown as {
        generatedImages?: Array<{ image?: { imageBytes?: string } }>;
      };
      const b64 = anyRes.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) throw new Error("No image bytes returned");
      fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Image generation failed");
}
