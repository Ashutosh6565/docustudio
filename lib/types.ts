export type AspectRatio = "16:9" | "9:16";
export type Resolution = "720p" | "1080p";
export type Provider = "free" | "gemini";
/** How many stills get the slow free AI illustration pass. */
export type ImageMode = "key" | "all" | "archive";
export type MusicStyle = "drone" | "pulse" | "warm" | "none";

export interface DocumentaryInput {
  story: string;
  title?: string;
  genre: string;
  era: string;
  language: string;
  voice: string;
  style: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  durationSeconds: number; // 600..1200
  captions: boolean;
  ambient: boolean; // free: procedural score · gemini: Veo sound bed
  heroShots: boolean; // free: AI/archival opening still on scene 1
  sceneSeconds: number;
  provider?: Provider;
  /** Story-aware direction: Gemini when a key is set, otherwise the free AI director. */
  smart?: boolean;
  /** Free illustration budget: key beats, every scene, or archive photographs only. */
  imageMode?: ImageMode;
  /** Procedural score recipe. */
  music?: MusicStyle;
  /** Gemini only: animate stills with Veo image-to-video. */
  aiMotion?: boolean;
  imageModel: string;
  ttsModel: string;
  textModel: string;
  videoModel: string;
}

export type JobStatus =
  | "queued"
  | "planning"
  | "images"
  | "narration"
  | "assembling"
  | "mixing"
  | "done"
  | "error";

export type SceneStatus = "queued" | "image" | "narration" | "video" | "done" | "error";

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface WordTiming {
  t: number;
  d: number;
  w: string;
}

export interface Scene {
  index: number;
  chapter: number;
  chapterTitle: string;
  narration: string;
  caption: string;
  imagePrompt: string;
  imageQuery?: string;
  status: SceneStatus;
  hero: boolean;
  imageFile?: string;
  imageAltFile?: string;
  /** Gemini mode: a Veo image-to-video clip cut into the scene. */
  motionFile?: string;
  audioFile?: string;
  videoFile?: string;
  durationSeconds?: number;
  /** Perceptual hash of the chosen still, used to catch repeated imagery. */
  imageHash?: string;
  /** Number of distinct shots cut from this scene's visuals. */
  shotCount?: number;
  /** Word-accurate cues generated from the narration track. */
  subtitleCues?: SubtitleCue[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface Chapter {
  index: number;
  title: string;
  sceneIndexes: number[];
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityReport {
  passed: boolean;
  checkedAt: number;
  checks: QualityCheck[];
  metrics: Record<string, number | string>;
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  input: DocumentaryInput;
  status: JobStatus;
  message: string;
  mock: boolean;
  title: string;
  logline: string;
  tagline?: string;
  chapters: Chapter[];
  scenes: Scene[];
  progress: number;
  finalUrl?: string;
  actualDurationSeconds?: number;
  narrationSeconds?: number;
  /** Ambient tail per scene, saved so a single scene can be re-cut later. */
  tailSeconds?: number;
  quality?: QualityReport;
  error?: string;
  log: LogLine[];
}
