/**
 * AudioWorklet: converts mic audio (usually 44.1 or 48 kHz float32) to 16 kHz mono PCM16
 * and posts ~100 ms chunks to the main thread, plus an RMS level for the meter.
 * Doing the resampling here works in every browser, unlike AudioContext({ sampleRate: 16000 })
 * which Firefox refuses to connect to a mic stream.
 */
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0; // fractional read position into the incoming stream
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outIndex = 0;
    this.sumSquares = 0;
    this.last = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    // Linear-interpolation resampler over this 128-sample block.
    // position may start in [-1, 0): index -1 is the last sample of the previous block.
    while (this.position < channel.length - 1) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const a = i < 0 ? this.last : channel[i];
      const sample = a + (channel[i + 1] - a) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.sumSquares += clamped * clamped;

      if (this.outIndex === CHUNK_SAMPLES) {
        const level = Math.sqrt(this.sumSquares / CHUNK_SAMPLES);
        this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
        this.out = new Int16Array(CHUNK_SAMPLES);
        this.outIndex = 0;
        this.sumSquares = 0;
      }
      this.position += this.ratio;
    }
    this.position -= channel.length;
    this.last = channel[channel.length - 1];
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
