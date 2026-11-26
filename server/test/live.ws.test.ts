import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type pg from 'pg';
import { MockProvider, resetDb, setupDb, startTestServer } from './helpers.js';
import type { SttProvider } from '../src/stt/types.js';

type Msg = { type: string; [key: string]: unknown };

let pool: pg.Pool;
let stopServer: (() => Promise<void>) | null = null;

beforeAll(async () => {
  pool = await setupDb();
});
afterAll(() => pool.end());
beforeEach(() => resetDb(pool));
afterEach(async () => {
  await stopServer?.();
  stopServer = null;
});

async function connect(providers: SttProvider[]) {
  const { wsUrl, close } = await startTestServer(pool, providers);
  stopServer = close;
  const ws = new WebSocket(wsUrl);
  const messages: Msg[] = [];
  const waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Msg;
    messages.push(msg);
    for (const w of waiters.filter((w) => w.type === msg.type)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  await new Promise((resolve) => ws.once('open', resolve));
  const next = (type: string) =>
    new Promise<Msg>((resolve, reject) => {
      const seen = messages.find((m) => m.type === type);
      if (seen) return resolve(seen);
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`timed out waiting for ${type}; got ${JSON.stringify(messages)}`)), 3000);
    });
  return { ws, messages, next };
}

// One second of 16 kHz PCM16 audio.
const oneSecond = Buffer.alloc(32_000);

describe('WebSocket /ws/transcribe', () => {
  it('streams partials and finals, then saves the joined transcript', async () => {
    const mock = new MockProvider(['मेरा नाम', 'Fayis hai', 'and I am a developer']);
    const { ws, messages, next } = await connect([mock]);

    ws.send(JSON.stringify({ type: 'start', languageCodes: ['hi-IN', 'en-IN'] }));
    expect(await next('ready')).toEqual({ type: 'ready', provider: 'mock' });

    ws.send(oneSecond);
    ws.send(oneSecond);
    await next('partial');
    ws.send(JSON.stringify({ type: 'stop' }));

    const saved = (await next('saved')).transcription as Record<string, unknown>;
    expect(saved).toMatchObject({
      text: 'मेरा नाम Fayis hai and I am a developer',
      provider: 'mock',
      language: 'hi-IN,en-IN',
      durationMs: 2000,
    });
    expect(mock.lastOptions).toEqual({ languageCodes: ['hi-IN', 'en-IN'] });
    expect(mock.receivedBytes).toBe(64_000);
    expect(messages.filter((m) => m.type === 'final')).toHaveLength(3);

    const row = await pool.query('SELECT text, provider FROM transcriptions');
    expect(row.rows).toEqual([{ text: 'मेरा नाम Fayis hai and I am a developer', provider: 'mock' }]);
    ws.close();
  });

  it('records "auto" when no language hint is given', async () => {
    const { ws, next } = await connect([new MockProvider(['hello'])]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(JSON.stringify({ type: 'stop' }));
    expect(((await next('saved')).transcription as { language: string }).language).toBe('auto');
    ws.close();
  });

  it('sends "empty" and saves nothing when no speech was recognised', async () => {
    const { ws, next } = await connect([new MockProvider([])]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(JSON.stringify({ type: 'stop' }));
    await next('empty');
    expect((await pool.query('SELECT count(*)::int AS n FROM transcriptions')).rows[0].n).toBe(0);
    ws.close();
  });

  it('does not save when the client stops with save=false', async () => {
    const { ws, next } = await connect([new MockProvider(['discard me'])]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(JSON.stringify({ type: 'stop', save: false }));
    await next('final');
    await new Promise((r) => setTimeout(r, 100));
    expect((await pool.query('SELECT count(*)::int AS n FROM transcriptions')).rows[0].n).toBe(0);
    ws.close();
  });

  it('reports an error when no provider is configured', async () => {
    const { ws, next } = await connect([]);
    ws.send(JSON.stringify({ type: 'start' }));
    expect((await next('error')).message).toBe('No speech-to-text provider configured');
    ws.close();
  });

  it('reports an error for an unknown provider and for bad control messages', async () => {
    const { ws, messages, next } = await connect([new MockProvider()]);
    ws.send(JSON.stringify({ type: 'start', provider: 'nope' }));
    expect((await next('error')).message).toContain('Unknown or unconfigured provider "nope"');
    ws.send('not json');
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.filter((m) => m.type === 'error').map((m) => m.message)).toContain('Invalid control message');
    ws.close();
  });

  it('surfaces provider start failures', async () => {
    const broken: SttProvider = {
      name: 'broken',
      start: async () => {
        throw new Error('API key not valid');
      },
    };
    const { ws, next } = await connect([broken]);
    ws.send(JSON.stringify({ type: 'start' }));
    expect((await next('error')).message).toBe('API key not valid');
    ws.close();
  });
});
