import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Mic, Pause, Play, Square } from 'lucide-react';
import { liveSocketUrl, type AppConfig, type Transcription } from '../api';
import { startMic, type MicRecorder } from '../audio/recorder';
import { clock, engineName, wordCount } from '../format';
import { canSpeak, speak, stopSpeaking } from '../tts';
import { LevelMeter, type LevelMeterHandle } from './LevelMeter';

type Status = 'idle' | 'connecting' | 'recording' | 'finishing';

const LANGUAGES: { label: string; codes: string[] }[] = [
  { label: 'Auto, mixed Hindi and English', codes: [] },
  { label: 'Hindi and English', codes: ['hi-IN', 'en-IN'] },
  { label: 'Hindi', codes: ['hi-IN'] },
  { label: 'English (India)', codes: ['en-IN'] },
];

const ENGINE_DETAIL: Record<string, string> = {
  gemini: 'Gemini Live, streaming',
  whisper: 'Whisper, self-hosted',
};

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  recording: 'Listening',
  finishing: 'Saving',
};

interface Props {
  config: AppConfig | null;
  onSaved: (t: Transcription) => void;
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Microphone access is blocked. Allow it from the icon in the address bar, then try again.';
  if (name === 'NotFoundError') return 'No microphone found. Connect one, then try again.';
  return err instanceof Error ? err.message : 'Could not start the microphone.';
}

export function LiveTranscriber({ config, onSaved }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [provider, setProvider] = useState('');
  const [languageIndex, setLanguageIndex] = useState(0);
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<Transcription | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [copied, setCopied] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicRecorder | null>(null);
  const meterRef = useRef<LevelMeterHandle>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (config && !provider) setProvider(config.defaultProvider ?? '');
  }, [config, provider]);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(
    () => () => {
      void micRef.current?.stop();
      wsRef.current?.close();
      stopSpeaking();
    },
    [],
  );

  function cleanup() {
    void micRef.current?.stop();
    micRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    meterRef.current?.reset();
  }

  function finish() {
    cleanup();
    setStatus('idle');
    setPartial('');
  }

  async function start() {
    stopSpeaking();
    setSpeaking(false);
    setError('');
    setNotice('');
    setSaved(null);
    setFinals([]);
    setPartial('');
    setElapsed(0);
    setStatus('connecting');

    const ws = new WebSocket(liveSocketUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    // Audio captured before the engine is ready is queued, so the first words are not lost.
    const queue: ArrayBuffer[] = [];
    let ready = false;
    let opened = false;
    let ended = false; // server sent saved/empty, or we gave up
    const current = () => wsRef.current === ws;
    const showError = (message: string) => setError((prev) => prev || message);

    ws.onopen = () => {
      opened = true;
    };

    ws.onmessage = (event) => {
      if (!current()) return;
      let msg: { type: string; [key: string]: any };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          ready = true;
          for (const chunk of queue.splice(0)) ws.send(chunk);
          startedAt.current = Date.now();
          setStatus('recording');
          break;
        case 'partial':
          setPartial(msg.text);
          break;
        case 'final':
          setFinals((prev) => [...prev, msg.text]);
          setPartial('');
          break;
        case 'saved':
          ended = true;
          setSaved(msg.transcription);
          onSaved(msg.transcription);
          finish();
          break;
        case 'empty':
          ended = true;
          showError('No speech was detected. Check that the right microphone is selected, then try again.');
          finish();
          break;
        case 'notice':
          setNotice(msg.message);
          break;
        case 'error':
          showError(msg.message);
          if (!ready) finish();
          // The engine is gone; the server is saving what it has. Stop the mic and wait for "saved".
          else if (msg.fatal) void releaseMic('finishing');
          break;
      }
    };
    ws.onclose = () => {
      if (!current()) return;
      if (!opened) showError('Cannot reach the server. Check that it is running and your network is up, then try again.');
      else if (!ended && ready) showError('The connection to the server dropped. Text already finalized was saved to History if the server is still up.');
      finish();
    };

    let mic: MicRecorder;
    try {
      mic = await startMic(
        (pcm) => {
          if (ready && ws.readyState === WebSocket.OPEN) ws.send(pcm);
          else if (ws.readyState <= WebSocket.OPEN) queue.push(pcm);
        },
        (rms) => meterRef.current?.push(Math.min(1, rms * 6)),
        () => {
          showError('The microphone stopped (unplugged or taken by another app). What was captured is being saved.');
          void stop();
        },
      );
    } catch (err) {
      if (current()) {
        setError(micErrorMessage(err));
        finish();
      }
      return;
    }
    // The connection may have failed while the permission prompt was open: do not leave the mic on.
    if (!current()) {
      void mic.stop();
      return;
    }
    micRef.current = mic;

    const codes = LANGUAGES[languageIndex].codes;
    const sendStart = () => ws.send(JSON.stringify({ type: 'start', provider: provider || undefined, languageCodes: codes }));
    if (ws.readyState === WebSocket.OPEN) sendStart();
    else ws.addEventListener('open', sendStart, { once: true });
  }

  async function releaseMic(next: Status) {
    setStatus(next);
    const mic = micRef.current;
    micRef.current = null;
    meterRef.current?.reset();
    await mic?.stop();
  }

  async function stop() {
    const ws = wsRef.current;
    await releaseMic('finishing');
    if (ws?.readyState !== WebSocket.OPEN) {
      finish();
      return;
    }
    ws.send(JSON.stringify({ type: 'stop' }));
    // Never leave the UI stuck on "Saving" if the server goes quiet.
    setTimeout(() => {
      if (wsRef.current === ws) {
        setError((prev) => prev || 'The server did not confirm the save. Check History, then try again if it is missing.');
        finish();
      }
    }, 20_000);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy. Select the text and copy it manually.');
    }
  }

  const transcript = finals.join(' ');
  const busy = status !== 'idle';
  const noEngines = config !== null && config.providers.length === 0;
  const canStart = !!config && !noEngines;
  const words = wordCount(`${transcript} ${partial}`);
  const engine = provider || config?.defaultProvider || '';

  return (
    <div className="page">
      <header className="page-head">
        <h1>Record</h1>
        <p className="lede">Speak in Hindi, English or both. Words appear as you talk and are saved when you stop.</p>
      </header>

      <div className="record-layout">
        <section className="sheet" aria-labelledby="transcript-label">
          <div className="sheet-head">
            <span id="transcript-label" className={`state state-${status}`}>
              <span className="state-dot" aria-hidden />
              {STATUS_LABEL[status]}
            </span>
            <span className="timecode" aria-label="Elapsed time">
              {clock(elapsed)}
            </span>
          </div>

          <div className="sheet-body" aria-live="polite" aria-atomic="false">
            {transcript || partial ? (
              <p className="transcript">
                {finals.map((text, i) => (
                  <span key={i} className="seg">
                    {text}{' '}
                  </span>
                ))}
                {partial && <span className="seg-partial">{partial}</span>}
              </p>
            ) : (
              <p className="transcript-empty">
                {noEngines
                  ? 'No speech engine is configured on the server. Set GEMINI_API_KEY or WHISPER_URL and restart it.'
                  : 'Try saying: “Kal ki meeting 10 baje hai, please join on time.”'}
              </p>
            )}
          </div>

          {error && (
            <div className="notice is-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}

          <div className="sheet-foot">
            <button
              type="button"
              className={`record-btn${status === 'recording' ? ' is-recording' : ''}`}
              onClick={status === 'recording' ? stop : start}
              disabled={!canStart || status === 'connecting' || status === 'finishing'}
            >
              {status === 'recording' ? (
                <Square size={16} strokeWidth={1.5} fill="currentColor" aria-hidden />
              ) : (
                <Mic size={18} strokeWidth={1.5} aria-hidden />
              )}
              <span>
                {status === 'recording' ? 'Stop and save' : status === 'finishing' ? 'Saving' : status === 'connecting' ? 'Connecting' : 'Start recording'}
              </span>
            </button>
            <LevelMeter ref={meterRef} active={status === 'recording'} />
          </div>
        </section>

        <aside className="side">
          <section className="panel" aria-labelledby="settings-label">
            <h2 id="settings-label" className="panel-title">
              Settings
            </h2>
            <label className="field">
              <span className="field-label">Engine</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy || !config?.providers.length}>
                {!config?.providers.length && <option value="">{config ? 'None configured' : 'Loading'}</option>}
                {config?.providers.map((p) => (
                  <option key={p} value={p}>
                    {ENGINE_DETAIL[p] ?? p}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Language</span>
              <select value={languageIndex} onChange={(e) => setLanguageIndex(Number(e.target.value))} disabled={busy}>
                {LANGUAGES.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="panel" aria-labelledby="session-label">
            <h2 id="session-label" className="panel-title">
              This session
            </h2>
            <dl className="facts">
              <div>
                <dt>Duration</dt>
                <dd>{clock(saved?.durationMs ?? elapsed)}</dd>
              </div>
              <div>
                <dt>Words</dt>
                <dd>{saved ? wordCount(saved.text) : words}</dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>{engine ? engineName(engine) : '-'}</dd>
              </div>
            </dl>

            {saved && (
              <div className="saved">
                <p className="saved-line">
                  <Check size={16} strokeWidth={1.5} aria-hidden /> Saved to history as #{saved.id}
                </p>
                <div className="btn-row">
                  {canSpeak() && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (speaking) {
                          stopSpeaking();
                          setSpeaking(false);
                        } else {
                          setSpeaking(true);
                          speak(saved.text, () => setSpeaking(false));
                        }
                      }}
                    >
                      {speaking ? <Pause size={16} strokeWidth={1.5} aria-hidden /> : <Play size={16} strokeWidth={1.5} aria-hidden />}
                      {speaking ? 'Stop playback' : 'Play back'}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => copy(saved.text)}>
                    {copied ? <Check size={16} strokeWidth={1.5} aria-hidden /> : <Copy size={16} strokeWidth={1.5} aria-hidden />}
                    {copied ? 'Copied' : 'Copy text'}
                  </button>
                  <a className="btn btn-quiet" href="#/history">
                    Open history
                  </a>
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
