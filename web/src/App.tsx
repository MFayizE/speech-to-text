import { useEffect, useState } from 'react';
import { History, Mic } from 'lucide-react';
import { api, type AppConfig } from './api';
import { Dashboard } from './components/Dashboard';
import { LiveTranscriber } from './components/LiveTranscriber';
import { engineName } from './format';

type Route = 'record' | 'history';

function readRoute(): Route {
  return location.hash === '#/history' ? 'history' : 'record';
}

/** Tiny hash router: keeps the page on refresh and works on any static host. */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

const NAV: { route: Route; href: string; label: string; Icon: typeof Mic }[] = [
  { route: 'record', href: '#/', label: 'Record', Icon: Mic },
  { route: 'history', href: '#/history', label: 'History', Icon: History },
];

export function App() {
  const route = useRoute();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  // Bumped after each saved recording so History refetches when opened.
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    api.config().then(setConfig, (err: Error) => setConfigError(err.message));
  }, []);

  useEffect(() => {
    document.title = route === 'history' ? 'History · Transcribe' : 'Record · Transcribe';
  }, [route]);

  const nav = (
    <ul className="nav-list">
      {NAV.map(({ route: r, href, label, Icon }) => (
        <li key={r}>
          <a href={href} className="nav-item" aria-current={route === r ? 'page' : undefined}>
            <Icon size={18} strokeWidth={1.5} aria-hidden />
            <span>{label}</span>
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar">
        <div className="wordmark">
          <span className="wordmark-dot" aria-hidden />
          Transcribe
        </div>
        <nav aria-label="Main">{nav}</nav>
        <div className="sidebar-foot">
          <span className="label">Engines</span>
          {config?.providers.length ? (
            <ul className="engine-list">
              {config.providers.map((p) => (
                <li key={p}>
                  <span className="status-dot is-on" aria-hidden />
                  {engineName(p)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">{config ? 'None configured' : 'Checking'}</span>
          )}
        </div>
      </aside>

      <header className="topbar">
        <div className="wordmark">
          <span className="wordmark-dot" aria-hidden />
          Transcribe
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        {configError && (
          <div className="notice is-error" role="alert">
            Cannot reach the server ({configError}). Check that the API is running, then reload the page.
          </div>
        )}
        {/* Record stays mounted so a recording in progress survives switching pages. */}
        <div hidden={route !== 'record'}>
          <LiveTranscriber config={config} onSaved={() => setSavedCount((n) => n + 1)} />
        </div>
        {route === 'history' && <Dashboard key={savedCount} />}
      </main>

      <nav className="tabbar" aria-label="Main">
        {nav}
      </nav>
    </div>
  );
}
