import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { TranscriptionRepository } from '../repository.js';

const idSchema = z.coerce.number().int().positive();

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Trims and drops NUL characters before length checks, so "\u0000" alone counts as empty. */
const text = () =>
  z
    .string()
    .transform((s) => s.replace(/\u0000/g, '').trim())
    .pipe(z.string().min(1, 'text is required').max(50_000));

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  text: text(),
  language: z.string().trim().max(32).nullish(),
  provider: z.string().trim().max(32).optional(),
  durationMs: z.number().int().min(0).nullish(),
});

const updateSchema = z
  .object({
    title: z.string().trim().max(200),
    text: text(),
    language: z.string().trim().max(32).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one of title, text, language is required');

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function transcriptionsRouter(repo: TranscriptionRepository): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const query = listSchema.parse(req.query);
      res.json({ ...(await repo.list(query)), limit: query.limit, offset: query.offset });
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const item = await repo.get(idSchema.parse(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Transcription not found' });
        return;
      }
      res.json(item);
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      res.status(201).json(await repo.create(createSchema.parse(req.body)));
    }),
  );

  // PUT and PATCH both accept a partial body; the dashboard edits title and text in place.
  const update = wrap(async (req, res) => {
    const item = await repo.update(idSchema.parse(req.params.id), updateSchema.parse(req.body));
    if (!item) {
      res.status(404).json({ error: 'Transcription not found' });
      return;
    }
    res.json(item);
  });
  router.put('/:id', update);
  router.patch('/:id', update);

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const removed = await repo.remove(idSchema.parse(req.params.id));
      if (!removed) {
        res.status(404).json({ error: 'Transcription not found' });
        return;
      }
      res.status(204).end();
    }),
  );

  return router;
}
