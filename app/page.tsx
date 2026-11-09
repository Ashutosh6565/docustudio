"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ModelOption = { id: string; label: string };
type ModelGroup = { default: string; options: ModelOption[] };

type Config = {
  free?: boolean;
  provider?: string;
  hasKey: boolean;
  mock: boolean;
  limits: { minSeconds: number; maxSeconds: number; sceneSeconds: number };
  smart?: { default: boolean; gemini: boolean; freeAi: boolean; model?: string };
  imageModes?: { id: string; label: string; note: string }[];
  musicStyles?: { id: string; label: string }[];
  aiMotion?: { available: boolean; note: string };
  costParams: { perImage: number; per1kTtsChars: number; perVeoSecond: number };
  models: { text: ModelGroup; image: ModelGroup; tts: ModelGroup; video: ModelGroup };
  voices: ModelOption[];
  languages: string[];
  genres: string[];
  styles: string[];
  durations: { seconds: number; label: string }[];
  aspectRatios: string[];
  resolutions: string[];
  singleApi: string;
};

type Scene = {
  index: number;
  chapter: number;
  chapterTitle: string;
  narration: string;
  caption: string;
  imagePrompt: string;
  status: string;
  imageFile?: string;
  audioFile?: string;
  videoFile?: string;
  durationSeconds?: number;
  error?: string;
};

type Chapter = { index: number; title: string; sceneIndexes: number[] };

type JobView = {
  id: string;
  status: string;
  message: string;
  progress: number;
  mock: boolean;
  title: string;
  logline: string;
  chapters: Chapter[];
  scenes: Scene[];
  finalUrl?: string;
  actualDurationSeconds?: number;
  error?: string;
  quality?: {
    passed: boolean;
    checks: { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }[];
    metrics: Record<string, number | string>;
  };
  log: { t: number; text: string }[];
  input: {
    story: string;
    genre: string;
    era: string;
    language: string;
    voice: string;
    style: string;
    aspectRatio: string;
    resolution: string;
    durationSeconds: number;
    captions: boolean;
    ambient: boolean;
    heroShots: boolean;
    sceneSeconds: number;
    provider?: string;
    imageMode?: string;
    music?: string;
    aiMotion?: boolean;
    imageModel: string;
    ttsModel: string;
    textModel: string;
    videoModel: string;
  };
};

type GalleryItem = {
  id: string;
  createdAt: number;
  title: string;
  story: string;
  genre: string;
  durationSeconds: number;
  actualDurationSeconds?: number;
  scenes: number;
  aspectRatio: string;
  resolution: string;
  status: string;
  finalUrl?: string;
  mock: boolean;
};

const EXAMPLES = [
  {
    label: "The last lighthouse keeper",
    story:
      "For forty years, Elias manned a lighthouse on a storm-battered island off the Scottish coast, keeping a light burning for ships that stopped coming. When the automation crew arrives to decommission the tower, he refuses to leave. His notebooks reveal the night a freighter sank in 1979 and the choice he made that he has never spoken of since.",
  },
  {
    label: "The seed vault",
    story:
      "Buried inside a mountain in the Norwegian Arctic is a vault holding over a million seeds — a backup drive for the world's food supply. This is the story of the scientists who built it, the war that nearly destroyed one of its sister collections, and the quiet race to save crop diversity before it disappears forever.",
  },
  {
    label: "A city under the sand",
    story:
      "In 1911, a British archaeologist digging in the Egyptian desert uncovered a city that had been swallowed by sand for three thousand years. What his team found inside the temples rewrote the timeline of an empire — and then the artifacts began to vanish, one crate at a time.",
  },
  {
    label: "The marathon that broke a nation",
    story:
      "In 1968, two athletes from a small East African nation arrived at the Mexico City Olympics with nothing but borrowed shoes. What happened over the next two hours changed how the world thought about endurance, race, and who was allowed to win.",
  },
];

function fmtDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function SceneEditor({
  jobId,
  scene,
  disabled,
  onRecut,
}: {
  jobId: string;
  scene: Scene;
  disabled: boolean;
  onRecut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [narration, setNarration] = useState(scene.narration);
  const [caption, setCaption] = useState(scene.caption);
  const [imagePrompt, setImagePrompt] = useState(scene.imagePrompt);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setNarration(scene.narration);
    setCaption(scene.caption);
    setImagePrompt(scene.imagePrompt);
  }, [scene.narration, scene.caption, scene.imagePrompt]);

  const recut = async () => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/scenes/${scene.index}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narration, caption, imagePrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not re-cut this scene");
      setMessage("Re-cutting scene and re-assembling the film…");
      onRecut();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scene-edit">
      <div className="scene-tools">
        <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Edit & re-cut"}
        </button>
        {scene.videoFile && (
          <a className="link-btn" href={scene.videoFile} target="_blank" rel="noreferrer">
            Preview cut
          </a>
        )}
      </div>
      {open && (
        <div className="scene-editor">
          <label>Narration</label>
          <textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={4} />
          <label>Subtitle text (fallback)</label>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} />
          <label>Image prompt</label>
          <textarea value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} rows={3} />
          <button
            type="button"
            className="btn primary"
            onClick={recut}
            disabled={busy || disabled}
            style={{ marginTop: 8 }}
          >
            {busy ? "Starting…" : "Save & re-cut"}
          </button>
          {message && <div className="hint" style={{ marginTop: 6 }}>{message}</div>}
          {disabled && <div className="hint">Wait for the film to finish before re-cutting a scene.</div>}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);
  const [story, setStory] = useState("");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("Investigative");
  const [era, setEra] = useState("Contemporary");
  const [language, setLanguage] = useState("English");
  const [voice, setVoice] = useState("Charon");
  const [style, setStyle] = useState("Cinematic realism");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [resolution, setResolution] = useState<"720p" | "1080p">("1080p");
  const [provider, setProvider] = useState<"free" | "gemini">("free");
  const [duration, setDuration] = useState(600);
  const [captions, setCaptions] = useState(true);
  const [ambient, setAmbient] = useState(true);
  const [heroShots, setHeroShots] = useState(false);
  const [smart, setSmart] = useState(true);
  const [imageMode, setImageMode] = useState<"key" | "all" | "archive">("key");
  const [music, setMusic] = useState<"drone" | "pulse" | "warm" | "none">("drone");
  const [aiMotion, setAiMotion] = useState(false);
  const [sceneSeconds, setSceneSeconds] = useState(8);
  const [textModel, setTextModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [videoModel, setVideoModel] = useState("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [pollNonce, setPollNonce] = useState(0);
  const pollRef = useRef<number | null>(null);

  const loadGallery = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setGallery(data.jobs ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const cfg: Config = await res.json();
        setConfig(cfg);
        setSceneSeconds(cfg.limits.sceneSeconds);
        setSmart(cfg.smart?.default !== false);
        setTextModel((v) => v || cfg.models.text.default);
        setImageModel((v) => v || cfg.models.image.default);
        setTtsModel((v) => v || cfg.models.tts.default);
        setVideoModel((v) => v || cfg.models.video.default);
      } catch {
        // ignore
      }
    })();
    void loadGallery();
  }, [loadGallery]);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data: JobView = await res.json();
        if (stop) return;
        setJob(data);
        if (data.status === "done" || data.status === "error") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          void loadGallery();
        }
      } catch {
        // ignore transient errors
      }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 2000);
    return () => {
      stop = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [jobId, pollNonce, loadGallery]);

  const estimate = useMemo(() => {
    const scenes = Math.min(100, Math.max(12, Math.round(duration / Math.max(6, sceneSeconds))));
    const chapters = Math.min(scenes, Math.max(3, Math.round(duration / 150)));
    const chars = Math.round(duration * 2.5 * 5.5);
    // Free AI stills are slow; key mode spends them on chapter openings and
    // every third scene. All/archive modes change the count, not the runtime.
    const drawn =
      imageMode === "archive" ? 0 : imageMode === "all" ? scenes : Math.min(28, chapters + Math.round(scenes / 3));
    const shots = Math.round(scenes * Math.max(3, sceneSeconds / 2.5));
    // ~45 s per drawn still; archive fetches and cuts dominate the rest.
    const eta = drawn * 0.8 + scenes * 0.35 + duration / 60 / 2 + 3;
    return { scenes, chapters, chars, drawn, shots, eta };
  }, [duration, sceneSeconds, imageMode]);

  const running = Boolean(job && job.status !== "done" && job.status !== "error");

  const generate = async () => {
    setError("");
    if (story.trim().length < 20) {
      setError("Tell the story first — a paragraph or two is enough.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          story,
          title,
          genre,
          era,
          language,
          voice,
          style,
          aspectRatio,
          resolution,
          durationSeconds: duration,
          captions,
          ambient,
          heroShots,
          smart,
          sceneSeconds,
          provider,
          imageMode,
          music,
          aiMotion: provider === "gemini" && aiMotion,
          textModel,
          imageModel,
          ttsModel,
          videoModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the documentary");
      setJob(null);
      setJobId(data.jobId);
      window.scrollTo({ top: 640, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const openJob = (id: string) => {
    setError("");
    setJob(null);
    setJobId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startOver = () => {
    setJobId(null);
    setJob(null);
    setError("");
  };

  const pct = ((duration - 600) / 600) * 100;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span>
            DOCUSTUDIO
            <small>Story to documentary</small>
          </span>
        </div>
        <div className="badges">
          {config && (
            <span className={`badge ${config.mock ? "warn" : "good"}`}>
              <span className="dot" />
              {config.mock ? "Mock mode" : "100% free · no API key"}
            </span>
          )}
          <span className="badge">Wikimedia · Edge TTS · ffmpeg</span>
          <span className="badge">10 – 20 min</span>
        </div>
      </header>

      <section className="hero">
        <h1>
          Your story, cut into a <span className="grad">10–20 minute documentary</span>.
        </h1>
        <p>
          Write the story you want told. DOCUSTUDIO writes the screenplay, narrates it with a neural
          voice, illustrates every beat, scores the film with a generated ambient bed, and edits it
          into one cinematic cut — with no API key, no billing and no watermark.
        </p>
      </section>

      {config?.mock && (
        <div className="banner">
          <span>⚠</span>
          <div>
            <code>MOCK=1</code> is set, so you are in <b>mock mode</b> — placeholder stills, silent
            narration and a synthetic sound bed. Remove it from <code>.env</code> and restart for the
            real free film.
          </div>
        </div>
      )}

      <div className="composer">
        <div>
          <div className="panel">
            <div className="panel-title">
              <span>The story</span>
              <span>{story.length}/6000</span>
            </div>
            <div className="field">
              <div className="label">
                <span>Title (optional)</span>
                <span className="hint" style={{ margin: 0 }}>
                  The director model will name it if left blank
                </span>
              </div>
              <input
                className="input"
                maxLength={120}
                placeholder="The Last Lighthouse Keeper"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <div className="label">Story, subject or premise</div>
              <textarea
                className="input tall-input"
                maxLength={6000}
                placeholder="Tell us the story: who it's about, what happens, the tension, the turn, and how it ends. Real or imagined — a few honest paragraphs give the director model the most to work with."
                value={story}
                onChange={(e) => setStory(e.target.value)}
              />
              <div className="hint">
                Facts, names, dates and details all help. The director model turns this into chapters,
                narration and shot descriptions.
              </div>
            </div>
            <div className="field">
              <div className="label">Start from an idea</div>
              <div className="chips">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setStory(ex.story);
                      setTitle("");
                    }}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">The look</div>

            <div className="field">
              <div className="label">Visual style</div>
              <div className="chips">
                {(config?.styles ?? ["Cinematic realism"]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip ${style === s ? "active" : ""}`}
                    onClick={() => setStyle(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="label">Genre / tone</div>
              <div className="chips">
                {(config?.genres ?? ["Investigative"]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`chip ${genre === g ? "active" : ""}`}
                    onClick={() => setGenre(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <div className="label">Era / setting</div>
                <input
                  className="input"
                  maxLength={60}
                  value={era}
                  onChange={(e) => setEra(e.target.value)}
                  placeholder="1970s coastal Scotland"
                />
              </div>
              <div className="field">
                <div className="label">Language</div>
                <select
                  className="input"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  {(config?.languages ?? ["English"]).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <div className="label">Narrator voice</div>
              <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
                {(config?.voices ?? [{ id: "Charon", label: "Charon" }]).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid-2">
              <div className="field">
                <div className="label">Aspect</div>
                <div className="segmented">
                  <button
                    type="button"
                    className={aspectRatio === "16:9" ? "active" : ""}
                    onClick={() => setAspectRatio("16:9")}
                  >
                    <span className="ratio-icon" /> 16:9
                  </button>
                  <button
                    type="button"
                    className={aspectRatio === "9:16" ? "active" : ""}
                    onClick={() => setAspectRatio("9:16")}
                  >
                    <span className="ratio-icon tall" /> 9:16
                  </button>
                </div>
              </div>
              <div className="field">
                <div className="label">Resolution</div>
                <div className="segmented">
                  <button
                    type="button"
                    className={resolution === "720p" ? "active" : ""}
                    onClick={() => setResolution("720p")}
                  >
                    720p
                  </button>
                  <button
                    type="button"
                    className={resolution === "1080p" ? "active" : ""}
                    onClick={() => setResolution("1080p")}
                  >
                    1080p
                  </button>
                </div>
              </div>
            </div>

            <div className="field">
              <div className="label">Sound &amp; text</div>
              <div className="chips">
                <button
                  type="button"
                  className={`chip ${captions ? "active" : ""}`}
                  onClick={() => setCaptions((v) => !v)}
                >
                  {captions ? "Captions on" : "Captions off"}
                </button>
                <button
                  type="button"
                  className={`chip ${ambient ? "active" : ""}`}
                  onClick={() => setAmbient((v) => !v)}
                >
                  {ambient ? "Ambient bed on" : "Ambient bed off"}
                </button>
                <button
                  type="button"
                  className={`chip ${heroShots ? "active" : ""}`}
                  onClick={() => setHeroShots((v) => !v)}
                >
                  {heroShots ? "Cinematic opening still on" : "Cinematic opening still off"}
                </button>
                <button
                  type="button"
                  className={`chip ${smart ? "active" : ""}`}
                  onClick={() => setSmart((v) => !v)}
                >
                  {smart ? "Smart direction on" : "Smart direction off"}
                </button>
              </div>
              <div className="hint">
                Narration starts on the first frame. The director writes every scene from your
                story and matches each photo to its narration, then cuts each scene into 2–3s
                moving shots — push-ins, pulls, pans, tilts and handheld drift — with a drone score
                and chapter lower-thirds.
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {config?.smart?.gemini
                  ? "Gemini key detected — used for the script, photo choices and opening hook."
                  : "No key needed — a free AI director writes the script, with the offline director as fallback."}
              </div>
            </div>

            <div className="field">
              <div className="label">Visual source</div>
              <div className="segmented">
                <button
                  type="button"
                  className={imageMode === "key" ? "active" : ""}
                  onClick={() => setImageMode("key")}
                >
                  Key beats
                </button>
                <button
                  type="button"
                  className={imageMode === "all" ? "active" : ""}
                  onClick={() => setImageMode("all")}
                >
                  Every scene
                </button>
                <button
                  type="button"
                  className={imageMode === "archive" ? "active" : ""}
                  onClick={() => setImageMode("archive")}
                >
                  Archive only
                </button>
              </div>
              <div className="hint">
                Key beats draws the slow free AI still for chapter openings and every third scene,
                with archival photos covering the rest. Every scene is the slowest; archive only
                skips the illustrator entirely.
              </div>
            </div>

            <div className="field">
              <div className="label">Score</div>
              <div className="segmented">
                {(["drone", "pulse", "warm", "none"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={music === id ? "active" : ""}
                    onClick={() => setMusic(id)}
                  >
                    {id === "drone" ? "Drone" : id === "pulse" ? "Pulse" : id === "warm" ? "Warm" : "None"}
                  </button>
                ))}
              </div>
              <div className="hint">
                The score is ducked under the narration by a sidechain so the voice always leads,
                then normalised to −16 LUFS.
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-title">
              <span>Run time</span>
              <b style={{ color: "var(--text)", letterSpacing: 0 }}>{fmtDuration(duration)}</b>
            </div>
            <div className="chips" style={{ marginBottom: 10 }}>
              {(config?.durations ?? [
                { seconds: 600, label: "10 min" },
                { seconds: 900, label: "15 min" },
                { seconds: 1200, label: "20 min" },
              ]).map((d) => (
                <button
                  key={d.seconds}
                  type="button"
                  className={`chip ${duration === d.seconds ? "active" : ""}`}
                  onClick={() => setDuration(d.seconds)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <input
              type="range"
              className="range"
              min={600}
              max={1200}
              step={30}
              value={duration}
              style={{ "--pct": `${pct}%` } as React.CSSProperties}
              onChange={(e) => setDuration(clamp(Number(e.target.value), 600, 1200))}
            />
            <div className="hint">10 minutes minimum · 20 minutes maximum · trimmed to the frame.</div>
          </div>

          <div className="panel">
            <div className="panel-title">Estimate</div>
            <div className="estimate">
              <div className="est-row">
                <span>Chapters</span>
                <b>{estimate.chapters}</b>
              </div>
              <div className="est-row">
                <span>Scenes</span>
                <b>{estimate.scenes} · ~{estimate.shots} shots</b>
              </div>
              <div className="est-row">
                <span>AI stills (slow)</span>
                <b>{estimate.drawn}</b>
              </div>
              <div className="est-row">
                <span>Narration</span>
                <b>~{Math.round(estimate.chars / 1000)}k characters</b>
              </div>
              <div className="est-row">
                <span>Score</span>
                <b>{music === "none" ? "None" : `Procedural ${music}`}</b>
              </div>
              <div className="est-row">
                <span>Cost</span>
                <b>{provider === "gemini" ? "Gemini rates" : "$0.00 · free"}</b>
              </div>
              <div className="est-row">
                <span>Est. render time</span>
                <b>~{Math.max(1, Math.round(estimate.eta))} min</b>
              </div>
              <div className="est-note">
                {provider === "gemini"
                  ? "Gemini mode uses your key for the script, scene planning and Veo motion. Billed at Google's published rates — nothing here is free unless Google's quota covers it."
                  : "Free stack: story-aware script direction, AI stills on key beats, matching Wikimedia archival alternates, Edge neural narration, procedural score and a local ffmpeg edit. No key, no billing."}
              </div>
            </div>

            {error && (
              <div className="hint" style={{ color: "var(--bad)", marginTop: 12 }}>
                {error}
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <button
                className="btn primary block"
                onClick={generate}
                disabled={submitting || running}
                type="button"
              >
                {running
                  ? "Documentary rendering…"
                  : submitting
                    ? "Starting…"
                    : `Direct a ${fmtDuration(duration)} documentary`}
              </button>
              {jobId && (
                <button
                  className="btn ghost block"
                  style={{ marginTop: 9 }}
                  onClick={startOver}
                  type="button"
                >
                  Start a new film
                </button>
              )}
            </div>
          </div>

          <details className="panel details">
            <summary>Engine &amp; models</summary>
            <div className="field" style={{ marginTop: 14 }}>
              <div className="label">Provider</div>
              <div className="segmented">
                <button
                  type="button"
                  className={provider === "free" ? "active" : ""}
                  onClick={() => setProvider("free")}
                >
                  Free
                </button>
                <button
                  type="button"
                  className={provider === "gemini" ? "active" : ""}
                  onClick={() => setProvider("gemini")}
                  disabled={!config?.hasKey}
                  title={config?.hasKey ? "Uses your Gemini key" : "Add GEMINI_API_KEY to .env first"}
                >
                  Gemini
                </button>
              </div>
              <div className="hint">
                {provider === "gemini"
                  ? "Gemini writes with your key and can animate the shots with Veo."
                  : "Everything runs on free services: the free AI director, Pollinations stills, Commons archives, Edge neural voices and local ffmpeg."}
              </div>
            </div>
            {provider === "gemini" && (
              <div className="field">
                <div className="label">Motion</div>
                <button
                  type="button"
                  className={`chip ${aiMotion ? "active" : ""}`}
                  onClick={() => setAiMotion((v) => !v)}
                >
                  {aiMotion ? "Veo motion on" : "Veo motion off"}
                </button>
                <div className="hint">
                  Turns key stills into real AI video clips. Off by default because it bills per
                  second; camera moves and parallax still cover the free path.
                </div>
              </div>
            )}
            <div className="field">
              <div className="label">Screenwriter</div>
              <select className="input" value={textModel} onChange={(e) => setTextModel(e.target.value)}>
                {(config?.models.text.options ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="label">Illustrator</div>
              <select
                className="input"
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
              >
                {(config?.models.image.options ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="label">Narrator</div>
              <select className="input" value={ttsModel} onChange={(e) => setTtsModel(e.target.value)}>
                {(config?.models.tts.options ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="label">Ambience / motion</div>
              <select className="input" value={videoModel} onChange={(e) => setVideoModel(e.target.value)}>
                {(config?.models.video.options ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="label">
                <span>Seconds per scene</span>
                <b>{sceneSeconds}s</b>
              </div>
              <input
                type="range"
                className="range"
                min={6}
                max={30}
                step={2}
                value={sceneSeconds}
                style={
                  { "--pct": `${((sceneSeconds - 6) / 24) * 100}%` } as React.CSSProperties
                }
                onChange={(e) => setSceneSeconds(Number(e.target.value))}
              />
              <div className="hint">
                10s is the documentary default: roughly 60 scenes for a 10-minute film, each cut
                into a new angle every 2.5 seconds. Shorter scenes mean more cuts and more stills.
              </div>
            </div>
          </details>
        </div>
      </div>

      {job && (
        <div className="panel result-panel">
          <div className="status-line">
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className={`status-chip ${job.status}`}>{job.status}</span>
              <span className="status-msg">{job.message}</span>
              {job.mock && <span className="badge warn">mock</span>}
              {!job.mock && <span className="badge good">free</span>}
            </div>
            <span className="status-msg">{job.progress}%</span>
          </div>

          <div className="progress">
            <i style={{ width: `${job.progress}%` }} />
          </div>

          {(job.title || job.logline) && (
            <div className="film-head">
              <h2>{job.title}</h2>
              {job.logline && <p>{job.logline}</p>}
              <div className="film-meta">
                <span>{job.input.genre}</span>
                <span>{job.input.era}</span>
                <span>{job.input.language}</span>
                <span>{job.input.resolution}</span>
                <span>{job.input.aspectRatio}</span>
                <span>{job.scenes.length} scenes</span>
                {job.actualDurationSeconds && (
                  <span className="good">{fmtDuration(job.actualDurationSeconds)}</span>
                )}
              </div>
            </div>
          )}

          {job.error && (
            <div className="banner" style={{ marginTop: 16, marginBottom: 0 }}>
              <span>⚠</span>
              <div>{job.error}</div>
            </div>
          )}

          {job.quality && (
            <div className="quality">
              <div className="quality-head">
                <b>{job.quality.passed ? "Quality check passed" : "Quality check flagged issues"}</b>
                <span className="status-msg">
                  {job.quality.checks.filter((c) => c.status === "pass").length}/
                  {job.quality.checks.length} checks pass
                </span>
              </div>
              <div className="quality-grid">
                {job.quality.checks.map((check) => (
                  <div key={check.id} className={`qc ${check.status}`} title={check.detail}>
                    <span className="qc-dot" />
                    <span className="qc-label">{check.label}</span>
                    <span className="qc-detail">{check.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {job.status === "done" && job.finalUrl && (
            <>
              <video
                className={`result-video ${job.input.aspectRatio === "9:16" ? "tall" : ""}`}
                src={job.finalUrl}
                controls
                preload="metadata"
                poster={job.scenes[0]?.imageFile}
              />
              <div className="result-actions">
                <a className="btn primary" href={job.finalUrl} download={`documentary-${job.id}.mp4`}>
                  Download MP4
                </a>
                <a className="btn" href={job.finalUrl} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
                <span className="status-msg" style={{ alignSelf: "center" }}>
                  {fmtDuration(job.actualDurationSeconds)} · {job.input.resolution} ·{" "}
                  {job.input.aspectRatio}
                </span>
              </div>
            </>
          )}

          <div className="chapters">
            {job.chapters.map((chapter) => (
              <section key={chapter.index} className="chapter">
                <h3>
                  <span className="chapter-num">Ch. {chapter.index + 1}</span>
                  {chapter.title}
                </h3>
                <div className="scenes">
                  {chapter.sceneIndexes.map((idx) => {
                    const scene = job.scenes[idx];
                    if (!scene) return null;
                    return (
                      <article
                        key={scene.index}
                        className={`scene ${job.input.aspectRatio === "9:16" ? "tall" : ""}`}
                        title={scene.imagePrompt || scene.narration}
                      >
                        <div className="scene-media">
                          {scene.imageFile ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={scene.imageFile} alt={`Scene ${scene.index + 1}`} loading="lazy" />
                          ) : (
                            <div className="scene-empty">
                              {scene.status === "error"
                                ? "Failed"
                                : scene.status === "queued"
                                  ? "Queued"
                                  : "Rendering…"}
                            </div>
                          )}
                          <span className={`state ${scene.status}`} />
                          <span className="idx">{scene.index + 1}</span>
                          {scene.durationSeconds && (
                            <span className="dur">{Math.round(scene.durationSeconds)}s</span>
                          )}
                        </div>
                        <div className="scene-body">
                          <p>{scene.narration || scene.chapterTitle}</p>
                          {scene.error && <span className="scene-err">{scene.error}</span>}
                          <SceneEditor
                            jobId={job.id}
                            scene={scene}
                            disabled={running || job.status !== "done"}
                            onRecut={() => setPollNonce((n) => n + 1)}
                          />
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="log">
            {job.log.map((line, i) => (
              <div key={i} className={line.text.startsWith("ERROR") ? "err" : ""}>
                [{fmtTime(line.t)}] {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {gallery.length > 0 && (
        <>
          <h2 className="section-title">Your documentaries</h2>
          <p className="section-sub">Every cut rendered on this machine, newest first.</p>
          <div className="gallery">
            {gallery.map((item) => (
              <div key={item.id} className="card" onClick={() => openJob(item.id)}>
                <div className={`media ${item.aspectRatio === "9:16" ? "tall" : ""}`}>
                  {item.finalUrl ? (
                    <video src={item.finalUrl} muted loop preload="metadata" />
                  ) : (
                    <span className="status-msg">{item.status}</span>
                  )}
                </div>
                <div className="body">
                  <strong>{item.title}</strong>
                  <p>{item.story}</p>
                  <div className="row">
                    <span>
                      {fmtDuration(item.actualDurationSeconds || item.durationSeconds)} ·{" "}
                      {item.resolution}
                    </span>
                    <span>{item.mock ? "mock" : "free"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="steps">
        <div className="step">
          <div className="num">1</div>
          <h3>Write the story</h3>
          <p>
            Paste a real story or invent one. Facts, names and turning points give the screenwriter
            the most to build chapters from.
          </p>
        </div>
        <div className="step">
          <div className="num">2</div>
          <h3>Direct the cut</h3>
          <p>
            The director writes the screenplay, Edge Neural TTS narrates from frame one, and each
            scene becomes a run of short moving shots over archival stills. A local drone score
            holds it together — no key.
          </p>
        </div>
        <div className="step">
          <div className="num">3</div>
          <h3>Deliver 10–20 min</h3>
          <p>
            Every scene is cut to its narration, chapter cards bump the story forward, and the film
            is mixed and delivered as a single MP4.
          </p>
        </div>
      </div>

      <footer className="footer">
        <span>
          DOCUSTUDIO · local app · free text, images, voice and score. AI-generated content — verify
          facts before publishing.
        </span>
        <span>
          No API key. Scene stills are drawn free by Pollinations and paired with matching Wikimedia
          Commons archive photos; voice and screenplay use free Pollinations and Edge endpoints. The
          edit, score and encode run on this machine.
        </span>
      </footer>
    </div>
  );
}
