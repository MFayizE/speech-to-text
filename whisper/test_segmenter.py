import numpy as np

from segmenter import SAMPLE_RATE, Segmenter


def frame(seconds: float, loud: bool) -> bytes:
    n = int(seconds * SAMPLE_RATE)
    if not loud:
        return np.zeros(n, dtype="<i2").tobytes()
    t = np.arange(n) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 220 * t) * 8000).astype("<i2").tobytes()


def feed_all(seg: Segmenter, chunks: list[bytes]):
    jobs = []
    for c in chunks:
        jobs.extend(seg.feed(c))
    return jobs


def test_silence_only_produces_nothing():
    seg = Segmenter()
    assert feed_all(seg, [frame(0.1, False)] * 30) == []
    assert seg.flush() is None


def test_partials_while_speaking_then_final_after_pause():
    seg = Segmenter(partial_every_s=1.0, silence_s=0.7)
    jobs = feed_all(seg, [frame(0.1, True)] * 25 + [frame(0.1, False)] * 8)
    kinds = [j.kind for j in jobs]
    assert kinds.count("partial") == 2
    assert kinds[-1] == "final"
    # final audio holds the speech plus the trailing pause
    assert jobs[-1].audio.size >= int(2.5 * SAMPLE_RATE)


def test_long_utterance_is_force_finalized():
    seg = Segmenter(max_utterance_s=3.0, partial_every_s=100)
    jobs = feed_all(seg, [frame(0.1, True)] * 31)
    assert [j.kind for j in jobs] == ["final"]


def test_flush_returns_buffered_speech():
    seg = Segmenter()
    feed_all(seg, [frame(0.1, True)] * 5)
    job = seg.flush()
    assert job is not None and job.kind == "final"
    assert seg.flush() is None


def test_too_short_blip_is_ignored():
    seg = Segmenter(min_speech_s=0.3)
    feed_all(seg, [frame(0.1, True)])
    assert seg.flush() is None


def test_odd_byte_count_is_tolerated():
    seg = Segmenter()
    assert seg.feed(frame(0.1, True) + b"\x00") == []
