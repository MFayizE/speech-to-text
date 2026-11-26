export interface MicRecorder {
  stop(): Promise<void>;
}

/**
 * Starts the mic and calls onChunk with 16 kHz PCM16 chunks (~100 ms each).
 * onEnded fires if the mic goes away on its own (unplugged, permission revoked, OS took it).
 */
export async function startMic(
  onChunk: (pcm: ArrayBuffer) => void,
  onLevel: (rms: number) => void,
  onEnded?: () => void,
): Promise<MicRecorder> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access needs a secure page (HTTPS or localhost) and a current browser.');
  }
  if (typeof AudioWorkletNode === 'undefined') {
    throw new Error('This browser does not support AudioWorklet. Use a current Chrome, Edge, Firefox or Safari.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  let stopped = false;
  try {
    // Safari and some mobile browsers create the context suspended until resumed.
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    throw err;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    onChunk(e.data.pcm);
    onLevel(e.data.level);
  };
  source.connect(node);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!stopped) onEnded?.();
    });
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
    },
  };
}
