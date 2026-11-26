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
 *   {"type":"saved","transcription"} | {"type":"empty"}
 *   {"type":"error","message"}
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
/** Gemini live transcription sessions are capped at 10 minutes; stop a little before that. */
const MAX_SESSION_MS = 9.5 * 60 * 1000;

export interface LiveDeps {
  repo: TranscriptionRepository;
  registry: ProviderRegistry;
}

export function handleLiveConnection(ws: WebSocket, _req: IncomingMessage, { repo, registry }: LiveDeps): void {
  let session: SttSession | null = null;
  let providerName = '';
  let languageCodes: string[] = [];
  let starting = false;
  let stopping = false;
  let bytes = 0;
  let maxTimer: NodeJS.Timeout | undefined;
  const finals: string[] = [];

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (message: string) => send({ type: 'error', message });

  async function start(provider: string | undefined, codes: string[]) {
    if (session || starting) return fail('Recording already started');
    const stt = registry.get(provider);
    if (!stt) {
      return fail(provider ? `Unknown or unconfigured provider "${provider}"` : 'No speech-to-text provider configured');
    }
    starting = true;
    try {
      session = await stt.start(
        { languageCodes: codes },
        {
          onPartial: (text) => send({ type: 'partial', text }),
          onFinal: (text) => {
            finals.push(text.trim());
            send({ type: 'final', text });
          },
          onError: (err) => fail(err.message),
        },
      );
      providerName = stt.name;
      languageCodes = codes;
      maxTimer = setTimeout(() => void stop(true), MAX_SESSION_MS);
      send({ type: 'ready', provider: stt.name });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      starting = false;
    }
  }

  async function stop(save: boolean) {
    if (!session || stopping) return;
    stopping = true;
    clearTimeout(maxTimer);
    try {
      await session.finish();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    session.close();
    session = null;

    const text = finals.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!save) return;
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
      fail(`Could not save transcription: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (!session || stopping) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
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
    session?.close();
    session = null;
  });
}
