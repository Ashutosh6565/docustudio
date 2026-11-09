import { NextResponse } from "next/server";
import { listJobs } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = listJobs()
    .slice(0, 50)
    .map((job) => ({
      id: job.id,
      createdAt: job.createdAt,
      title: job.title,
      story: job.input.story.slice(0, 180),
      genre: job.input.genre,
      durationSeconds: job.input.durationSeconds,
      actualDurationSeconds: job.actualDurationSeconds,
      scenes: job.scenes.length,
      aspectRatio: job.input.aspectRatio,
      resolution: job.input.resolution,
      status: job.status,
      progress: job.progress,
      finalUrl: job.finalUrl,
      mock: job.mock,
      provider: job.input.provider ?? "free",
      free: (job.input.provider ?? "free") === "free" && !job.mock,
    }));
  return NextResponse.json({ jobs });
}
