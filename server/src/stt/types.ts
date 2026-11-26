/**
 * Speech-to-text provider abstraction.
 *
 * Audio contract for every provider: raw 16-bit little-endian PCM, mono, 16 kHz.
 * The browser converts mic audio to this format before sending it.
 */
export interface SttHandlers {
  /** Speculative text for the utterance in progress. Replaces the previous partial. */
  onPartial(text: string): void;
  /** Finalized text for one utterance. Append to the transcript. */
  onFinal(text: string): void;
  /**
   * fatal = the engine connection is gone (bad key, quota, network, crash), so no more text will arrive.
   * Non-fatal errors (one failed chunk) leave the session running.
   */
  onError(err: Error, fatal?: boolean): void;
}

export interface SttStartOptions {
  /** BCP-47 hints, e.g. ["hi-IN", "en-IN"]. Empty means auto-detect (code-mixing allowed). */
  languageCodes: string[];
}

export interface SttSession {
  sendAudio(pcm16: Buffer): void;
  /** Tells the provider the user stopped talking; resolves once remaining text is flushed. */
  finish(): Promise<void>;
  /** Hard close without waiting. Safe to call more than once. */
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  start(options: SttStartOptions, handlers: SttHandlers): Promise<SttSession>;
}
