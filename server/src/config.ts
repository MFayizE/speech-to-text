import 'dotenv/config';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://stt:stt@localhost:5433/stt',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-transcribe-live',
  whisperUrl: process.env.WHISPER_URL ?? '',
  /** Provider used when the client does not ask for one: "gemini" or "whisper". */
  defaultProvider: process.env.STT_PROVIDER ?? '',
  /** How long to wait for the provider to flush its last transcript after the user stops. */
  finalizeTimeoutMs: num(process.env.FINALIZE_TIMEOUT_MS, 4000),
  /** Folder with the built React app. Served as static files when present. */
  webDist: process.env.WEB_DIST ?? '',
};

export type AppConfig = typeof config;
