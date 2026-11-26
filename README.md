# Speech to Text: real-time Hindi + English transcription

Speak into the browser and watch the text appear as you talk, including mixed Hindi and English
("Kal ki meeting 10 baje hai, please join on time"). Every recording is saved to PostgreSQL, and a
dashboard lets you search, create, edit, delete and play back (text-to-speech) past transcriptions.

- **Live demo:** _add deployed URL here_
- **Stack:** Node.js 22 + TypeScript (Express 5, `ws`, `pg`, `zod`), React 19 + Vite, PostgreSQL 16,
  Gemini Live API and a self-hosted faster-whisper service (Python, FastAPI)

## Features

| Area | What it does |
| --- | --- |
| Live transcription | Mic audio streams over a WebSocket in 100 ms chunks. Interim text (gray, italic) updates while you speak; finalized sentences lock in when you pause. |
| Multilingual | Auto language detection handles Hindi-English code-mixing. Optional hints: Hindi + English, Hindi, English (India). |
| Two STT engines | **Gemini Live** (`gemini-3.5-transcribe-live`, true streaming) and **faster-whisper** (open source, self-hosted, near real-time). Picked per recording from a dropdown. |
| Storage | Each recording is saved with title, text, language, engine and duration. |
| Dashboard (CRUD) | Search (title and text), pagination, create manually, edit inline, delete, play back with TTS. |
| Text to speech | Browser Web Speech API (free, no key). Picks a Hindi voice for Devanagari text. |
| Tests | 25 API/WebSocket/unit tests (Vitest + Supertest against real Postgres) and 6 Python tests for the audio segmenter. GitHub Actions runs all of them. |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    Mic[Mic] --> W[AudioWorklet<br/>resample to 16 kHz PCM16]
    W -->|binary frames, 100 ms| WS
    UI[React UI<br/>Live + History]
  end

  WS[[WebSocket /ws/transcribe]] --> S
  UI -->|REST /api/transcriptions| S

  subgraph Node server
    S[Express + ws] --> R{Provider registry}
    S --> DB[(PostgreSQL)]
  end

  R -->|"@google/genai live session"| G[Gemini Live API<br/>gemini-3.5-transcribe-live]
  R -->|WebSocket| F[faster-whisper sidecar<br/>Python, Docker]
```

**One recording, end to end**

1. The browser opens `/ws/transcribe` and sends `{"type":"start","provider":"gemini","languageCodes":[]}`.
   Mic capture starts at the same time; chunks captured before the server answers `ready` are queued, so the first word is not lost.
2. An AudioWorklet downsamples mic audio (44.1/48 kHz float) to 16 kHz mono PCM16 and posts 100 ms chunks, which go out as binary WebSocket frames.
3. The server forwards audio to the chosen provider and relays `partial` and `final` events back.
4. On stop, the server asks the provider to flush (`audioStreamEnd` for Gemini, `end` for whisper), joins the final segments, saves one row, and replies `saved` with the record.

The Gemini API key stays on the server; the browser never talks to Google directly.

**Code map**

```
server/            Node + TypeScript API
  src/app.ts         Express app, static UI, WebSocket server
  src/live.ts        WebSocket session: start / audio / stop, save on finish
  src/stt/           Provider interface + Gemini Live and Whisper implementations
  src/routes/        REST CRUD with zod validation
  src/repository.ts  SQL (parameterized, no ORM)
  migrations/        Plain SQL migrations, applied on boot
  test/              API, WebSocket (mock provider) and unit tests
  scripts/stream-wav.ts  Streams a WAV file through the live pipeline from the CLI
web/               React + Vite UI
  public/pcm-worklet.js  Mic resampler (runs on the audio thread)
  src/components/        LiveTranscriber, Dashboard
whisper/           faster-whisper sidecar (FastAPI WebSocket) + segmenter tests
```

## Choosing the speech-to-text engine

| | Gemini Live (`gemini-3.5-transcribe-live`) | faster-whisper (self-hosted) |
| --- | --- | --- |
| Real time | True streaming, interim hypotheses while speaking | Near real time: re-transcribes the current utterance every ~1 s, finalizes on a 0.7 s pause |
| Hindi-English mixing | Built-in auto detection and code-switching | Detects one language per utterance; works, but mixed sentences can come out in a single script |
| Cost / hosting | Free tier API key; nothing to host | Open source (MIT); needs CPU and RAM, too heavy for most free app tiers |
| Privacy | Audio goes to Google (free tier data may be used to improve products) | Audio never leaves your infrastructure |
| Limits | 10 min per live session (the server stops at 9.5 min and saves) | Bounded by CPU |

The assignment prefers a self-deployed open-source engine, so both are implemented behind one interface
(`server/src/stt/types.ts`). Locally `docker compose` runs the whisper sidecar; the free cloud deployment
uses Gemini because free app tiers (512 MB RAM) cannot run Whisper comfortably. The whisper sidecar can also be
deployed on its own (see [Deploy](#deploy)) and the app picks it up with one env var.

Whisper notes: the default model is `base` (about real time on 8 CPU cores in Docker). Set `WHISPER_MODEL=small`
for better Hindi accuracy at roughly 2-3x the latency. A short Hinglish `initial_prompt` nudges Whisper to keep
romanized Hindi instead of translating it.

## Run locally

Requires Node 20+ and Docker.

```bash
# 1. Postgres (port 5433) and the whisper sidecar (port 8001; first start downloads the model)
docker compose up -d db whisper

# 2. API server
cd server
cp .env.example .env        # add GEMINI_API_KEY to enable Gemini; WHISPER_URL is already set
npm install
npm run dev                 # http://localhost:8080, applies migrations on boot

# 3. UI with hot reload (proxies /api and /ws to :8080)
cd ../web
npm install
npm run dev                 # http://localhost:5173
```

Or build the UI once (`cd web && npm run build`) and open http://localhost:8080, which serves it directly.

The whole stack in containers: `GEMINI_API_KEY=... docker compose --profile app up --build` then open http://localhost:8080.

Without a mic, stream a 16 kHz mono WAV through the real pipeline:

```bash
cd server
npm run stream-wav -- sample.wav --provider whisper
```

## Tests

```bash
docker compose up -d db
cd server && npm test        # creates and migrates the stt_test database automatically
cd ../whisper && python -m pytest -q test_segmenter.py   # needs numpy + pytest
```

The WebSocket tests use a mock provider, so they need no API key or network.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness |
| GET | `/api/config` | Configured providers and the default |
| GET | `/api/transcriptions?q=&limit=20&offset=0` | List, newest first, with `total` for paging; `q` searches title and text |
| GET | `/api/transcriptions/:id` | One transcription |
| POST | `/api/transcriptions` | Create `{ text, title?, language?, provider?, durationMs? }` |
| PUT / PATCH | `/api/transcriptions/:id` | Update any of `{ title, text, language }` |
| DELETE | `/api/transcriptions/:id` | Delete (204) |
| WS | `/ws/transcribe` | Live session, protocol documented in `server/src/live.ts` |

Validation errors return `400 { error, issues: [{ path, message }] }`; missing rows return `404`.

### Data model

```sql
transcriptions (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(200), text TEXT NOT NULL,
  language VARCHAR(32),          -- "auto" or the hint list, e.g. "hi-IN,en-IN"
  provider VARCHAR(32),          -- gemini | whisper | manual
  duration_ms INTEGER,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
```

## Deploy

Free setup: **Neon** (Postgres) + **Render** (Docker web service, supports WebSockets).

1. Create a Neon project and copy the connection string.
2. Get a Gemini API key at https://aistudio.google.com/apikey.
3. On Render, create a Blueprint from this repo (`render.yaml`), then set `DATABASE_URL` and `GEMINI_API_KEY`.
   Migrations run on boot. The free plan sleeps after inactivity, so the first request can take ~30-60 s.

Optional, self-hosted Whisper in the cloud: the `whisper/` folder is a standalone Docker image. It can run as a
Hugging Face Docker Space (free CPU tier, 16 GB RAM; set `app_port: 8001` in the Space README) or any VM. Then set
`WHISPER_URL=wss://<host>/ws` on the web service and the engine shows up in the dropdown.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://stt:stt@localhost:5433/stt` | Postgres connection |
| `DATABASE_SSL` | `false` | `true` for hosted Postgres that requires TLS |
| `GEMINI_API_KEY` | (empty) | Enables the Gemini provider |
| `GEMINI_MODEL` | `gemini-3.5-transcribe-live` | Live transcription model |
| `WHISPER_URL` | (empty) | Enables the whisper provider, e.g. `ws://localhost:8001/ws` |
| `STT_PROVIDER` | first configured | Default engine |
| `WHISPER_MODEL` (sidecar) | `base` | `tiny`, `base`, `small`, `medium`, ... |

## Limitations and next steps

- No authentication; every visitor shares one history. Next: user accounts and per-user rows.
- Gemini sessions are capped at 10 minutes; long recordings would need transparent reconnects.
- Whisper partials re-transcribe the whole utterance, so CPU cost grows with utterance length (capped at 20 s).
- Text-to-speech uses the browser's voices, so Hindi playback quality depends on the OS. An open-source server-side
  option (for example Piper with a Hindi voice) would make it consistent.

## AI tool usage

<!-- TODO before submitting: edit this section so it describes exactly how you used AI tools. -->
Built with Claude Code (Anthropic) as an AI pair programmer. It was used to scaffold the project, look up the
current Gemini Live API docs and SDK types, write the test suites, and draft this README. The plan (stack, two
STT engines behind one interface, deployment target) was agreed before any code was written, and each step was
verified by running it: the test suites, streaming recorded speech through the whisper pipeline and the production
Docker image, and exercising the dashboard in a browser.
