import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './app.js';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { TranscriptionRepository } from './repository.js';
import { providersFromConfig } from './stt/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const pool = createPool();
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  const registry = providersFromConfig(config);
  if (!registry.names().length) {
    console.warn('No STT provider configured. Set GEMINI_API_KEY and/or WHISPER_URL. CRUD still works.');
  }

  const server = buildServer({
    repo: new TranscriptionRepository(pool),
    registry,
    webDist: config.webDist || path.resolve(here, '../../web/dist'),
  });

  server.listen(config.port, () => {
    console.log(`Listening on http://localhost:${config.port} (providers: ${registry.names().join(', ') || 'none'})`);
  });

  const shutdown = () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
