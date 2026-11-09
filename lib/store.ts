import fs from "node:fs";
import path from "node:path";
import type { Job } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "jobs");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

type Store = { jobs: Map<string, Job> };

// Persist the in-memory map across Next.js hot reloads.
const globals = globalThis as unknown as { __veoStudioStore?: Store };
const store: Store = globals.__veoStudioStore ?? (globals.__veoStudioStore = { jobs: new Map() });

export function saveJob(job: Job): void {
  job.updatedAt = Date.now();
  store.jobs.set(job.id, job);
  try {
    ensureDir();
    fs.writeFileSync(path.join(DATA_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
  } catch {
    // Persistence is best-effort; the in-memory job still serves the UI.
  }
}

export function getJob(id: string): Job | undefined {
  const cached = store.jobs.get(id);
  if (cached) return cached;
  try {
    const p = path.join(DATA_DIR, `${id}.json`);
    if (fs.existsSync(p)) {
      const job = JSON.parse(fs.readFileSync(p, "utf8")) as Job;
      store.jobs.set(id, job);
      return job;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function listJobs(): Job[] {
  const map = new Map(store.jobs);
  try {
    ensureDir();
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (map.has(id)) continue;
      try {
        map.set(id, JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as Job);
      } catch {
        // skip corrupt entries
      }
    }
  } catch {
    // ignore
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}
