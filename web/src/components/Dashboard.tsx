import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Mic, Pause, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { api, ApiError, type Page, type Transcription } from '../api';

const isGone = (err: unknown) => err instanceof ApiError && err.status === 404;
import { clock, count, engineName, fullDate, languageName, when } from '../format';
import { canSpeak, speak, stopSpeaking } from '../tts';

const PAGE_SIZE = 10;
const ICON = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

export function Dashboard() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim());
      setOffset(0);
    }, 250);
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

  // Rows deleted elsewhere can leave us past the last page; step back.
  useEffect(() => {
    if (page && page.items.length === 0 && page.total > 0 && offset > 0) {
      setOffset(Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE));
    }
  }, [page, offset]);

  async function remove(t: Transcription) {
    try {
      // Already deleted (another tab) counts as done.
      await api.remove(t.id).catch((err) => {
        if (!isGone(err)) throw err;
      });
      setConfirmId(null);
      if (speakingId === t.id) {
        stopSpeaking();
        setSpeakingId(null);
      }
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
  const items = page?.items ?? [];
  const firstLoad = loading && !page;

  return (
    <div className="page">
      <header className="page-head page-head-row">
        <div>
          <h1>History</h1>
          <p className="lede">
            {firstLoad ? 'Loading recordings' : debounced ? `${count(total, 'result')} for “${debounced}”` : count(total, 'recording')}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={creating}>
          <Plus {...ICON} />
          New entry
        </button>
      </header>

      <div className="toolbar">
        <div className="search">
          <Search {...ICON} className="search-icon" />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search titles and text"
          />
          {loading && page && <LoaderCircle {...ICON} className="spin search-busy" />}
        </div>
      </div>

      {error && (
        <div className="notice is-error" role="alert">
          <span>Could not load history ({error}).</span>
          <button type="button" className="btn btn-quiet" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {creating && (
        <div className="panel create-panel">
          <h2 className="panel-title">New entry</h2>
          <Editor
            initial={{ title: '', text: '' }}
            submitLabel="Save entry"
            onCancel={() => setCreating(false)}
            onSubmit={async (data) => {
              await api.create(data);
              setCreating(false);
              if (offset === 0) await load();
              else setOffset(0);
            }}
          />
        </div>
      )}

      {firstLoad ? (
        <div className="empty">
          <LoaderCircle {...ICON} className="spin" />
          <p>Loading</p>
        </div>
      ) : items.length === 0 && !error ? (
        debounced ? (
          <div className="empty">
            <p className="empty-title">No results for “{debounced}”</p>
            <p>Try a different word, or search in the other script (Devanagari or Roman).</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <X {...ICON} />
              Clear search
            </button>
          </div>
        ) : (
          <div className="empty">
            <p className="empty-title">No recordings yet</p>
            <p>Recordings you save appear here, newest first.</p>
            <a className="btn btn-primary" href="#/">
              <Mic {...ICON} />
              Start recording
            </a>
          </div>
        )
      ) : (
        <ul className="rows" aria-busy={loading}>
          {items.map((t) =>
            editingId === t.id ? (
              <li key={t.id} className="row is-editing">
                <Editor
                  initial={{ title: t.title, text: t.text }}
                  submitLabel="Save changes"
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (data) => {
                    try {
                      await api.update(t.id, data);
                    } catch (err) {
                      if (!isGone(err)) throw err;
                      setError('That entry no longer exists. It may have been deleted in another tab');
                    }
                    setEditingId(null);
                    await load();
                  }}
                />
              </li>
            ) : (
              <li key={t.id} className="row">
                <div className="row-main">
                  <h3 className="row-title">{t.title}</h3>
                  <p className="row-text">{t.text}</p>
                </div>
                <dl className="row-meta">
                  <div>
                    <dt>Engine</dt>
                    <dd>{engineName(t.provider)}</dd>
                  </div>
                  <div>
                    <dt>Language</dt>
                    <dd>{languageName(t.language)}</dd>
                  </div>
                  {t.durationMs != null && (
                    <div>
                      <dt>Length</dt>
                      <dd className="num">{clock(t.durationMs)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Saved</dt>
                    <dd>
                      <time dateTime={t.createdAt} title={fullDate(t.createdAt)}>
                        {when(t.createdAt)}
                      </time>
                      {t.updatedAt !== t.createdAt && <span className="edited">, edited</span>}
                    </dd>
                  </div>
                </dl>
                <div className="row-actions">
                  {confirmId === t.id ? (
                    <div className="confirm" role="group" aria-label={`Delete ${t.title}?`}>
                      <span>Delete this entry?</span>
                      <button type="button" className="btn btn-quiet" onClick={() => setConfirmId(null)}>
                        Keep
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => void remove(t)} autoFocus>
                        Delete
                      </button>
                    </div>
                  ) : (
                    <>
                      {canSpeak() && (
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => togglePlay(t)}
                          aria-label={speakingId === t.id ? `Stop playing ${t.title}` : `Play ${t.title}`}
                          title={speakingId === t.id ? 'Stop' : 'Play'}
                        >
                          {speakingId === t.id ? <Pause {...ICON} /> : <Play {...ICON} />}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => {
                          setConfirmId(null);
                          setEditingId(t.id);
                        }}
                        aria-label={`Edit ${t.title}`}
                        title="Edit"
                      >
                        <Pencil {...ICON} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn is-danger"
                        onClick={() => setConfirmId(t.id)}
                        aria-label={`Delete ${t.title}`}
                        title="Delete"
                      >
                        <Trash2 {...ICON} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <nav className="pager" aria-label="Pages">
          <span className="num">
            {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <div className="btn-row">
            <button
              type="button"
              className="icon-btn"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              aria-label="Previous page"
            >
              <ChevronLeft {...ICON} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              aria-label="Next page"
            >
              <ChevronRight {...ICON} />
            </button>
          </div>
        </nav>
      )}
    </div>
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
          setError(`Not saved: ${(err as Error).message}. Your edits are still here, so try again.`);
          setSaving(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <label className="field">
        <span className="field-label">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Generated from the text if empty" />
      </label>
      <label className="field">
        <span className="field-label">Text</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} required autoFocus />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="btn-row btn-row-end">
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !text.trim()}>
          {saving && <LoaderCircle {...ICON} className="spin" />}
          {saving ? 'Saving' : submitLabel}
        </button>
      </div>
    </form>
  );
}
