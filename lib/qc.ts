import fs from "node:fs";
import path from "node:path";
import { run } from "./media";
import { hashDistance, perceptualHash } from "./phash";
import type { Job, QualityCheck, QualityReport } from "./types";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function check(
  id: string,
  label: string,
  status: QualityCheck["status"],
  detail: string,
): QualityCheck {
  return { id, label, status, detail };
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string; bit_rate?: string; size?: string };
}

function parseNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseBlackSeconds(log: string, duration: number): number {
  let total = 0;
  for (const match of log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    // Opening fades and the closing card are intentional, not dropouts.
    if (start < 1.2 || end > duration - 2.5) continue;
    total += Math.max(0, end - start);
  }
  return total;
}

function parseSilenceGaps(log: string): number[] {
  const gaps: number[] = [];
  let start: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      gaps.push(Number(e[1]) - start);
      start = null;
    }
  }
  return gaps;
}

function parseVolume(log: string): { mean: number; max: number } {
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(log);
  return {
    mean: mean ? Number(mean[1]) : 0,
    max: max ? Number(max[1]) : 0,
  };
}

/**
 * Measure the delivered file, not the intentions: stream shape, black frames,
 * loudness, silence, scene completeness, duplicated imagery and subtitle
 * coverage. The report is attached to the job and shown before download.
 */
export async function runQualityControl(
  job: Job,
  finalPath: string,
  dims: { w: number; h: number },
): Promise<QualityReport> {
  const checks: QualityCheck[] = [];
  const metrics: Record<string, number | string> = {};
  const duration = job.actualDurationSeconds ?? 0;
  const contentSeconds = job.scenes.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);

  let probe: ProbeResult = {};
  try {
    probe = JSON.parse(
      await run(FFPROBE, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        finalPath,
      ]),
    ) as ProbeResult;
  } catch {
    // The checks below degrade to fails with an explicit detail.
  }

  const video = probe.streams?.find((s) => s.codec_type === "video");
  const audio = probe.streams?.find((s) => s.codec_type === "audio");
  const realDuration = parseNumber(probe.format?.duration) || duration;
  const fps = video?.r_frame_rate ? Number(video.r_frame_rate.split("/")[0]) / Number(video.r_frame_rate.split("/")[1]) : 0;

  metrics.duration = Number(realDuration.toFixed(2));
  metrics.resolution = `${video?.width ?? 0}x${video?.height ?? 0}`;
  metrics.fps = Number(fps.toFixed(2));
  metrics.bitrateKbps = Math.round(parseNumber(probe.format?.bit_rate) / 1000);

  checks.push(
    realDuration >= 600
      ? check("duration", "Run time", "pass", `${realDuration.toFixed(1)}s · target ≥ 600s`)
      : realDuration >= 595
        ? check("duration", "Run time", "warn", `${realDuration.toFixed(1)}s · within 5s of the 600s minimum`)
        : check("duration", "Run time", "fail", `${realDuration.toFixed(1)}s · under the 600s minimum`),
  );

  checks.push(
    video && video.width === dims.w && video.height === dims.h
      ? check("resolution", "Frame size", "pass", `${video.width}×${video.height}`)
      : check(
          "resolution",
          "Frame size",
          "fail",
          `expected ${dims.w}×${dims.h}, got ${video?.width ?? 0}×${video?.height ?? 0}`,
        ),
  );

  checks.push(
    Math.abs(fps - 24) < 0.05
      ? check("fps", "Frame rate", "pass", "24 fps")
      : check("fps", "Frame rate", "warn", `${fps.toFixed(2)} fps`),
  );

  checks.push(
    video?.codec_name === "h264" && audio?.codec_name === "aac"
      ? check("codecs", "Codecs", "pass", "H.264 video · AAC audio")
      : check(
          "codecs",
          "Codecs",
          "warn",
          `${video?.codec_name ?? "none"} video · ${audio?.codec_name ?? "none"} audio`,
        ),
  );

  checks.push(
    audio
      ? check(
          "audio",
          "Audio track",
          "pass",
          `${audio.sample_rate ?? "?"} Hz · ${audio.channels ?? 0} ch`,
        )
      : check("audio", "Audio track", "fail", "no audio stream"),
  );

  // Scene assets.
  const missing = job.scenes.filter((scene) => {
    const videoFile = scene.videoFile
      ? path.join(process.cwd(), "public", scene.videoFile.replace(/^\//, ""))
      : "";
    return !scene.imageFile || !scene.audioFile || !videoFile || !fs.existsSync(videoFile);
  });
  checks.push(
    missing.length === 0
      ? check("scenes", "Scene completeness", "pass", `${job.scenes.length}/${job.scenes.length} scenes have still, voice and cut`)
      : check(
          "scenes",
          "Scene completeness",
          "fail",
          `${missing.length} scene(s) missing assets: ${missing.slice(0, 6).map((s) => s.index + 1).join(", ")}`,
        ),
  );

  const shots = job.scenes.reduce((sum, s) => sum + (s.shotCount ?? 0), 0);
  metrics.scenes = job.scenes.length;
  metrics.shots = shots;
  checks.push(
    shots >= job.scenes.length * 2.5
      ? check("shots", "Cut density", "pass", `${shots} shots across ${job.scenes.length} scenes`)
      : check("shots", "Cut density", "warn", `${shots} shots · long takes dominate`),
  );

  checks.push(
    job.chapters.length >= 3
      ? check("chapters", "Chapter structure", "pass", `${job.chapters.length} chapters`)
      : check("chapters", "Chapter structure", "warn", `${job.chapters.length} chapters`),
  );

  // Duplicate compositions: the single strongest cause of a slideshow feel.
  const hashes: { index: number; hash: string }[] = [];
  for (const scene of job.scenes) {
    const hash =
      scene.imageHash ??
      (scene.imageFile
        ? await perceptualHash(path.join(process.cwd(), "public", scene.imageFile.replace(/^\//, "")))
        : undefined);
    if (hash) hashes.push({ index: scene.index, hash });
  }
  let duplicates = 0;
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      if (hashDistance(hashes[i].hash, hashes[j].hash) <= 8) duplicates++;
    }
  }
  metrics.duplicatePairs = duplicates;
  checks.push(
    duplicates === 0
      ? check("repeats", "Image repetition", "pass", "no near-duplicate stills")
      : duplicates <= Math.max(1, Math.floor(job.scenes.length * 0.1))
        ? check("repeats", "Image repetition", "warn", `${duplicates} near-duplicate pair(s)`)
        : check("repeats", "Image repetition", "fail", `${duplicates} near-duplicate pair(s) — regenerate flagged scenes`),
  );

  // Subtitle coverage and timing.
  if (job.input.captions) {
    const withCues = job.scenes.filter((s) => (s.subtitleCues?.length ?? 0) > 0).length;
    const pct = job.scenes.length ? withCues / job.scenes.length : 0;
    checks.push(
      pct >= 0.9
        ? check("subtitles", "Subtitle timing", "pass", `${withCues}/${job.scenes.length} scenes carry timed cues`)
        : check(
            "subtitles",
            "Subtitle timing",
            pct >= 0.5 ? "warn" : "fail",
            `${withCues}/${job.scenes.length} scenes have word-timed cues`,
          ),
    );

    // A cue that starts after the words or runs past the scene is out of sync
    // even when the scene "has" cues.
    const desynced = job.scenes.filter((scene) => {
      const cues = scene.subtitleCues ?? [];
      if (!cues.length) return false;
      const end = cues[cues.length - 1].end;
      const duration = scene.durationSeconds ?? 0;
      return cues[0].start > 2.5 || (duration > 1 && end > duration + 0.8);
    });
    checks.push(
      desynced.length === 0
        ? check("subtitle-sync", "Subtitle sync", "pass", "cues stay inside their scene audio")
        : check(
            "subtitle-sync",
            "Subtitle sync",
            desynced.length <= 2 ? "warn" : "fail",
            `${desynced.length} scene(s) have cues outside their audio: ${desynced
              .slice(0, 6)
              .map((s) => s.index + 1)
              .join(", ")}`,
          ),
    );
  }

  // Black frames and audio dropouts.
  try {
    const blackLog = await run(FFMPEG, [
      "-hide_banner",
      "-i",
      finalPath,
      "-vf",
      "blackdetect=d=0.15:pix_th=0.08",
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const black = parseBlackSeconds(blackLog, realDuration);
    metrics.blackSeconds = Number(black.toFixed(2));
    checks.push(
      black <= 1.2
        ? check("black", "Black frames", "pass", `${black.toFixed(2)}s of unplanned black`)
        : check("black", "Black frames", "warn", `${black.toFixed(2)}s of black outside the fades`),
    );
  } catch {
    checks.push(check("black", "Black frames", "warn", "black-frame scan unavailable"));
  }

  try {
    const volumeLog = await run(FFMPEG, [
      "-hide_banner",
      "-i",
      finalPath,
      "-t",
      Math.max(1, contentSeconds).toFixed(2),
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const volume = parseVolume(volumeLog);
    metrics.meanVolumeDb = volume.mean;
    metrics.maxVolumeDb = volume.max;
    checks.push(
      volume.max <= -0.5
        ? check("clipping", "Audio levels", "pass", `mean ${volume.mean} dB · peak ${volume.max} dB`)
        : volume.max <= -0.1
          ? check("clipping", "Audio levels", "warn", `peak ${volume.max} dB is close to clipping`)
          : check("clipping", "Audio levels", "fail", `peak ${volume.max} dB clips`),
    );
  } catch {
    checks.push(check("clipping", "Audio levels", "warn", "level scan unavailable"));
  }

  if (job.input.ambient) {
    try {
      const silenceLog = await run(FFMPEG, [
        "-hide_banner",
        "-i",
        finalPath,
        "-t",
        Math.max(1, contentSeconds).toFixed(2),
        "-af",
        "silencedetect=noise=-48dB:d=2.2",
        "-f",
        "null",
        "-",
      ]);
      const gaps = parseSilenceGaps(silenceLog);
      checks.push(
        gaps.length === 0
          ? check("gaps", "Audio continuity", "pass", "no silent gaps longer than 2.2s")
          : check("gaps", "Audio continuity", "warn", `${gaps.length} silent stretch(es) between lines`),
      );
    } catch {
      // Score continuity is a soft check.
    }
  }

  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  return {
    passed: !failed,
    checkedAt: Date.now(),
    checks,
    metrics: {
      ...metrics,
      warnings: warned ? "yes" : "no",
      artDirection: `${job.input.resolution} · ${job.input.imageMode ?? "key"} stills · ${
        job.input.music ?? "drone"
      } score`,
    },
  };
}
