import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AspectRatio, Resolution } from "./types";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
];

export function findFont(): string | undefined {
  return FONT_CANDIDATES.find((f) => {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  });
}

export function run(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(
        new Error(
          `Could not run "${bin}": ${err.message}. Install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH in .env.`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`"${bin}" exited with ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

/** Run a binary and return raw stdout (perceptual hashes, probe JSON). */
export function runBuffer(bin: string, args: string[], cwd?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(new Error(`Could not run "${bin}": ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`"${bin}" exited with ${code}\n${stderr.slice(-1200)}`));
    });
  });
}

export function dimsFor(aspect: AspectRatio, resolution: Resolution): { w: number; h: number } {
  const tall = aspect === "9:16";
  if (resolution === "1080p") return tall ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  return tall ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const out = await run(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ]);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const out = await run(FFPROBE, [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      file,
    ]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function extractAudio(inPath: string, outPath: string): Promise<void> {
  await run(FFMPEG, ["-y", "-i", inPath, "-vn", "-ac", "1", "-ar", "48000", outPath]);
}

export function wrapText(text: string, maxChars: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  if (lines.length > shown.length) shown[shown.length - 1] = `${shown[shown.length - 1].replace(/[.,;:!?]+$/, "")}…`;
  return shown.join("\n");
}

/**
 * ffmpeg's drawtext chokes on the Windows drive colon in fontfile paths, so we
 * stage the font inside the working directory and reference it by bare name.
 */
function localFont(cwd: string): string | undefined {
  const font = findFont();
  if (!font) return undefined;
  const staged = path.join(cwd, "_font.ttf");
  try {
    if (!fs.existsSync(staged)) fs.copyFileSync(font, staged);
    return path.basename(staged);
  } catch {
    return undefined;
  }
}

/**
 * Render a still image into a moving clip (Ken Burns) over its narration audio.
 * Captions are burned in when a caption file is supplied; if the drawtext filter
 * fails (missing font/lib), the scene is retried cleanly without captions.
 */
export async function kenBurnsScene(opts: {
  image: string;
  audio: string;
  outPath: string;
  duration: number;
  dims: { w: number; h: number };
  cwd: string;
  captionFile?: string;
  /** ASS subtitle sidecar for word-accurate captions. */
  subtitleFile?: string;
  /** Archival monochrome grade for historical eras. */
  mono?: boolean;
  fps?: number;
}): Promise<void> {
  const { image, audio, outPath, duration, dims, cwd } = opts;
  const fps = opts.fps ?? 24;
  const { w, h } = dims;

  const buildFilter = (withCaption: boolean) => {
    let vf = [
      `scale=${Math.max(w * 2, 1280)}:${Math.max(h * 2, 720)}:force_original_aspect_ratio=increase`,
      `crop=${w * 2}:${h * 2}`,
      `zoompan=z='min(1+0.00045*on,1.22)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`,
      opts.mono ? "hue=s=0,colorbalance=rs=0.04:gs=0.015:bs=-0.04" : "",
      "eq=contrast=1.07:saturation=0.9:brightness='-0.015+0.003*sin(t*3.7)':eval=frame",
      "unsharp=5:5:0.25",
      "noise=alls=5:allf=t+u",
      "vignette=PI/5.5",
      "setsar=1",
    ]
      .filter(Boolean)
      .join(",");
    if (withCaption && opts.subtitleFile) {
      vf += `,ass=${opts.subtitleFile}:fontsdir=.`;
    } else if (withCaption && opts.captionFile) {
      const font = localFont(cwd);
      if (font) {
        const size = Math.round(h * 0.032);
        vf += `,drawtext=fontfile=${font}:textfile=${opts.captionFile}:fontcolor=white:fontsize=${size}:line_spacing=8:box=1:boxcolor=black@0.45:boxborderw=16:x=(w-text_w)/2:y=h-th-${Math.round(h * 0.09)}`;
      }
    }
    return vf + ",format=yuv420p";
  };

  const tryRender = async (vf: string) => {
    await run(
      FFMPEG,
      [
        "-y",
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-i",
        image,
        "-i",
        audio,
        "-vf",
        vf,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-t",
        duration.toFixed(3),
        "-r",
        String(fps),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-ac",
        "2",
        outPath,
      ],
      cwd,
    );
  };

  try {
    await tryRender(buildFilter(Boolean(opts.captionFile || opts.subtitleFile)));
  } catch (err) {
    if (opts.captionFile || opts.subtitleFile) {
      await tryRender(buildFilter(false));
    } else {
      throw err;
    }
  }
}

export type ShotMotion =
  | "pushIn"
  | "pullOut"
  | "dollyIn"
  | "dollyOut"
  | "panLeft"
  | "panRight"
  | "tiltUp"
  | "tiltDown"
  | "craneUp"
  | "craneDown"
  | "truckLeft"
  | "truckRight"
  | "handheld"
  | "sway"
  | "rackFocus";

export interface SceneShot {
  type: "image" | "video";
  src: string;
}

/**
 * A scene cut as a run of short moving shots with hard cuts between them.
 * Stills get a different framing and camera move per shot, so a single source
 * image never repeats the same composition; licensed video clips can be mixed
 * in as real moving shots.
 */
export async function sceneMontage(opts: {
  shots: SceneShot[];
  motions: ShotMotion[];
  shotDurations: number[];
  audio: string;
  outPath: string;
  duration: number;
  dims: { w: number; h: number };
  cwd: string;
  titleFile?: string;
  /** ASS subtitle sidecar, relative to cwd. */
  subtitleFile?: string;
  chapterFile?: string;
  /** Archival monochrome grade for historical eras. */
  mono?: boolean;
  fps?: number;
  fadeIn?: number;
  fadeOut?: number;
}): Promise<void> {
  const { w, h } = opts.dims;
  const fps = opts.fps ?? 24;
  const count = Math.min(opts.motions.length, opts.shotDurations.length, opts.shots.length);
  if (count < 1) throw new Error("sceneMontage needs at least one shot");

  // Alternate framings keep repeated source images from reading as repeats.
  const FRAMING = [
    { crop: 1, x: 0, y: 0 },
    { crop: 0.84, x: 0.015, y: 0.03 },
    { crop: 0.84, x: 0.145, y: 0.03 },
    { crop: 0.74, x: 0.1, y: 0.07 },
    { crop: 0.9, x: 0.05, y: 0.0 },
  ];

  const motionFilter = (motion: ShotMotion, frames: number): string => {
    const f = Math.max(1, frames - 1);
    const cx = "x='iw/2-(iw/zoom/2)'";
    const cy = "y='ih/2-(ih/zoom/2)'";
    switch (motion) {
      case "pullOut":
        return `zoompan=z='1.2-0.16*min(on/${f},1)':d=1:${cx}:${cy}:s=${w}x${h}:fps=${fps}`;
      case "dollyIn":
        return (
          `zoompan=z='1.04+0.12*min(on/${f},1)':d=1:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)-ih*0.01*min(on/${f},1)':s=${w}x${h}:fps=${fps}`
        );
      case "dollyOut":
        return (
          `zoompan=z='1.16-0.1*min(on/${f},1)':d=1:` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+ih*0.01*min(on/${f},1)':s=${w}x${h}:fps=${fps}`
        );
      case "panLeft":
        return `zoompan=z='1.16':d=1:x='(iw-iw/zoom)*(1-min(on/${f},1))':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
      case "panRight":
        return `zoompan=z='1.16':d=1:x='(iw-iw/zoom)*min(on/${f},1)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
      case "truckLeft":
        return `zoompan=z='1.1':d=1:x='(iw-iw/zoom)*(0.95-0.9*min(on/${f},1))':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
      case "truckRight":
        return `zoompan=z='1.1':d=1:x='(iw-iw/zoom)*(0.05+0.9*min(on/${f},1))':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
      case "tiltUp":
        return `zoompan=z='1.16':d=1:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-min(on/${f},1))':s=${w}x${h}:fps=${fps}`;
      case "tiltDown":
        return `zoompan=z='1.16':d=1:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*min(on/${f},1)':s=${w}x${h}:fps=${fps}`;
      case "craneUp":
        return (
          `zoompan=z='1.06+0.08*min(on/${f},1)':d=1:` +
          `x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-0.85*min(on/${f},1))':s=${w}x${h}:fps=${fps}`
        );
      case "craneDown":
        return (
          `zoompan=z='1.06+0.08*min(on/${f},1)':d=1:` +
          `x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(0.85*min(on/${f},1))':s=${w}x${h}:fps=${fps}`
        );
      case "handheld":
        return (
          `zoompan=z='1.08+0.04*min(on/${f},1)':d=1:` +
          `x='iw/2-(iw/zoom/2)+6*sin(on/4.7)':y='ih/2-(ih/zoom/2)+5*cos(on/6.3)':s=${w}x${h}:fps=${fps}`
        );
      case "sway":
        return (
          `zoompan=z='1.14':d=1:` +
          `x='(iw-iw/zoom)*(0.5+0.32*sin(2*PI*on/${f}))':y='(ih-ih/zoom)*(0.5+0.08*cos(2*PI*on/${f}))':s=${w}x${h}:fps=${fps}`
        );
      case "rackFocus":
      default:
        return `zoompan=z='1.03+0.12*min(on/${f},1)':d=1:${cx}:${cy}:s=${w}x${h}:fps=${fps}`;
    }
  };

  const build = (withText: boolean) => {
    const args: string[] = ["-y"];
    const filters: string[] = [];
    const scaleW = Math.max(w * 2, 1280);
    const scaleH = Math.max(h * 2, 720);

    for (let k = 0; k < count; k++) {
      const dur = Math.max(0.6, opts.shotDurations[k]);
      const shot = opts.shots[k];
      const frames = Math.round(dur * fps);
      if (shot.type === "video") {
        // Seek a little into the clip so each cut lands on motion, not a logo.
        args.push(
          "-stream_loop",
          "-1",
          "-ss",
          (0.25 + (k % 3) * 0.45).toFixed(2),
          "-t",
          dur.toFixed(3),
          "-i",
          shot.src,
        );
      } else {
        args.push("-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", shot.src);
      }
    }

    for (let k = 0; k < count; k++) {
      const dur = Math.max(0.6, opts.shotDurations[k]);
      const shot = opts.shots[k];
      const frames = Math.round(dur * fps);
      const frame = FRAMING[(k + (shot.type === "video" ? 1 : 0)) % FRAMING.length];
      const cw = Math.round((scaleW * frame.crop) / 2) * 2;
      const chh = Math.round((scaleH * frame.crop) / 2) * 2;
      const cx = Math.round(Math.min(scaleW - cw, scaleW * frame.x) / 2) * 2;
      const cy = Math.round(Math.min(scaleH - chh, scaleH * frame.y) / 2) * 2;
      let base =
        `[${k}:v]fps=${fps},` +
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,` +
        `crop=${scaleW}:${scaleH},setsar=1`;
      if (shot.type === "image") {
        base += `,crop=${cw}:${chh}:${cx}:${cy}`;
      }

      const motion = opts.motions[k];
      if (motion === "rackFocus" && shot.type === "image" && dur >= 1.6) {
        const out = k % 2 === 0;
        const expr = out
          ? "A*(1-min(T/1.2,1))+B*min(T/1.2,1)"
          : "A*min(T/1.2,1)+B*(1-min(T/1.2,1))";
        const zoom = `zoompan=z='1.05+0.05*min(on/${Math.max(1, frames - 1)},1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;
        filters.push(`${base},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[r${k}]`);
        filters.push(`[r${k}]split=2[ra${k}][rb${k}]`);
        filters.push(`[rb${k}]boxblur=5:2[rbl${k}]`);
        filters.push(
          `[ra${k}][rbl${k}]blend=all_expr='${expr}',${zoom},` +
            `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[v${k}]`,
        );
      } else {
        const move = motionFilter(motion === "rackFocus" ? "pushIn" : motion, frames);
        filters.push(
          `${base},${move},trim=duration=${dur.toFixed(3)},` +
            `setpts=PTS-STARTPTS,setsar=1[v${k}]`,
        );
      }
    }

    // The narration is the last input; shots above are inputs 0..count-1.
    args.push("-i", opts.audio);
    const audioIndex = count;

    const concatInputs = Array.from({ length: count }, (_, k) => `[v${k}]`).join("");
    filters.push(`${concatInputs}concat=n=${count}:v=1:a=0[vc]`);

    let chain =
      (opts.mono ? "hue=s=0,colorbalance=rs=0.04:gs=0.015:bs=-0.04," : "") +
      "eq=contrast=1.09:saturation=0.88:brightness='-0.012+0.0035*sin(t*3.3)':eval=frame" +
      `,unsharp=5:5:0.3,noise=alls=${h >= 1000 ? 4 : 5}:allf=t+u,vignette=PI/5.5`;

    const font = withText ? localFont(opts.cwd) : undefined;
    if (font) {
      if (opts.titleFile) {
        chain +=
          `,drawtext=fontfile=${font}:textfile=${opts.titleFile}:fontcolor=white:fontsize=${Math.round(h * 0.05)}` +
          `:line_spacing=14:x=(w-text_w)/2:y=(h-th)/2-70` +
          `:alpha='if(lt(t,0.6),t/0.6,if(lt(t,3),1,max(0,(3.9-t)/0.9)))':enable='between(t,0.15,3.95)'`;
      }
      if (opts.chapterFile) {
        chain +=
          `,drawtext=fontfile=${font}:textfile=${opts.chapterFile}:fontcolor=white:fontsize=${Math.round(h * 0.026)}` +
          `:box=1:boxcolor=black@0.55:boxborderw=14:x=${Math.round(w * 0.06)}:y=${Math.round(h * 0.09)}` +
          `:alpha='if(lt(t,1),max(0,(t-0.6)/0.4),if(lt(t,4.8),1,max(0,(5.6-t)/0.8)))':enable='between(t,0.6,5.6)'`;
      }
      if (opts.subtitleFile) {
        chain += `,ass=${opts.subtitleFile}:fontsdir=.`;
      }
    }
    if (opts.fadeIn && opts.fadeIn > 0) chain += `,fade=t=in:st=0:d=${opts.fadeIn}`;
    if (opts.fadeOut && opts.fadeOut > 0) {
      chain += `,fade=t=out:st=${Math.max(0, opts.duration - opts.fadeOut).toFixed(3)}:d=${opts.fadeOut}`;
    }

    filters.push(`[vc]${chain},format=yuv420p[vout]`);
    filters.push(
      `[${audioIndex}:a:0]apad,atrim=duration=${opts.duration.toFixed(3)},asetpts=PTS-STARTPTS[aud]`,
    );

    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[vout]",
      "-map",
      "[aud]",
      "-t",
      opts.duration.toFixed(3),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      h >= 1000 ? "19" : "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-ac",
      "2",
      opts.outPath,
    );
    return args;
  };

  try {
    await run(FFMPEG, build(true), opts.cwd);
  } catch (err) {
    const hasText = Boolean(opts.titleFile || opts.subtitleFile || opts.chapterFile);
    if (hasText) {
      try {
        await run(FFMPEG, build(false), opts.cwd);
        return;
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

export async function normalizeClip(
  inPath: string,
  outPath: string,
  seconds: number,
  dims: { w: number; h: number },
): Promise<void> {
  const hasAudio = await probeHasAudio(inPath);
  const { w, h } = dims;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=24`;
  const args = ["-y", "-i", inPath];
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push("-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (hasAudio) args.push("-map", "0:v:0", "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  else args.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  args.push("-t", String(seconds), outPath);
  await run(FFMPEG, args);
}

export async function makeTitleCard(opts: {
  title: string;
  subtitle: string;
  outPath: string;
  dims: { w: number; h: number };
  seconds: number;
  cwd: string;
}): Promise<void> {
  const { w, h } = opts.dims;
  const fps = 24;
  const font = findFont();
  const source = `color=c=0x08080e:s=${w}x${h}:d=${opts.seconds}:r=${fps}`;
  const silent = "anullsrc=channel_layout=stereo:sample_rate=48000";
  const encode = ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-t", String(opts.seconds), opts.outPath];
  try {
    if (!font) throw new Error("no font");
    fs.writeFileSync(
      path.join(opts.cwd, "title.txt"),
      wrapText(opts.title.slice(0, 120), Math.max(14, Math.round(w / 45))) + "\n",
    );
    fs.writeFileSync(
      path.join(opts.cwd, "subtitle.txt"),
      wrapText(opts.subtitle.slice(0, 600), Math.max(24, Math.round(w * 0.062))) + "\n",
    );
    const staged = localFont(opts.cwd);
    if (!staged) throw new Error("no font");
    const vf = [
      `drawtext=fontfile=${staged}:textfile=title.txt:fontcolor=white:fontsize=${Math.round(w * 0.055)}:line_spacing=14:x=(w-text_w)/2:y=(h-th)/2-90`,
      `drawtext=fontfile=${staged}:textfile=subtitle.txt:fontcolor=0x9a9aa8:fontsize=${Math.round(w * 0.02)}:line_spacing=8:x=(w-text_w)/2:y=(h)/2+30`,
      "format=yuv420p",
      "fade=t=in:st=0:d=0.8",
      `fade=t=out:st=${Math.max(0, opts.seconds - 0.8)}:d=0.8`,
    ].join(",");
    await run(
      FFMPEG,
      ["-y", "-f", "lavfi", "-i", source, "-f", "lavfi", "-i", silent, "-vf", vf, ...encode],
      opts.cwd,
    );
  } catch {
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", source, "-f", "lavfi", "-i", silent, ...encode]);
  }
}

export async function makeEndCard(opts: {
  outPath: string;
  dims: { w: number; h: number };
  seconds: number;
  title?: string;
  subtitle?: string;
  credit?: string;
  backdrop?: string;
  cwd: string;
}): Promise<void> {
  const { w, h } = opts.dims;
  const fps = 24;
  const font = findFont();
  const source = `color=c=0x08080e:s=${w}x${h}:d=${opts.seconds}:r=${fps}`;
  const silent = "anullsrc=channel_layout=stereo:sample_rate=48000";
  const encode = ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-t", String(opts.seconds), opts.outPath];
  const wrap = (value: string, width: number) => {
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > width) {
        lines.push(line);
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }
    if (line) lines.push(line);
    return lines.join("\n");
  };
  try {
    if (!font) throw new Error("no font");
    const staged = localFont(opts.cwd);
    if (!staged) throw new Error("no font");
    const textFiles: string[] = [];
    const filters: string[] = [];
    const addText = (name: string, value: string, size: number, color: string, y: string, lineSpacing = 8, width = 64) => {
      if (!value.trim()) return;
      fs.writeFileSync(path.join(opts.cwd, name), wrap(value, width));
      textFiles.push(name);
      filters.push(
        `drawtext=fontfile=${staged}:textfile=${name}:fontcolor=${color}:fontsize=${size}:line_spacing=${lineSpacing}:x=(w-text_w)/2:y=${y}`,
      );
    };
    addText("end_title.txt", opts.title || "The End", Math.round(w * 0.042), "white", "(h-th)/2-140", 12, 42);
    addText("end_sub.txt", opts.subtitle || "", Math.round(w * 0.019), "0xd7d7e2", "(h-th)/2", 8, 58);
    addText("end_credit.txt", opts.credit || "", Math.round(w * 0.0115), "0x9a9aa8", "h-72", 6, 96);
    const backdrop = opts.backdrop && fs.existsSync(opts.backdrop) ? opts.backdrop : "";
    const background = backdrop
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},zoompan=z='min(1+0.00035*on,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps},eq=brightness=-0.16:saturation=0.55`
      : "";
    const vf = [
      background,
      ...filters,
      "format=yuv420p",
      "fade=t=in:st=0:d=1.2",
      `fade=t=out:st=${Math.max(0, opts.seconds - 1.6)}:d=1.6`,
    ]
      .filter(Boolean)
      .join(",");
    const inputs = backdrop
      ? ["-loop", "1", "-framerate", String(fps), "-i", backdrop, "-f", "lavfi", "-i", silent]
      : ["-f", "lavfi", "-i", source, "-f", "lavfi", "-i", silent];
    await run(FFMPEG, ["-y", ...inputs, "-vf", vf, ...encode], opts.cwd);
    for (const name of textFiles) fs.rmSync(path.join(opts.cwd, name), { force: true });
  } catch {
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", source, "-f", "lavfi", "-i", silent, ...encode]);
  }
}

export async function concatVideos(files: string[], outPath: string, cwd?: string): Promise<void> {
  const listPath = outPath + ".txt";
  const body = files.map((f) => `file '${path.basename(f).replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listPath, body + "\n");
  await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", path.basename(listPath), "-c", "copy", outPath], cwd);
}

interface Loudness {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/**
 * EBU R128 measure pass. ffmpeg prints the JSON report on stderr; -inf (pure
 * silence) is reported as a non-finite number, in which case we fall back to
 * single-pass normalisation.
 */
async function measureLoudness(file: string): Promise<Loudness | null> {
  try {
    const out = await run(FFMPEG, [
      "-hide_banner",
      "-i",
      file,
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f",
      "null",
      "-",
    ]);
    const start = out.lastIndexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
    const value = (key: string) => String(parsed[key] ?? "-inf");
    const measured = {
      input_i: value("input_i"),
      input_tp: value("input_tp"),
      input_lra: value("input_lra"),
      input_thresh: value("input_thresh"),
      target_offset: value("target_offset"),
    };
    if (![measured.input_i, measured.input_tp, measured.input_lra, measured.input_thresh].every((v) => Number.isFinite(Number(v)))) {
      return null;
    }
    return measured;
  } catch {
    return null;
  }
}

/**
 * Mix the score under the narration with a real sidechain duck, then normalise
 * the programme to the -16 LUFS / -1.5 dBTP that online video expects. The bed
 * drops whenever a voice is present instead of competing with it at a fixed
 * volume.
 */
export async function mixAmbience(opts: {
  video: string;
  ambience?: string;
  outPath: string;
  seconds: number;
  volume?: number;
}): Promise<void> {
  const raw = opts.outPath.replace(/\.mp4$/i, ".raw.wav");
  if (opts.ambience) {
    const vol = opts.volume ?? 0.42;
    const filter =
      `[1:a]volume=${vol},highpass=f=35[bed];` +
      `[bed][0:a]sidechaincompress=threshold=0.035:ratio=8:attack=18:release=420[duck];` +
      `[0:a][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`;
    await run(FFMPEG, [
      "-y",
      "-i",
      opts.video,
      "-stream_loop",
      "-1",
      "-i",
      opts.ambience,
      "-filter_complex",
      filter,
      "-map",
      "[mix]",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      opts.seconds.toFixed(3),
      raw,
    ]);
  } else {
    await run(FFMPEG, [
      "-y",
      "-i",
      opts.video,
      "-vn",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      opts.seconds.toFixed(3),
      raw,
    ]);
  }

  const measured = await measureLoudness(raw);
  const norm = measured
    ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
    : "loudnorm=I=-16:TP=-1.5:LRA=11";

  try {
    await run(FFMPEG, [
      "-y",
      "-i",
      opts.video,
      "-i",
      raw,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-af",
      norm,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      opts.seconds.toFixed(3),
      opts.outPath,
    ]);
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

export async function trimTo(inPath: string, outPath: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    "-y",
    "-i",
    inPath,
    "-t",
    seconds.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-r",
    "24",
    outPath,
  ]);
}

export async function mockImage(outPath: string, dims: { w: number; h: number }, index: number): Promise<void> {
  const { w, h } = dims;
  const hue = (index * 47) % 360;
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${w}x${h}:rate=1:duration=1`,
    "-vf",
    `hue=h=${hue}:s=1.3,eq=brightness=-0.05`,
    "-frames:v",
    "1",
    outPath,
  ]);
}

/** Dark, grainy plate used when an archival still cannot be fetched. */
export async function archivalStill(outPath: string, dims: { w: number; h: number }, index: number): Promise<void> {
  const { w, h } = dims;
  // A placeholder has to still read as cinema. The old flat near-black tint
  // measured below the blackdetect threshold, so whole fallback scenes played
  // as black holes; a lit gradient with grain is unmistakably a designed plate.
  const palettes: Array<[string, string]> = [
    ["0x9fb0c6", "0x232b39"],
    ["0xc9a678", "0x2a2119"],
    ["0x8fb8b4", "0x1c2a2c"],
    ["0xc0a0b0", "0x2a1f2a"],
  ];
  const [light, base] = palettes[index % palettes.length];
  const cx = 0.45 + ((index % 4) * 0.11);
  const cy = 0.32 + ((index % 3) * 0.12);
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${w}x${h}:type=radial:c0=${light}:c1=${base}:x0=${cx.toFixed(2)}:y0=${cy.toFixed(2)}:x1=${w}:y1=${h}:d=1`,
    "-vf",
    "noise=alls=13:allf=t+u,vignette=PI/8,eq=saturation=0.8:contrast=1.04,format=yuv420p",
    "-frames:v",
    "1",
    outPath,
  ]);
}

export async function mockSpeech(outPath: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=24000",
    "-t",
    seconds.toFixed(3),
    outPath,
  ]);
}

export async function mockAmbience(outPath: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=brown:amplitude=0.4:duration=${seconds}:sample_rate=48000`,
    "-af",
    "volume=0.12",
    outPath,
  ]);
}
