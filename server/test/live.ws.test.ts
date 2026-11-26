import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type pg from 'pg';
import { MockProvider, resetDb, setupDb, startTestServer } from './helpers.js';
import type { SttHandlers, SttProvider, SttSession } from '../src/stt/types.js';
import type { LiveOptions } from '../src/live.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowCount = async () => (await pool.query('SELECT count(*)::int AS n FROM transcriptions')).rows[0].n as number;

/** Provider whose handlers the test drives by hand. */
class ScriptedProvider implements SttProvider {
  readonly name = 'scripted';
  handlers!: SttHandlers;
  chunks: Buffer[] = [];
  closed = 0;
  constructor(private readonly startDelayMs = 0) {}
  async start(_: unknown, handlers: SttHandlers): Promise<SttSession> {
    this.handlers = handlers;
    if (this.startDelayMs) await sleep(this.startDelayMs);
    return {
      sendAudio: (pcm) => {
        this.chunks.push(pcm);
      },
      finish: async () => {},
      close: () => {
        this.closed += 1;
      },
    };
  }
}

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

async function connect(providers: SttProvider[], live?: Partial<LiveOptions>) {
  const { wsUrl, close } = await startTestServer(pool, providers, live);
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

  it('sends "empty" and saves nothing when no speech was recognized', async () => {
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
    await next('empty');
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

describe('WebSocket edge cases', () => {
  it('rejects stop before start and a second start', async () => {
    const { ws, messages, next } = await connect([new MockProvider()]);
    ws.send(JSON.stringify({ type: 'stop' }));
    expect((await next('error')).message).toBe('Not recording');
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(JSON.stringify({ type: 'start' }));
    await sleep(100);
    expect(messages.filter((m) => m.type === 'error').map((m) => m.message)).toContain('Recording already started');
    ws.close();
  });

  it('ignores audio sent before start', async () => {
    const mock = new MockProvider(['x']);
    const { ws, next } = await connect([mock]);
    ws.send(oneSecond);
    await sleep(50);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(JSON.stringify({ type: 'stop' }));
    expect(((await next('saved')).transcription as { durationMs: number }).durationMs).toBe(0);
    expect(mock.receivedBytes).toBe(0);
    ws.close();
  });

  it('keeps PCM samples aligned when frames have an odd byte count', async () => {
    const p = new ScriptedProvider();
    const { ws, next } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.send(Buffer.alloc(3)); // 1 sample + stray byte
    ws.send(Buffer.alloc(5)); // stray + 5 bytes = 3 samples
    await sleep(100);
    expect(p.chunks.map((c) => c.length)).toEqual([2, 6]);
    ws.close();
  });

  it('saves what was finalized when the engine dies mid-recording', async () => {
    const p = new ScriptedProvider();
    const { ws, next } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    p.handlers.onFinal('first sentence');
    p.handlers.onError(new Error('Gemini Live closed (1011): quota exceeded'), true);
    const err = await next('error');
    expect(err).toMatchObject({ message: 'Gemini Live closed (1011): quota exceeded', fatal: true });
    expect(((await next('saved')).transcription as { text: string }).text).toBe('first sentence');
    expect(p.closed).toBe(1);
    ws.close();
  });

  it('keeps recording after a non-fatal engine error', async () => {
    const p = new ScriptedProvider();
    const { ws, messages, next } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    p.handlers.onError(new Error('Whisper failed on one chunk'));
    p.handlers.onFinal('still going');
    ws.send(JSON.stringify({ type: 'stop' }));
    expect(((await next('saved')).transcription as { text: string }).text).toBe('still going');
    expect(messages.find((m) => m.type === 'error')).not.toHaveProperty('fatal');
    ws.close();
  });

  it('saves finalized text when the client disconnects mid-recording', async () => {
    const p = new ScriptedProvider();
    const { ws, next } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    p.handlers.onFinal('tab was closed after this');
    await next('final');
    ws.terminate();
    await sleep(200);
    const rows = await pool.query('SELECT text, provider FROM transcriptions');
    expect(rows.rows).toEqual([{ text: 'tab was closed after this', provider: 'scripted' }]);
    expect(p.closed).toBe(1);
  });

  it('saves nothing when the client disconnects before any text', async () => {
    const p = new ScriptedProvider();
    const { ws, next } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    ws.terminate();
    await sleep(200);
    expect(await rowCount()).toBe(0);
    expect(p.closed).toBe(1);
  });

  it('closes the engine session when the client leaves while it is still connecting', async () => {
    const p = new ScriptedProvider(300);
    const { ws } = await connect([p]);
    ws.send(JSON.stringify({ type: 'start' }));
    await sleep(50);
    ws.terminate();
    await sleep(500);
    expect(p.closed).toBe(1);
  });

  it('times out an engine that never connects, and closes it if it connects later', async () => {
    const p = new ScriptedProvider(400);
    const { ws, next } = await connect([p], { startTimeoutMs: 100 });
    ws.send(JSON.stringify({ type: 'start' }));
    expect((await next('error')).message).toContain('did not respond within 0.1 s');
    await sleep(500);
    expect(p.closed).toBe(1);
    ws.close();
  });

  it('stops and saves at the session length cap', async () => {
    const p = new ScriptedProvider();
    const { ws, next } = await connect([p], { maxSessionMs: 200 });
    ws.send(JSON.stringify({ type: 'start' }));
    await next('ready');
    p.handlers.onFinal('long meeting');
    expect((await next('notice')).message).toContain('limited to');
    expect(((await next('saved')).transcription as { text: string }).text).toBe('long meeting');
    ws.close();
  });

  it('runs concurrent recordings independently', async () => {
    const { wsUrl, close } = await startTestServer(pool, [new MockProvider(['one']), Object.assign(new MockProvider(['two']), { name: 'mock2' })]);
    stopServer = close;
    const run = async (provider: string) => {
      const ws = new WebSocket(wsUrl);
      await new Promise((r) => ws.once('open', r));
      const saved = new Promise<string>((resolve) =>
        ws.on('message', (d) => {
          const m = JSON.parse(d.toString());
          if (m.type === 'ready') {
            ws.send(oneSecond);
            ws.send(JSON.stringify({ type: 'stop' }));
          }
          if (m.type === 'saved') resolve(m.transcription.text);
        }),
      );
      ws.send(JSON.stringify({ type: 'start', provider }));
      const text = await saved;
      ws.close();
      return text;
    };
    expect(await Promise.all([run('mock'), run('mock2'), run('mock')])).toEqual(['one', 'two', 'one']);
    expect(await rowCount()).toBe(3);
  });
});
