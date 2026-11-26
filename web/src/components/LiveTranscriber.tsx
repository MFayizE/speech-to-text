import { useEffect, useRef, useState } from 'react';
import { liveSocketUrl, type AppConfig, type Transcription } from '../api';
import { startMic, type MicRecorder } from '../audio/recorder';
import { canSpeak, speak, stopSpeaking } from '../tts';

type Status = 'idle' | 'connecting' | 'recording' | 'finishing';

const LANGUAGE_OPTIONS: { label: string; codes: string[] }[] = [
  { label: 'Auto detect (mixed Hindi + English)', codes: [] },
  { label: 'Hindi + English hint', codes: ['hi-IN', 'en-IN'] },
  { label: 'Hindi', codes: ['hi-IN'] },
  { label: 'English (India)', codes: ['en-IN'] },
];

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini Live (cloud, streaming)',
  whisper: 'faster-whisper (self-hosted, open source)',
};

interface Props {
  config: AppConfig | null;
  onSaved: (t: Transcription) => void;
  onOpenHistory: () => void;
}

export function LiveTranscriber({ config, onSaved, onOpenHistory }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [provider, setProvider] = useState('');
  const [languageIndex, setLanguageIndex] = useState(0);
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Transcription | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [speaking, setSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicRecorder | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (config && !provider) setProvider(config.defaultProvider ?? '');
  }, [config, provider]);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    void micRef.current?.stop();
    micRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setLevel(0);
  }

  async function start() {
    setError('');
    setSaved(null);
    setFinals([]);
    setPartial('');
    setElapsed(0);
    setStatus('connecting');

    const ws = new WebSocket(liveSocketUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    // Audio captured before the provider is ready is queued, so the first words are not lost.
    const queue: ArrayBuffer[] = [];
    let ready = false;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
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
          setSaved(msg.transcription);
          onSaved(msg.transcription);
          finish();
          break;
        case 'empty':
          setError('No speech was recognized. Check your mic and try again.');
          finish();
          break;
        case 'error':
          setError(msg.message);
          // Errors during start or recording end the session; errors while finishing are shown but we still wait for "saved".
          if (!ready) finish();
          break;
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) finish();
    };
    ws.onerror = () => setError('Lost connection to the server.');

    try {
      micRef.current = await startMic(
        (pcm) => {
          if (ready && ws.readyState === WebSocket.OPEN) ws.send(pcm);
          else queue.push(pcm);
        },
        (rms) => setLevel(Math.min(1, rms * 6)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone permission denied.');
      finish();
      return;
    }

    const codes = LANGUAGE_OPTIONS[languageIndex].codes;
    const sendStart = () => ws.send(JSON.stringify({ type: 'start', provider: provider || undefined, languageCodes: codes }));
    if (ws.readyState === WebSocket.OPEN) sendStart();
    else ws.addEventListener('open', sendStart, { once: true });
  }

  async function stop() {
    setStatus('finishing');
    await micRef.current?.stop();
    micRef.current = null;
    setLevel(0);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    else finish();
  }

  function finish() {
    cleanup();
    setStatus('idle');
    setPartial('');
  }

  const transcript = finals.join(' ');
  const busy = status !== 'idle';
  const noProviders = config !== null && config.providers.length === 0;
  const seconds = Math.floor(elapsed / 1000);

  return (
    <section className="card live">
      <div className="controls">
        <label>
          <span>Engine</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy || !config?.providers.length}>
            {config?.providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Language</span>
          <select value={languageIndex} onChange={(e) => setLanguageIndex(Number(e.target.value))} disabled={busy}>
            {LANGUAGE_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="recorder">
        <button
          className={`mic ${status}`}
          onClick={status === 'recording' ? stop : start}
          disabled={status === 'connecting' || status === 'finishing' || noProviders || !config}
          aria-label={status === 'recording' ? 'Stop recording' : 'Start recording'}
          style={{ ['--level' as string]: level }}
        >
          <span className="mic-icon" aria-hidden>
            {status === 'recording' ? '■' : '●'}
          </span>
        </button>
        <div className="recorder-status" aria-live="polite">
          {status === 'idle' && (noProviders ? 'No speech engine configured on the server' : 'Tap to start speaking')}
          {status === 'connecting' && 'Connecting...'}
          {status === 'recording' && (
            <>
              <span className="dot" /> Listening {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </>
          )}
          {status === 'finishing' && 'Finishing and saving...'}
        </div>
      </div>

      <div className="transcript" aria-live="polite">
        {transcript || partial ? (
          <p>
            {transcript} <span className="partial">{partial}</span>
          </p>
        ) : (
          <p className="placeholder">Your words appear here as you speak. Try: "Kal ki meeting 10 baje hai, please join on time."</p>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      {saved && (
        <div className="saved">
          <span>Saved as #{saved.id}</span>
          {canSpeak() && (
            <button
              className="ghost"
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
              {speaking ? 'Stop' : 'Play back'}
            </button>
          )}
          <button className="ghost" onClick={onOpenHistory}>
            View history
          </button>
        </div>
      )}
    </section>
  );
}
