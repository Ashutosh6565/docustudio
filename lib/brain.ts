import { GoogleGenAI } from "@google/genai";

function extractText(res: unknown): string {
  const anyRes = res as {
    text?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (typeof anyRes.text === "string" && anyRes.text.trim()) return anyRes.text;
  const parts = anyRes.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

export function geminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

// The Gemini free tier allows a small number of requests per minute; archive
// reranking and planning share one serialized gate so bursts never 429.
let gate: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function throttle(ms = 4500): Promise<void> {
  const next = gate.then(() => sleep(ms));
  gate = next.catch(() => undefined);
  await next;
}

/**
 * Ask Gemini to pick the candidate whose title best matches a scene's
 * narration. Text-only (titles carry the Commons description), so it is cheap
 * enough for every scene. Returns null to keep the local ranking.
 */
export async function geminiPickImage(
  titles: string[],
  sceneContext: string,
): Promise<number | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || titles.length < 2) return null;
  try {
    await throttle();
    const ai = new GoogleGenAI({ apiKey });
    const prompt = [
      "You are selecting ONE archival photograph for a documentary scene.",
      `Scene narration: "${sceneContext.replace(/\s+/g, " ").slice(0, 600)}"`,
      "Candidate files:",
      ...titles.map((t, i) => `${i}. ${t.slice(0, 200)}`),
      'Choose the file whose title most precisely matches the scene\'s period, place and subject. Prefer actual period photographs. Reject documents, postcards, paintings, cartoons, museum displays, memorials and modern photos unless nothing else fits. Reply JSON only: {"pick": <index>} or {"pick": -1} when none fit.',
    ].join("\n");
    const res = await ai.models.generateContent({
      model: process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    const text = extractText(res).replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text) as { pick?: unknown };
    const pick = Number(parsed.pick);
    return Number.isInteger(pick) && pick >= 0 && pick < titles.length ? pick : null;
  } catch {
    return null;
  }
}
