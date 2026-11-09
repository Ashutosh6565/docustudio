import { NextResponse } from "next/server";
import { getJob } from "@/lib/store";
import { isJobActive, regenerateScene } from "@/lib/documentary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-cut a single scene after an edit. The response returns immediately; the
 * job document carries progress, and the finished film replaces final.mp4.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await context.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= job.scenes.length) {
    return NextResponse.json({ error: "Scene not found" }, { status: 400 });
  }
  if (isJobActive(id)) {
    return NextResponse.json({ error: "This film is still rendering" }, { status: 409 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // An empty body simply re-cuts the scene as-is.
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.slice(0, 2400) : undefined;

  void regenerateScene(id, n, {
    narration: text(body.narration),
    caption: text(body.caption),
    imagePrompt: text(body.imagePrompt),
    imageQuery: text(body.imageQuery),
    forceDraw: body.forceDraw === true,
  }).catch(() => {
    // The job document records the failure for the UI.
  });

  return NextResponse.json({ status: "recutting", scene: n }, { status: 202 });
}
