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

export interface Page {
  items: Transcription[];
  total: number;
  limit: number;
  offset: number;
}

export interface AppConfig {
  providers: string[];
  defaultProvider: string | null;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join(', ');
    throw new Error(detail || body.error || `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  config: () => http<AppConfig>('/api/config'),
  list: (params: { q?: string; limit: number; offset: number }) => {
    const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.q) qs.set('q', params.q);
    return http<Page>(`/api/transcriptions?${qs}`);
  },
  create: (data: { title?: string; text: string }) =>
    http<Transcription>('/api/transcriptions', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { title?: string; text?: string }) =>
    http<Transcription>(`/api/transcriptions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => http<void>(`/api/transcriptions/${id}`, { method: 'DELETE' }),
};

export function liveSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/transcribe`;
}
