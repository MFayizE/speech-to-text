import type pg from 'pg';

export interface Transcription {
  id: number;
  title: string;
  text: string;
  language: string | null;
  provider: string;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTranscription {
  title?: string;
  text: string;
  language?: string | null;
  provider?: string;
  durationMs?: number | null;
}

export type TranscriptionPatch = Partial<Pick<Transcription, 'title' | 'text' | 'language'>>;

export interface ListQuery {
  q?: string;
  limit: number;
  offset: number;
}

interface Row {
  id: string;
  title: string;
  text: string;
  language: string | null;
  provider: string;
  duration_ms: number | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, title, text, language, provider, duration_ms, created_at, updated_at';

function toModel(row: Row): Transcription {
  return {
    id: Number(row.id),
    title: row.title,
    text: row.text,
    language: row.language,
    provider: row.provider,
    durationMs: row.duration_ms,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Postgres TEXT cannot store NUL; strip it (and surrounding whitespace) before writing. */
export function clean(value: string): string {
  return value.replace(/\u0000/g, '').trim();
}

/** Escapes LIKE wildcards so a search for "%" or "_" matches those characters literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** Builds a short default title from the first words of the transcript. */
export function defaultTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 8).join(' ');
  if (!words) return 'Untitled';
  return words.length > 60 ? `${words.slice(0, 57)}...` : words;
}

export class TranscriptionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list({ q, limit, offset }: ListQuery): Promise<{ items: Transcription[]; total: number }> {
    const params: unknown[] = [];
    let where = '';
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      where = "WHERE title ILIKE $1 ESCAPE '\\' OR text ILIKE $1 ESCAPE '\\'";
    }
    const total = await this.pool.query<{ count: string }>(`SELECT count(*) FROM transcriptions ${where}`, params);
    const rows = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM transcriptions ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { items: rows.rows.map(toModel), total: Number(total.rows[0].count) };
  }

  async get(id: number): Promise<Transcription | null> {
    const res = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM transcriptions WHERE id = $1`, [id]);
    return res.rows[0] ? toModel(res.rows[0]) : null;
  }

  async create(input: NewTranscription): Promise<Transcription> {
    const text = clean(input.text);
    const res = await this.pool.query<Row>(
      `INSERT INTO transcriptions (title, text, language, provider, duration_ms)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [
        clean(input.title ?? '') || defaultTitle(text),
        text,
        input.language ?? null,
        input.provider ?? 'manual',
        input.durationMs ?? null,
      ],
    );
    return toModel(res.rows[0]);
  }

  async update(id: number, input: TranscriptionPatch): Promise<Transcription | null> {
    const patch: TranscriptionPatch = { ...input };
    if (patch.text !== undefined) patch.text = clean(patch.text);
    if (patch.title !== undefined) {
      patch.title = clean(patch.title);
      // Clearing the title regenerates it from the text instead of leaving a blank heading.
      if (!patch.title) {
        const text = patch.text ?? (await this.get(id))?.text;
        if (text === undefined) return null;
        patch.title = defaultTitle(text);
      }
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const column of ['title', 'text', 'language'] as const) {
      if (patch[column] !== undefined) {
        params.push(patch[column]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) return this.get(id);
    params.push(id);
    const res = await this.pool.query<Row>(
      `UPDATE transcriptions SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length} RETURNING ${COLUMNS}`,
      params,
    );
    return res.rows[0] ? toModel(res.rows[0]) : null;
  }

  async remove(id: number): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM transcriptions WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
