export const MIN_SCENE_SECONDS = 6;
export const MAX_SCENE_SECONDS = 30;
export const DEFAULT_SCENE_SECONDS = 8;

/**
 * Scene density for a 10-minute film is ~60 beats, each cut into several
 * shots. Going above ~100 scenes makes every narration line shorter than a
 * breath; going below ~40 turns the edit back into a slideshow.
 */
export function sceneCountFor(durationSeconds: number, sceneSeconds: number): number {
  const raw = Math.round(durationSeconds / Math.max(MIN_SCENE_SECONDS, sceneSeconds));
  return Math.min(100, Math.max(12, raw));
}

export function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 600;
  return Math.min(1200, Math.max(600, Math.round(value)));
}

export function clampSceneSeconds(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCENE_SECONDS;
  return Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, Math.round(n)));
}

/** Seconds of narration each scene can hold once its tail and the outro fit. */
const END_CARD_SECONDS = 3;
const SCENE_TAIL_SECONDS = 1.2;
// Documentaries read at roughly 1.7 words per second with deliberate pauses.
const WORDS_PER_SECOND = 1.72;

/**
 * Word budget for one scene. The old fixed floor of 30 words made a 60-scene
 * film run ~15 minutes, so the assembler trimmed the last scenes and the
 * credits to hit the requested run time. The budget now scales with the scene.
 */
export function wordsPerScene(durationSeconds: number, sceneCount: number): number {
  const perScene =
    (durationSeconds - END_CARD_SECONDS) / Math.max(1, sceneCount) - SCENE_TAIL_SECONDS;
  return Math.min(140, Math.max(8, Math.round(perScene * WORDS_PER_SECOND)));
}
