export interface MicRecorder {
  stop(): Promise<void>;
}

/** Starts the mic and calls onChunk with 16 kHz PCM16 chunks (~100 ms each). */
export async function startMic(onChunk: (pcm: ArrayBuffer) => void, onLevel: (rms: number) => void): Promise<MicRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access needs HTTPS (or localhost) and a modern browser.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    onChunk(e.data.pcm);
    onLevel(e.data.level);
  };
  source.connect(node);

  return {
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
