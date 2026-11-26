# Testing

Everything below was run on 26 Nov 2026 on Windows 11 (8-core CPU, Docker Desktop), Node 22, Postgres 16.
"Live" means the real server talking to the real engines, not mocks.

## How to reproduce

```bash
docker compose up -d db whisper
cd server && npm test                                        # 49 tests, real Postgres
cd ../whisper && python -m pytest -q test_segmenter.py       # 6 tests

# Live: make speech clips with Gemini TTS, stream them through the app at real-time pace
cd ../server
npx tsx scripts/tts-sample.ts hindi.wav "नमस्ते, मेरा नाम राहुल है। मुझे कल तक रिपोर्ट चाहिए।"
npm run stream-wav -- hindi.wav --provider gemini
npm run stream-wav -- hindi.wav --provider whisper --tail 0          # stop mid-speech
npm run stream-wav -- hindi.wav --provider gemini --abort-after 3000 # drop the connection
```

## Automated tests (all passing)

| Suite | Count | Covers |
| --- | --- | --- |
| `server/test/transcriptions.api.test.ts` | 23 | CRUD, validation, pagination, search (case-insensitive, Devanagari, literal `%` and `_`), id bounds, 413 for oversized bodies, 50,000-char limit, NUL characters, cleared title regenerated, wrong body shapes, markup stored as text |
| `server/test/live.ws.test.ts` | 21 | Streaming flow, language hints, empty result, `save=false`, unknown provider, bad control messages, stop before start, double start, audio before start, odd-length PCM frames, engine dying mid-recording, non-fatal engine errors, client disconnect with and without text, client leaving while the engine connects, start timeout, session length cap, last interim text kept, no duplicate of finalized text, connect failure reported once, concurrent sessions |
| `server/test/unit.test.ts` | 5 | Default titles, provider registry |
| `whisper/test_segmenter.py` | 6 | Silence, partial and final timing, forced finalization, flush, short blips, odd byte counts |

## Live engine results

Clips were generated with Gemini TTS (`gemini-3.8-flash-tts`), resampled to 16 kHz, and streamed in real time
(100 ms chunks, then 1 s of silence, then stop). "Saved" is measured from the start of streaming.

**Gemini Live (`gemini-3.5-transcribe-live`), auto language detection**

| Clip (length) | First text | Saved | Result |
| --- | --- | --- | --- |
| Hinglish (5.3 s) | 1.1 s | 7.8 s | `Kal ki meeting 10:00 baje hai. Please join on time. Vendor ka invoice bhi approve karna hai.` (exact) |
| Hindi, Devanagari (4.5 s) | 1.5 s | 6.8 s | `नमस्ते, मेरा नाम राहुल है। मुझे कल तक रिपोर्ट चाहिए।` (exact) |
| English with numbers (7.0 s) | 1.1 s | 9.3 s | `Please raise purchase order number 4521 for 25 laptops, delivery by the 15th of December.` (exact) |
| Mixed meeting, 7 sentences (14.9 s) | 0.9 s | 18.0 s | Exact, all seven sentences, Hinglish kept as spoken |
| Hinglish with `hi-IN,en-IN` hint | 1.7 s | 8.3 s | Same as auto |

Observed: interim text for Hinglish sometimes appears in Devanagari, and the final text then comes back romanized.
That is model behavior; the saved text is the final.

**Whisper sidecar (faster-whisper, CPU int8)**

| Setting | Hindi | Hinglish | English | 15 s mixed |
| --- | --- | --- | --- | --- |
| `base` + default prompt (shipped default) | English meaning (`Namaste. My name is Rahul. I want a report tomorrow.`) | English meaning | Exact | English meaning, complete |
| `base`, no prompt | Urdu script | Urdu script + English | Exact | English |
| `base` + Devanagari prompt | Devanagari, many word errors | Garbled | Exact | Mostly lost (decoder looped, 62 s) |
| `small` + default prompt | Mostly correct Devanagari | Lost: slower than real time | Exact but 15.8 s | Mostly lost |

Conclusion: on CPU, `base` is the only setting that keeps up with live speech. Gemini is the engine for faithful
Hindi and Hinglish; Whisper is the self-hosted option that is exact on English.

## Live failure and edge cases

| Scenario | How | Result |
| --- | --- | --- |
| Invalid Gemini API key | Server started with a fake key | One clear error: `API key not valid`; nothing saved |
| Session length cap | `MAX_SESSION_MS=4000`, 15 s clip | Notice shown, text up to the cap saved |
| Client drops mid-sentence | `--abort-after 6000` | Text heard so far saved (`Good morning team, aaj ka agenda simple hai. First, hum Q3 ke vendor...`) |
| Stop mid-sentence, no pause | `--tail 0` | Full sentence saved, about 1 s after stop |
| Silence only | 3 s of low noise | `empty`, nothing saved |
| Three Gemini sessions at once | Hindi, English, Hinglish in parallel | All three exact, saved independently |
| Whisper container killed mid-recording | `docker kill` at 8 s | `Whisper service disconnected` (fatal), text so far saved, Gemini unaffected |
| Start while Whisper is down | Container stopped | `Cannot reach the Whisper service...`; internal URL kept in server logs only |

## UI tests (browser, real server)

| Scenario | Result |
| --- | --- |
| Full recording (fake mic playing a speech clip), Gemini, phone size, dark theme | Live text, save, playback and copy all work |
| Mic permission denied / no mic | Specific message with the fix; socket closed; button re-enabled |
| Server unreachable when pressing Start | "Cannot reach the server"; the mic is released even though permission resolved after the failure |
| Server killed mid-recording | Recording ends, mic and socket released, transcript stays on screen |
| Mic unplugged mid-recording | Recording ends cleanly and the reason is shown |
| Switch to History and back while recording | Recording continues |
| Session cap reached | Neutral notice, then save or "no speech" |
| Markup in title and text | Rendered as text; no element injected, no script run |
| Search for `%`, no-results search | Literal match; empty state with "Clear search" |
| Delete the only row on the last page | Moves back to the previous page |
| Edit or delete a row already deleted in another tab | Delete treated as done; edit shows "no longer exists" and refreshes |
| Whitespace-only edit, Escape key | Save disabled; Escape cancels |
| Layout at 375, 768, 1280, 1440 px, light and dark | No horizontal scroll, no console errors |

## Bugs found by this testing and fixed

1. Search treated `%` and `_` as wildcards (`%` matched every row).
2. Oversized request bodies returned 500 instead of 413.
3. Text containing a NUL character returned 500.
4. Clearing a title saved an empty heading.
5. When the browser failed to reach the server while the mic prompt was open, the mic stayed on.
6. A dead engine left the UI stuck on "Listening".
7. Closing the tab mid-recording lost everything already transcribed.
8. A client leaving while the engine was connecting leaked the engine session.
9. No timeout if the engine never accepted the session, and none if the server never confirmed a save.
10. Odd-length audio frames could misalign PCM samples.
11. Gemini saves waited a fixed 4 s because the transcribe model does not always send `turnComplete`.
12. Whisper could return nothing when it fell behind real time, because the server stopped waiting after 15 s and dropped the interim text. Now the last interim text is kept and the wait is 45 s.
13. The Whisper sidecar crashed when the client left during transcription.
14. `docker-compose.yml` did not pass `WHISPER_INITIAL_PROMPT` to the sidecar.
15. A failed Gemini connect was reported twice.
16. History action errors were labeled "Could not load history", and a stale-edit message was cleared by the reload.

## Not tested

- A human speaking into a real microphone (all audio was synthetic speech played through a fake mic or streamed).
- Real phones (Safari on iOS, Chrome on Android); only browser emulation at phone sizes.
- The deployed cloud build (Render + Neon), including TLS and proxy timeouts.
- A full 9.5-minute session at real-time pace (the cap was tested at 4 s).
- Whisper on a GPU.
