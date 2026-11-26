import WebSocket from 'ws';
import type { SttHandlers, SttProvider, SttSession, SttStartOptions } from './types.js';

/**
 * Self-hosted open-source STT: the faster-whisper sidecar in /whisper.
 *
 * Protocol (sidecar side is whisper/app.py):
 *   client -> {"type":"start","language":"hi"|null}, then binary PCM frames, then {"type":"end"}
 *   server -> {"type":"partial","text"} | {"type":"final","text","language"} | {"type":"done"} | {"type":"error","message"}
 */
export class WhisperProvider implements SttProvider {
  readonly name = 'whisper';

  constructor(
    private readonly url: string,
    private readonly finalizeTimeoutMs = 15000,
  ) {}

  async start(options: SttStartOptions, handlers: SttHandlers): Promise<SttSession> {
    const ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(new Error(`Cannot reach whisper service at ${this.url}: ${err.message}`)));
    });

    let done: (() => void) | null = null;
    let closed = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { type: string; text?: string; message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'partial' && msg.text) handlers.onPartial(msg.text);
      else if (msg.type === 'final' && msg.text) handlers.onFinal(msg.text);
      else if (msg.type === 'error') handlers.onError(new Error(msg.message ?? 'whisper error'));
      else if (msg.type === 'done') done?.();
    });
    ws.on('close', () => {
      closed = true;
      done?.();
    });
    ws.on('error', (err) => {
      if (!closed) handlers.onError(err);
    });

    // Whisper takes ISO 639-1 codes ("hi"), so "hi-IN" becomes "hi". Several hints means auto-detect.
    const language = options.languageCodes.length === 1 ? options.languageCodes[0].split('-')[0] : null;
    ws.send(JSON.stringify({ type: 'start', language }));

    return {
      sendAudio(pcm16) {
        if (!closed && ws.readyState === WebSocket.OPEN) ws.send(pcm16);
      },
      finish: async () => {
        if (closed) return;
        const flushed = new Promise<void>((resolve) => {
          done = resolve;
        });
        ws.send(JSON.stringify({ type: 'end' }));
        await Promise.race([flushed, new Promise((r) => setTimeout(r, this.finalizeTimeoutMs))]);
      },
      close() {
        if (closed) return;
        closed = true;
        ws.close();
      },
    };
  }
}
