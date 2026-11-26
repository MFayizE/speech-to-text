"""Turns a live PCM stream into "partial" and "final" transcription jobs.

Whisper is not a streaming model, so near real-time works like this:
  * audio for the current utterance accumulates in a buffer;
  * every PARTIAL_EVERY_S of new audio the whole buffer is re-transcribed -> partial text;
  * when the speaker pauses (trailing silence >= SILENCE_S) or the buffer hits MAX_UTTERANCE_S,
    the buffer is transcribed one last time -> final text, and the buffer resets.

Pure logic, no model calls, so it can be unit tested.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000


@dataclass
class Job:
    kind: str  # "partial" | "final"
    audio: np.ndarray  # float32 mono in [-1, 1]


class Segmenter:
    def __init__(
        self,
        partial_every_s: float = 1.0,
        silence_s: float = 0.7,
        max_utterance_s: float = 20.0,
        min_speech_s: float = 0.3,
        energy_threshold: float = 0.01,
    ) -> None:
        self.partial_every = int(partial_every_s * SAMPLE_RATE)
        self.silence_needed = int(silence_s * SAMPLE_RATE)
        self.max_samples = int(max_utterance_s * SAMPLE_RATE)
        self.min_speech = int(min_speech_s * SAMPLE_RATE)
        self.energy_threshold = energy_threshold
        self._reset()

    def _reset(self) -> None:
        self.chunks: list[np.ndarray] = []
        self.samples = 0
        self.speech_samples = 0
        self.trailing_silence = 0
        self.since_partial = 0

    def _audio(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)

    def feed(self, pcm16: bytes) -> list[Job]:
        """Adds one frame of 16-bit little-endian PCM. Returns jobs to run, oldest first."""
        if len(pcm16) % 2:
            pcm16 = pcm16[:-1]
        frame = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        if frame.size == 0:
            return []

        voiced = float(np.sqrt(np.mean(frame**2))) >= self.energy_threshold
        if voiced:
            self.speech_samples += frame.size
            self.trailing_silence = 0
        else:
            self.trailing_silence += frame.size

        # Leading silence: keep only a short tail so the utterance start is not clipped.
        if self.speech_samples == 0:
            self.chunks = [frame]
            self.samples = frame.size
            return []

        self.chunks.append(frame)
        self.samples += frame.size
        self.since_partial += frame.size

        if self.trailing_silence >= self.silence_needed or self.samples >= self.max_samples:
            job = self._finalize()
            return [job] if job else []

        if self.since_partial >= self.partial_every and voiced:
            self.since_partial = 0
            return [Job("partial", self._audio())]
        return []

    def _finalize(self) -> Job | None:
        audio = self._audio()
        enough_speech = self.speech_samples >= self.min_speech
        self._reset()
        return Job("final", audio) if enough_speech else None

    def flush(self) -> Job | None:
        """Called when the client stops: finalize whatever is buffered."""
        return self._finalize()
