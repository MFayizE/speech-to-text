import pg from 'pg';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildServer } from '../src/app.js';
import { migrate } from '../src/db.js';
import { TranscriptionRepository } from '../src/repository.js';
import { ProviderRegistry } from '../src/stt/registry.js';
import type { SttHandlers, SttProvider, SttSession, SttStartOptions } from '../src/stt/types.js';

export const TEST_DB_URL = process.env.DATABASE_URL_TEST ?? 'postgres://stt:stt@localhost:5433/stt_test';

/** Creates the test database if it does not exist yet. */
export async function ensureTestDatabase(): Promise<void> {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export async function setupDb(): Promise<pg.Pool> {
  await ensureTestDatabase();
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 3 });
  await migrate(pool);
  return pool;
}

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE transcriptions RESTART IDENTITY');
}

/**
 * Fake provider: emits a partial for each audio frame and the scripted finals when the user stops.
 * Lets the WebSocket flow be tested without network calls or an API key.
 */
export class MockProvider implements SttProvider {
  readonly name = 'mock';
  lastOptions: SttStartOptions | null = null;
  receivedBytes = 0;

  constructor(private readonly finals: string[] = ['namaste', 'how are you']) {}

  async start(options: SttStartOptions, handlers: SttHandlers): Promise<SttSession> {
    this.lastOptions = options;
    return {
      sendAudio: (pcm) => {
        this.receivedBytes += pcm.length;
        handlers.onPartial('...');
      },
      finish: async () => {
        for (const text of this.finals) handlers.onFinal(text);
      },
      close: () => {},
    };
  }
}

export async function startTestServer(pool: pg.Pool, providers: SttProvider[] = []) {
  const server: Server = buildServer({ repo: new TranscriptionRepository(pool), registry: new ProviderRegistry(providers) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    wsUrl: `ws://127.0.0.1:${port}/ws/transcribe`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
