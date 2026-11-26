import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import type { Server } from 'node:http';
import { resetDb, setupDb, startTestServer } from './helpers.js';

let pool: pg.Pool;
let server: Server;
let close: () => Promise<void>;

beforeAll(async () => {
  pool = await setupDb();
  ({ server, close } = await startTestServer(pool));
});

afterAll(async () => {
  await close();
  await pool.end();
});

beforeEach(() => resetDb(pool));

const create = (body: object) => request(server).post('/api/transcriptions').send(body);

describe('REST /api/transcriptions', () => {
  it('creates a transcription and derives a title from the text', async () => {
    const res = await create({ text: 'Kal meeting hai at 10 am, please join on time', language: 'hi-IN,en-IN' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 1,
      title: 'Kal meeting hai at 10 am, please join',
      text: 'Kal meeting hai at 10 am, please join on time',
      language: 'hi-IN,en-IN',
      provider: 'manual',
    });
    expect(Date.parse(res.body.createdAt)).not.toBeNaN();
  });

  it('stores Devanagari text unchanged', async () => {
    const text = 'मुझे kal ki report चाहिए';
    const res = await create({ text });
    const fetched = await request(server).get(`/api/transcriptions/${res.body.id}`);
    expect(fetched.body.text).toBe(text);
  });

  it('rejects empty text', async () => {
    const res = await create({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.issues[0].path).toBe('text');
  });

  it('rejects malformed JSON', async () => {
    const res = await request(server).post('/api/transcriptions').set('Content-Type', 'application/json').send('{"text":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malformed JSON body');
  });

  it('lists newest first with pagination and total', async () => {
    for (const text of ['first', 'second', 'third']) await create({ text });
    const res = await request(server).get('/api/transcriptions?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((t: { text: string }) => t.text)).toEqual(['third', 'second']);

    const page2 = await request(server).get('/api/transcriptions?limit=2&offset=2');
    expect(page2.body.items.map((t: { text: string }) => t.text)).toEqual(['first']);
  });

  it('searches title and text case-insensitively', async () => {
    await create({ text: 'Invoice approval pending' });
    await create({ text: 'Lunch kab hai?' });
    const res = await request(server).get('/api/transcriptions').query({ q: 'INVOICE' });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].text).toBe('Invoice approval pending');
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(server).get('/api/transcriptions?limit=500');
    expect(res.status).toBe(400);
  });

  it('gets one transcription, 404 when missing, 400 on a bad id', async () => {
    const { body } = await create({ text: 'hello' });
    expect((await request(server).get(`/api/transcriptions/${body.id}`)).body.text).toBe('hello');
    expect((await request(server).get('/api/transcriptions/999')).status).toBe(404);
    expect((await request(server).get('/api/transcriptions/abc')).status).toBe(400);
  });

  it('updates title and text with PUT and bumps updatedAt', async () => {
    const { body: created } = await create({ text: 'helo wrld' });
    await new Promise((r) => setTimeout(r, 10));
    const res = await request(server).put(`/api/transcriptions/${created.id}`).send({ title: 'Fixed', text: 'hello world' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Fixed', text: 'hello world' });
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
  });

  it('PATCH changes only the given field', async () => {
    const { body: created } = await create({ title: 'Keep me', text: 'original' });
    const res = await request(server).patch(`/api/transcriptions/${created.id}`).send({ text: 'changed' });
    expect(res.body).toMatchObject({ title: 'Keep me', text: 'changed' });
  });

  it('rejects an empty update and 404s a missing id', async () => {
    const { body } = await create({ text: 'x' });
    expect((await request(server).patch(`/api/transcriptions/${body.id}`).send({})).status).toBe(400);
    expect((await request(server).put('/api/transcriptions/999').send({ text: 'y' })).status).toBe(404);
  });

  it('deletes a transcription', async () => {
    const { body } = await create({ text: 'to delete' });
    expect((await request(server).delete(`/api/transcriptions/${body.id}`)).status).toBe(204);
    expect((await request(server).get(`/api/transcriptions/${body.id}`)).status).toBe(404);
    expect((await request(server).delete(`/api/transcriptions/${body.id}`)).status).toBe(404);
  });

  it('returns JSON 404 for unknown API routes and lists providers', async () => {
    expect((await request(server).get('/api/nope')).status).toBe(404);
    const cfg = await request(server).get('/api/config');
    expect(cfg.body).toEqual({ providers: [], defaultProvider: null });
  });
});
