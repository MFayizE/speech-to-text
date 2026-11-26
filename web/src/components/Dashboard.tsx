import { useCallback, useEffect, useState } from 'react';
import { api, type Page, type Transcription } from '../api';
import { canSpeak, speak, stopSpeaking } from '../tts';

const PAGE_SIZE = 10;

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(ms: number | null) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Dashboard() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setPage(await api.list({ q: debounced || undefined, limit: PAGE_SIZE, offset }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [debounced, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => stopSpeaking(), []);

  async function remove(t: Transcription) {
    if (!confirm(`Delete "${t.title}"? This cannot be undone.`)) return;
    try {
      await api.remove(t.id);
      // Step back a page if this was the last row on it.
      if (page && page.items.length === 1 && offset > 0) setOffset(offset - PAGE_SIZE);
      else await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function togglePlay(t: Transcription) {
    if (speakingId === t.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(t.id);
    speak(t.text, () => setSpeakingId((cur) => (cur === t.id ? null : cur)));
  }

  const total = page?.total ?? 0;

  return (
    <section className="card">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title or text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search transcriptions"
        />
        <button onClick={() => setCreating(true)} disabled={creating}>
          + New
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      {creating && (
        <Editor
          initial={{ title: '', text: '' }}
          submitLabel="Create"
          onCancel={() => setCreating(false)}
          onSubmit={async (data) => {
            await api.create(data);
            setCreating(false);
            if (offset === 0) await load();
            else setOffset(0);
          }}
        />
      )}

      <div className="summary">
        {loading ? 'Loading...' : `${total} transcription${total === 1 ? '' : 's'}${debounced ? ` matching "${debounced}"` : ''}`}
      </div>

      {page && page.items.length === 0 && !loading && (
        <p className="empty">{debounced ? 'Nothing matches that search.' : 'No transcriptions yet. Record one on the Live tab.'}</p>
      )}

      <ul className="list">
        {page?.items.map((t) =>
          editingId === t.id ? (
            <li key={t.id}>
              <Editor
                initial={{ title: t.title, text: t.text }}
                submitLabel="Save"
                onCancel={() => setEditingId(null)}
                onSubmit={async (data) => {
                  await api.update(t.id, data);
                  setEditingId(null);
                  await load();
                }}
              />
            </li>
          ) : (
            <li key={t.id} className="item">
              <div className="item-head">
                <h3>{t.title}</h3>
                <div className="actions">
                  {canSpeak() && (
                    <button className="ghost" onClick={() => togglePlay(t)}>
                      {speakingId === t.id ? 'Stop' : 'Play'}
                    </button>
                  )}
                  <button className="ghost" onClick={() => setEditingId(t.id)}>
                    Edit
                  </button>
                  <button className="ghost danger" onClick={() => remove(t)}>
                    Delete
                  </button>
                </div>
              </div>
              <p className="item-text">{t.text}</p>
              <div className="meta">
                <span>#{t.id}</span>
                <span>{formatDate(t.createdAt)}</span>
                <span className="badge">{t.provider}</span>
                {t.language && <span className="badge">{t.language}</span>}
                {t.durationMs != null && <span>{formatDuration(t.durationMs)}</span>}
                {t.updatedAt !== t.createdAt && <span>edited</span>}
              </div>
            </li>
          ),
        )}
      </ul>

      {total > PAGE_SIZE && (
        <div className="pager">
          <button className="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            ← Prev
          </button>
          <span>
            {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button className="ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next →
          </button>
        </div>
      )}
    </section>
  );
}

interface EditorProps {
  initial: { title: string; text: string };
  submitLabel: string;
  onSubmit: (data: { title: string; text: string }) => Promise<void>;
  onCancel: () => void;
}

function Editor({ initial, submitLabel, onSubmit, onCancel }: EditorProps) {
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  return (
    <form
      className="editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError('');
        try {
          await onSubmit({ title: title.trim(), text: text.trim() });
        } catch (err) {
          setError((err as Error).message);
          setSaving(false);
        }
      }}
    >
      <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <textarea placeholder="Transcription text" value={text} onChange={(e) => setText(e.target.value)} rows={4} required />
      {error && <div className="alert">{error}</div>}
      <div className="editor-actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" disabled={saving || !text.trim()}>
          {saving ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
