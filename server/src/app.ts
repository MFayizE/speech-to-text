import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import { handleLiveConnection, type LiveOptions } from './live.js';
import type { TranscriptionRepository } from './repository.js';
import { transcriptionsRouter } from './routes/transcriptions.js';
import type { ProviderRegistry } from './stt/registry.js';

export interface AppDeps {
  repo: TranscriptionRepository;
  registry: ProviderRegistry;
  webDist?: string;
  live?: Partial<LiveOptions>;
}

export function buildServer({ repo, registry, webDist, live }: AppDeps): Server {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ providers: registry.names(), defaultProvider: registry.defaultName() });
  });

  app.use('/api/transcriptions', transcriptionsRouter(repo));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve the built React app from the same origin, so one free web service hosts everything.
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON body' });
      return;
    }
    // body-parser errors carry a 4xx status (413 too large, 415 bad charset, ...).
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? 'Request body too large (limit 256 KB)' : 'Bad request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/transcribe', maxPayload: 1024 * 1024 });
  wss.on('connection', (ws, req) => handleLiveConnection(ws, req, { repo, registry, options: live }));
  server.on('close', () => wss.close());
  return server;
}
