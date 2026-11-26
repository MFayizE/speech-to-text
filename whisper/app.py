"""Self-hosted speech-to-text sidecar built on faster-whisper (open source, runs on CPU).

WebSocket /ws protocol:
  client -> {"type":"start","language":"hi"|null}, binary 16 kHz PCM16 frames, {"type":"end"}
  server -> {"type":"partial","text"} | {"type":"final","text","language"} | {"type":"done"} | {"type":"error","message"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

from segmenter import Job, Segmenter

log = logging.getLogger("whisper")
logging.basicConfig(level=logging.INFO)

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
# Nudges Whisper toward romanized Hinglish instead of translating or switching scripts mid-sentence.
INITIAL_PROMPT = os.getenv("WHISPER_INITIAL_PROMPT", "Hello, aap kaise ho? Main theek hoon. Let's start the meeting.")

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    log.info("Loading faster-whisper model %s (%s, %s)", MODEL_NAME, DEVICE, COMPUTE_TYPE)
    model = await asyncio.to_thread(WhisperModel, MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE, num_workers=2)
    log.info("Model ready")
    yield


app = FastAPI(title="Whisper STT sidecar", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": model is not None, "model": MODEL_NAME}


def transcribe(audio: np.ndarray, language: str | None, final: bool) -> tuple[str, str]:
    assert model is not None
    segments, info = model.transcribe(
        audio,
        language=language,
        task="transcribe",
        beam_size=3 if final else 1,
        vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt=INITIAL_PROMPT or None,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return text, info.language


@app.websocket("/ws")
async def ws_transcribe(ws: WebSocket) -> None:
    await ws.accept()
    segmenter = Segmenter()
    language: str | None = None
    lock = asyncio.Lock()  # one model call at a time per connection, in order
    pending: set[asyncio.Task] = set()

    async def run(job: Job) -> None:
        async with lock:
            try:
                text, lang = await asyncio.to_thread(transcribe, job.audio, language, job.kind == "final")
            except Exception as exc:  # noqa: BLE001
                log.exception("transcription failed")
                await ws.send_json({"type": "error", "message": f"Whisper failed: {exc}"})
                return
            if text:
                msg = {"type": job.kind, "text": text}
                if job.kind == "final":
                    msg["language"] = lang
                await ws.send_json(msg)

    def schedule(job: Job) -> None:
        # Partials are best effort: skip one if the model is still busy, finals always run.
        if job.kind == "partial" and lock.locked():
            return
        task = asyncio.create_task(run(job))
        pending.add(task)
        task.add_done_callback(pending.discard)

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                for job in segmenter.feed(message["bytes"]):
                    schedule(job)
                continue
            data = json.loads(message.get("text") or "{}")
            if data.get("type") == "start":
                language = data.get("language") or None
            elif data.get("type") == "end":
                job = segmenter.flush()
                if job:
                    schedule(job)
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                await ws.send_json({"type": "done"})
    except WebSocketDisconnect:
        pass
    finally:
        for task in pending:
            task.cancel()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8001")))
