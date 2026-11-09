import { GoogleGenAI } from "@google/genai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClipRequest {
  model: string;
  prompt: string;
  aspectRatio: "16:9" | "9:16";
  resolution: "720p" | "1080p";
  audio: boolean;
  startImage?: { imageBytes: string; mimeType: string };
}

/**
 * Generate one Veo clip and download it to `outPath`.
 *
 * Veo is a long-running operation: we submit, poll until done, then download.
 * Optional/experimental parameters are dropped automatically if the API
 * rejects them, so a model/feature mismatch degrades instead of failing.
 */
export async function generateClip(
  apiKey: string,
  req: ClipRequest,
  outPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });

  const baseConfig: Record<string, unknown> = {
    aspectRatio: req.aspectRatio,
    resolution: req.resolution,
    numberOfVideos: 1,
  };
  const richConfig: Record<string, unknown> = { ...baseConfig, generateAudio: req.audio };

  const buildParams = (config: Record<string, unknown>) => {
    const params: Record<string, unknown> = { model: req.model, prompt: req.prompt, config };
    if (req.startImage) params.image = req.startImage;
    return params;
  };

  let operation = await submitWithFallback(ai, buildParams, baseConfig, richConfig, log);

  let attempts = 0;
  while (!operation.done) {
    if (++attempts > 180) throw new Error("Veo generation timed out after ~30 minutes");
    await sleep(10000);
    operation = await ai.operations.getVideosOperation({ operation });
    log(`Waiting on Veo… (${attempts * 10}s)`);
  }

  const anyOp = operation as unknown as {
    error?: { message?: string };
    response?: { generatedVideos?: Array<{ video?: unknown }> };
  };
  if (anyOp.error?.message) throw new Error(anyOp.error.message);

  const video = anyOp.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error("Veo returned no video for this shot");

  await ai.files.download({ file: video as never, downloadPath: outPath });
}

async function submitWithFallback(
  ai: GoogleGenAI,
  buildParams: (config: Record<string, unknown>) => Record<string, unknown>,
  baseConfig: Record<string, unknown>,
  richConfig: Record<string, unknown>,
  log: (msg: string) => void,
) {
  try {
    return await ai.models.generateVideos(buildParams(richConfig) as never);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Retrying with minimal parameters (${message.slice(0, 120)})`);
    return await ai.models.generateVideos(buildParams(baseConfig) as never);
  }
}
