# DOCUSTUDIO

A local web app that turns a written story into a **cinematic 10–20 minute
documentary** — screenplay, narration, illustrations and an ambient score — with
**no API key and no billing**.

- **Cost:** $0. The free stack is a story-aware AI director (Gemini only if you
  add a key), free AI scene stills, Wikimedia Commons archival alternates, Edge
  Neural TTS narration and ffmpeg (score, edit, encode).
- **Run time:** 10, 15 or 20 minutes, frame-trimmed.
- **Smart director:** three tiers — Google Gemini when `GEMINI_API_KEY` is set,
  otherwise a keyless free AI director, otherwise the built-in offline director.
  The AI writes story-specific narration, captions, a one-off opening tagline and
  an exact archive query for every scene, grounded in your own text.
- **Chapters and scenes:** the deterministic director lays out the chapter spine
  and factual beats, the AI rewrites each chapter as cinematic voice-over, and
  each scene is illustrated and cut into 8–9 short moving shots.
- **Voice:** eight narrator voices across ten languages via Edge Neural TTS,
  with an offline Windows SAPI fallback. Narration starts on the very first
  frame — there is no silent intro card.
- **Images:** the primary frame of every scene is drawn free by Pollinations from
  that scene's own screenwriter prompt, so it depicts the narration. A ranked
  Wikimedia Commons archival photograph (public domain / CC, no watermark) is
  kept as the second still only when its filename, year or subject matches the
  scene — wrong-decade photos, scans, maps, artwork and modern site snapshots are
  rejected. Failed draws fall back to the archival photo, then to a grain plate.
- **Look:** historical stories are graded to archival monochrome with a warm
  tint, so drawn stills and real photographs mesh into one film. Modern stories
  stay in colour.
- **Motion:** every scene is a montage of ~2.7s shots — push-ins, pull-outs,
  pans, tilts, handheld drift and sway with hard cuts — finished with a global
  film grade, flicker, grain and vignette. It reads as edited footage, not a
  slideshow.
- **Chapters:** a lower-third chapter card bumps the story forward at each new
  chapter; the opening subtitle is a story-specific tagline written for that
  film, never a fixed template.
- **Sound:** a slow drone score is synthesized locally by ffmpeg and ducked under
  the narration.
- **Captions:** burned-in lower-third captions, optional.
- **Live progress:** chapters, scene tiles, progress bar and a render log.
- **Mock mode:** placeholders only when you explicitly set `MOCK=1`.

No key is required. The only external calls are keyless requests to Wikimedia
Commons, Pollinations and Microsoft Edge's TTS endpoint; the edit and score run
on your machine.

## How it works

```
story ──▶ smart director
              ├─ Gemini (GEMINI_API_KEY set)
              ├─ free AI, chapter by chapter (keyless, rate limited)
              └─ built-in director (offline fallback)
              │
              ▼
      chapters + scene narration + captions + tagline + per-scene archive query
              │
              ├──▶ Pollinations ──────▶ drawn still of the scene (free)
              ├──▶ Wikimedia Commons ──▶ matching archival alternate
              ├──▶ Edge Neural TTS ────▶ narration per scene (WAV)
              └──▶ ffmpeg ─────────────▶ procedural drone score
                              │
                              ▼
      ffmpeg: 2.7s shot montage + grade + grain + cards ─▶ concat ─▶ mix ─▶ trim ─▶ final.mp4
```

1. `POST /api/generate` validates the story and creates a job.
2. `lib/documentary.ts` plans the screenplay, then prepares stills + narration a
   few scenes ahead.
3. Once every voice track exists, the renderer sizes the per-scene ambient tail
   to the requested run time, cuts each scene into short moving shots, stitches
   the montages and end card, mixes the score under the narration and trims to
   target.
4. The browser polls `GET /api/jobs/:id` for progress.

## Prerequisites

- Node.js **22 / 24** and npm.
- **ffmpeg** and **ffprobe** on `PATH` (or set absolute paths in `.env`).
- **Python 3** with the free Edge TTS client:

  ```bash
  pip install edge-tts
  ```

  If Edge TTS is unreachable, narration falls back to the offline Windows SAPI
  voice automatically.

## Run it

```bash
cd veo-studio
npm install        # first time only
npm run dev
```

Open http://localhost:3000. There is nothing to configure — the app starts in
**free mode** with the built-in director. The first render downloads each
Commons still once into `data/archive-cache`; later films reuse those files, so
re-renders are faster and lighter on Wikimedia.

### Optional: Gemini boost

Add `GEMINI_API_KEY` to `.env` (never commit it). The smart director then writes
the script with Gemini and lets Gemini re-rank the shortlist of archival photos
against each scene's narration. Without a key everything still works: the free
AI director (about one chapter per 45s quota window) or the offline director
takes over. `MOCK=1` forces placeholder stills and silence for testing.

## API

- `GET /api/config` — mode, providers, voices, genres, styles, languages.
- `POST /api/generate` — `{ story, title?, genre, era, language, voice, style,
  aspectRatio, resolution, durationSeconds, captions, ambient, heroShots,
  sceneSeconds, smart?, provider? }` → `{ jobId, provider, free, scenes }`.
- `GET /api/jobs` — recent documentaries for the gallery.
- `GET /api/jobs/:id` — full job state (chapters, scenes, progress, log, QC report, final URL).
- `POST /api/jobs/:id/scenes/:index` — re-cut one scene with optional edits
  (`{ narration?, caption?, imagePrompt?, imageQuery?, shot? }`) and re-assemble the film.

Only `story` is required. `durationSeconds` is clamped to 600–1200.

## Duration and scenes

`sceneSeconds` (default 8) decides how many scenes cover the run time. A
10-minute film lands on 75 scenes, matching the shot density of the reference
documentaries:

| Target | Scenes @ 8s | Stills | Shots | TTS calls |
|-------:|------------:|-------:|------:|----------:|
| 10 min | 75          | 75–169 | ~240  | 75        |
| 15 min | 100 (cap)   | 100–220| ~400  | 100       |

Each scene's narration is budgeted from its share of the run time (~1.7 words
per second), so the finished film lands on the requested length. The closing
credits card stretches up to 30s to absorb any shortfall; narration is never
trimmed to hit the target, so the conclusion survives. Narration begins at
0:00; the only standalone card is the closing credits card (title, tagline and
archive credit over the last still).

Every scene is cut into 3–8 shots (a new framing or camera move every ~2.5s)
with burned-in, word-timed subtitles. Still sources are chosen by
`imageMode`: `key` (default, drawn AI stills on chapter openings and every third
scene, Commons/Openverse for the rest), `all` (every scene drawn — slowest) or
`archive` (real photographs only — fastest). Mismatched Commons hits are
rejected by a relevance gate instead of being shown.

Pollinations draws one still every ~45s, so the default 10-minute film spends
roughly 15–25 minutes drawing images; set `FREE_SCENE_IMAGES=0` to use archive
photos only and render faster.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FREE_TEXT_ENDPOINT` | `https://text.pollinations.ai/openai` | Keyless AI director. |
| `FREE_TEXT_MODEL` | `openai` | Pollinations text model. |
| `FREE_REASONING` | `low` | Reasoning effort; `low` keeps replies inside the free output cap. |
| `FREE_IMAGE_MODEL` | `flux` | Pollinations model for scene and opening stills. |
| `FREE_SCENE_IMAGES` | `1` | `0` disables drawn scene stills and uses archive photos only (faster). |
| `FREE_IMAGE_BUDGET` | `28` | Drawn stills per film in `key` mode; extras are drawn for archive misses. |
| `FREE_CONCURRENCY` | `3` | Scenes prepared in parallel. |
| `AI_MOTION_CLIPS` | `6` | Cap on Veo image-to-video clips when Gemini + motion are enabled. |
| `VEO_MODEL` | `veo-3.0-fast-generate-001` | Veo model used for optional motion clips. |
| `ARCHIVE_DEBUG` | — | `1` prints the Commons shortlist and failed downloads. |
| `EDGE_TTS_PYTHON` | `python` | Python that has `edge-tts` installed. |
| `MOCK` | — | `1` forces placeholders. |
| `GEMINI_API_KEY` | — | Enables the Gemini director, photo re-ranking, Imagen stills and Veo. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Binary paths. |

Free mode uses only free services: Pollinations text/stills, Edge Neural TTS,
Wikimedia Commons, Openverse, procedural ffmpeg score and local encoding. A
Gemini key adds a stronger screenwriter, drawn stills with Imagen, semantic
photo re-ranking and optional Veo motion clips — all optional, and every paid
call is capped by the settings above.

## Project structure

```
app/
  page.tsx               # the studio UI
  globals.css            # design system
  api/config/route.ts    # mode + options
  api/generate/route.ts  # start a documentary
  api/jobs/route.ts      # gallery
  api/jobs/[id]/route.ts # job status
lib/
  documentary.ts         # orchestration + prefetch/assembly pipeline
  plan.ts                # built-in director + optional Pollinations screenwriter
  archives.ts            # Wikimedia Commons + Openverse search, ranking, download
  images.ts              # free drawn stills (Pollinations) + optional Imagen
  tts.ts                 # Edge Neural TTS (+ SAPI fallback) + optional Gemini TTS
  subtitles.ts           # word-timed cues → wrapped ASS subtitles
  phash.ts               # perceptual dHash for duplicate-composition checks
  qc.ts                  # automated quality report on the final MP4
  ambience.ts            # procedural drone + optional Veo bed
  veo.ts                 # legacy Veo submit/poll/download
  media.ts               # ffmpeg: shot montage, cards, concat, mix, trim, mocks
  store.ts               # job persistence (data/ + memory)
  estimate.ts            # scene count + duration clamp
  types.ts               # shared types
public/generated/        # stills, narration, scene cuts, final MP4
data/jobs/               # job JSON
data/archive-cache/      # reused Wikimedia stills (ignored by git)
```

## Troubleshooting

- **`Could not run ffmpeg`** — check `FFMPEG_PATH`/`FFPROBE_PATH` in `.env`.
- **Free AI director waits** — its anonymous tier allows one reply per IP every
  45 seconds, so planning a 10-minute film takes a few minutes and the log shows
  each quota wait. A truncated reply is salvaged scene by scene; any chapter that
  still fails falls back to the built-in director for that chapter.
- **A still falls back to a dark plate** — both the drawn still and Wikimedia
  failed for that scene. The scene still ships; refine the story with concrete
  names, places and years for better results, or set `FREE_SCENE_IMAGES=0`.
- **Image waits in the log** — Pollinations' anonymous tier allows one image
  every 45 seconds, so drawn stills are queued and spaced automatically.
- **An archival alternate is missing** — that photo shared no word, year or
  person with the scene, so it was dropped rather than shown beside the drawn
  frame.
- **Robotic narration** — Edge TTS was unreachable and Windows SAPI took over.
  Check `python -m edge_tts --list-voices` and the network.
- **Long renders** — expected: each scene needs one image and one narration
  request. Raise `sceneSeconds` for fewer, longer scenes.
- **Port 3000 busy** — `npx next dev -p 3001`.
