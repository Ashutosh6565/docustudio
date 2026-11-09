import { runBuffer } from "./media";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const POPCOUNT = Array.from({ length: 16 }, (_, i) => {
  let n = i;
  let count = 0;
  while (n) {
    count += n & 1;
    n >>= 1;
  }
  return count;
});

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    distance += POPCOUNT[Number.isFinite(x) ? x : 0];
  }
  return distance;
}

/**
 * 64-bit difference hash: downscale to 9x8 grayscale and record which
 * neighbours are brighter. Robust to grading and compression, sensitive to a
 * repeated composition, which is what a slideshow looks like.
 */
export async function perceptualHash(file: string): Promise<string | undefined> {
  try {
    const raw = await runBuffer(FFMPEG, [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      "scale=9:8:flags=area,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    if (raw.length < 72) return undefined;
    let hex = "";
    for (let y = 0; y < 8; y++) {
      let bits = 0;
      for (let x = 0; x < 8; x++) {
        const left = raw[y * 9 + x];
        const right = raw[y * 9 + x + 1];
        bits = (bits << 1) | (left > right ? 1 : 0);
      }
      hex += bits.toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return undefined;
  }
}

/** Distance in bits; 0 means the same composition, 64 means unrelated. */
export function hashDistance(a?: string, b?: string): number {
  if (!a || !b) return 64;
  return hammingHex(a, b);
}

export function findNearDuplicate(
  hash: string | undefined,
  used: string[],
  threshold = 8,
): string | undefined {
  if (!hash) return undefined;
  return used.find((other) => hashDistance(hash, other) <= threshold);
}
