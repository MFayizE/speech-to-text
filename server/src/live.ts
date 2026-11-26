import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { WebSocket, type RawData } from 'ws';
import type { TranscriptionRepository } from './repository.js';
import type { ProviderRegistry } from './stt/registry.js';
import type { SttSession } from './stt/types.js';

/**
 * One WebSocket per recording.
 *
 * client -> server
 *   {"type":"start","provider"?: "gemini"|"whisper","languageCodes"?: ["hi-IN","en-IN"]}
 *   binary frames: 16 kHz mono PCM16 little-endian
 *   {"type":"stop","save"?: true}
 *
 * server -> client
 *   {"type":"ready","provider"}
 *   {"type":"partial","text"}      speculative text of the utterance in progress
 *   {"type":"final","text"}        finalized utterance, append to transcript
 *   {"type":"saved","transcription"} | {"type":"empty"}   the recording is over
 *   {"type":"error","message","fatal"?}   fatal=true: the engine is gone, the server is ending the recording
 *   {"type":"notice","message"}    informational, e.g. the session length cap was reached
 *
 * Edge cases handled here:
 *   - engine dies mid-recording: the client is told, and the text so far is saved
 *   - client disconnects mid-recording (tab closed, network drop): the text so far is saved
 *   - client disconnects while the engine is still connecting: the engine session is closed, not leaked
 *   - engine never answers: start times out
 *   - frames with an odd byte count: the stray byte is carried into the next frame
 *   - session length cap (Gemini allows 10 minutes): stopped and saved automatically
 */
const controlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    provider: z.string().max(32).optional(),
    languageCodes: z.array(z.string().max(16)).max(5).default([]),
  }),
  z.object({ type: z.literal('stop'), save: z.boolean().default(true) }),
]);

const BYTES_PER_SECOND = 16_000 * 2;

export interface LiveOptions {
  maxSessionMs: number;
  startTimeoutMs: number;
}

export interface LiveDeps {
  repo: TranscriptionRepository;
  registry: ProviderRegistry;
  options?: Partial<LiveOptions>;
}

type State = 'idle' | 'starting' | 'recording' | 'stopping' | 'done';

export function handleLiveConnection(ws: WebSocket, _req: IncomingMessage, { repo, registry, options }: LiveDeps): void {
  const maxSessionMs = options?.maxSessionMs ?? 9.5 * 60 * 1000;
  const startTimeoutMs = options?.startTimeoutMs ?? 10_000;

  let state: State = 'idle';
  let session: SttSession | null = null;
  let providerName = '';
  let languageCodes: string[] = [];
  let bytes = 0;
  let carry: Buffer | null = null;
  let maxTimer: NodeJS.Timeout | undefined;
  const finals: string[] = [];

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message: string, fatal = false) => send(fatal ? { type: 'error', message, fatal } : { type: 'error', message });
  const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function start(provider: string | undefined, codes: string[]) {
    if (state !== 'idle') return fail(state === 'done' ? 'This recording has ended; open a new connection' : 'Recording already started');
    const stt = registry.get(provider);
    if (!stt) {
      return fail(provider ? `Unknown or unconfigured provider "${provider}"` : 'No speech-to-text provider configured');
    }
    state = 'starting';
    let timer: NodeJS.Timeout | undefined;
    let abandoned = false;
    try {
      const opened = stt.start(
        { languageCodes: codes },
        {
          onPartial: (text) => send({ type: 'partial', text }),
          onFinal: (text) => {
            finals.push(text.trim());
            send({ type: 'final', text });
          },
          onError: (err, fatal) => {
            fail(err.message, fatal);
            // Nothing more will arrive from a dead engine: end the recording and keep what we have.
            if (fatal && state === 'recording') void stop(true);
          },
        },
      );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Speech engine "${stt.name}" did not respond within ${startTimeoutMs / 1000} s`)), startTimeoutMs);
      });
      // If the timeout wins, close the engine session whenever it does open.
      opened.then(
        (s) => abandoned && s.close(),
        () => {},
      );
      const s = await Promise.race([opened, timeout]);

      if (ws.readyState !== WebSocket.OPEN) {
        // Client left while we were connecting; do not leak the engine session.
        s.close();
        state = 'done';
        return;
      }
      session = s;
      providerName = stt.name;
      languageCodes = codes;
      state = 'recording';
      maxTimer = setTimeout(() => {
        const minutes = Math.round((maxSessionMs / 60_000) * 10) / 10;
        send({ type: 'notice', message: `Recordings are limited to ${minutes} minutes, so this one was stopped and saved.` });
        void stop(true);
      }, maxSessionMs);
      send({ type: 'ready', provider: stt.name });
    } catch (err) {
      abandoned = true;
      state = 'idle';
      fail(messageOf(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async function save(): Promise<void> {
    const text = finals.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      send({ type: 'empty' });
      return;
    }
    try {
      const transcription = await repo.create({
        text,
        language: languageCodes.length ? languageCodes.join(',') : 'auto',
        provider: providerName,
        durationMs: Math.round((bytes / BYTES_PER_SECOND) * 1000),
      });
      send({ type: 'saved', transcription });
    } catch (err) {
      fail(`Could not save the transcription: ${messageOf(err)}`, true);
    }
  }

  async function stop(shouldSave: boolean) {
    if (state === 'idle' || state === 'starting') return fail('Not recording');
    if (state !== 'recording' || !session) return;
    state = 'stopping';
    clearTimeout(maxTimer);
    const s = session;
    try {
      await s.finish();
    } catch (err) {
      fail(messageOf(err));
    }
    s.close();
    session = null;
    state = 'done';
    if (shouldSave) await save();
    else send({ type: 'empty' });
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (state !== 'recording' || !session) return;
      let buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (carry) {
        buf = Buffer.concat([carry, buf]);
        carry = null;
      }
      // PCM16 samples are 2 bytes; keep a stray byte for the next frame.
      if (buf.length % 2) {
        carry = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (!buf.length) return;
      bytes += buf.length;
      session.sendAudio(buf);
      return;
    }
    let msg: z.infer<typeof controlSchema>;
    try {
      msg = controlSchema.parse(JSON.parse(data.toString()));
    } catch {
      return fail('Invalid control message');
    }
    if (msg.type === 'start') void start(msg.provider, msg.languageCodes);
    else void stop(msg.save);
  });

  ws.on('close', () => {
    clearTimeout(maxTimer);
    if (state === 'recording' && session) {
      // Tab closed or network dropped mid-recording: keep what was already transcribed.
      const s = session;
      session = null;
      state = 'done';
      s.close();
      if (finals.some(Boolean)) void save().catch(() => {});
    }
  });
}
