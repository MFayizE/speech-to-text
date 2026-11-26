import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import type { SttHandlers, SttProvider, SttSession, SttStartOptions } from './types.js';

/**
 * Gemini Live API, transcription-only model (gemini-3.5-transcribe-live).
 * Streams PCM over a WebSocket held by the server, so the API key never reaches the browser.
 * Interim hypotheses arrive as serverContent.interimInputTranscription,
 * finalized segments (VERBATIM mode, appended) as serverContent.inputTranscription.
 */
export class GeminiLiveProvider implements SttProvider {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly finalizeTimeoutMs = 4000,
  ) {
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  }

  async start(options: SttStartOptions, handlers: SttHandlers): Promise<SttSession> {
    let closed = false;
    let turnDone: (() => void) | null = null;
    // True while the model has shown interim text that has not been finalized yet.
    let pending = false;

    const session: Session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: { languageCodes: options.languageCodes },
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          const content = message.serverContent;
          if (!content) return;
          const interim = content.interimInputTranscription?.text;
          if (interim) {
            pending = true;
            handlers.onPartial(interim);
          }
          const final = content.inputTranscription?.text;
          if (final) {
            pending = false;
            handlers.onFinal(final);
            turnDone?.();
          }
          if (content.turnComplete || content.generationComplete) turnDone?.();
        },
        onerror: (e: ErrorEvent) => {
          if (!closed) handlers.onError(new Error(`Gemini Live error: ${e.message ?? 'unknown'}`));
        },
        onclose: (e: CloseEvent) => {
          turnDone?.();
          // 1000 is a normal close. Anything else (bad key, quota, 10 min limit) is worth surfacing.
          if (!closed && e.code !== 1000) {
            handlers.onError(new Error(`Gemini Live closed (${e.code}): ${e.reason || 'no reason given'}`));
          }
          closed = true;
        },
      },
    });

    return {
      sendAudio(pcm16) {
        if (closed) return;
        session.sendRealtimeInput({ audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      },
      finish: async () => {
        if (closed) return;
        // audioStreamEnd finalizes the turn right away instead of waiting for server-side silence detection.
        const flushed = new Promise<void>((resolve) => {
          turnDone = resolve;
        });
        session.sendRealtimeInput({ audioStreamEnd: true });
        // The transcribe model does not always send turnComplete. If every interim hypothesis is
        // already finalized, a short grace period is enough; otherwise wait for the next final.
        await Promise.race([flushed, delay(pending ? this.finalizeTimeoutMs : 400)]);
      },
      close() {
        if (closed) return;
        closed = true;
        session.close();
      },
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
