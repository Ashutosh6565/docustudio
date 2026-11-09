import { NextResponse } from "next/server";
import { getJob } from "@/lib/store";
import { isJobActive, regenerateScenes } from "@/lib/documentary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-cut several scenes in one job, then assemble the film once. Used by the
 * studio when a batch of stills needs replacing.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (isJobActive(id)) {
    return NextResponse.json({ error: "This film is still rendering" }, { status: 409 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const raw = Array.isArray(body.scenes) ? body.scenes : [];
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.slice(0, 2400) : undefined;
  const edits: Array<{
    index: number;
    narration?: string;
    caption?: string;
    imagePrompt?: string;
    imageQuery?: string;
    forceDraw?: boolean;
  }> = [];
  for (const item of raw.slice(0, 40)) {
    const entry = item as Record<string, unknown>;
    const index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0 || index >= job.scenes.length) {
      return NextResponse.json({ error: "Scene not found" }, { status: 400 });
    }
    edits.push({
      index,
      narration: text(entry.narration),
      caption: text(entry.caption),
      imagePrompt: text(entry.imagePrompt),
      imageQuery: text(entry.imageQuery),
      forceDraw: entry.forceDraw === true,
    });
  }
  if (!edits.length) return NextResponse.json({ error: "No scenes to re-cut" }, { status: 400 });

  void regenerateScenes(id, edits).catch(() => {
    // The job document records the failure for the UI.
  });

  return NextResponse.json({ status: "recutting", scenes: edits.map((e) => e.index) }, { status: 202 });
}
