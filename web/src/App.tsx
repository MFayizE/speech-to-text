import { useEffect, useState } from 'react';
import { api, type AppConfig } from './api';
import { Dashboard } from './components/Dashboard';
import { LiveTranscriber } from './components/LiveTranscriber';

type Tab = 'live' | 'history';

export function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  // Bumped after each saved recording so the dashboard reloads when opened.
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    api.config().then(setConfig, (err: Error) => setConfigError(err.message));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ◉
          </span>
          <div>
            <h1>Speech to Text</h1>
            <p>Real-time Hindi + English transcription</p>
          </div>
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'active' : ''} onClick={() => setTab('live')}>
            Live
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'active' : ''}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </nav>
      </header>

      <main>
        {configError && <div className="alert">Cannot reach the server: {configError}</div>}
        {/* Live stays mounted so an in-progress recording survives a tab switch. */}
        <div hidden={tab !== 'live'}>
          <LiveTranscriber config={config} onSaved={() => setSavedCount((n) => n + 1)} onOpenHistory={() => setTab('history')} />
        </div>
        {tab === 'history' && <Dashboard key={savedCount} />}
      </main>

      <footer className="foot">
        Speech to text via Gemini Live or self-hosted faster-whisper. Playback uses the browser's built-in speech synthesis.
      </footer>
    </div>
  );
}
