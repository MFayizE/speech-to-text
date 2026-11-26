const plural = new Intl.PluralRules('en-US');

/** "1 recording", "2 recordings" */
export function count(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${plural.select(n) === 'one' ? singular : pluralForm}`;
}

const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const full = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Relative for the last week, absolute after that. */
export function when(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'Just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return absolute.format(new Date(iso));
}

export function fullDate(iso: string): string {
  return full.format(new Date(iso));
}

/** 83_000 -> "1:23" */
export function clock(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

const ENGINE_NAMES: Record<string, string> = {
  gemini: 'Gemini Live',
  whisper: 'Whisper',
  manual: 'Typed',
};

export function engineName(id: string): string {
  return ENGINE_NAMES[id] ?? id;
}

export function languageName(code: string | null): string {
  if (!code || code === 'auto') return 'Auto';
  const names: Record<string, string> = { 'hi-IN': 'Hindi', 'en-IN': 'English' };
  return code
    .split(',')
    .map((c) => names[c] ?? c)
    .join(' + ');
}
