import type { AppConfig } from '../config.js';
import { GeminiLiveProvider } from './gemini.js';
import type { SttProvider } from './types.js';
import { WhisperProvider } from './whisper.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, SttProvider>();

  constructor(
    providers: SttProvider[],
    private readonly preferred = '',
  ) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  defaultName(): string | null {
    if (this.preferred && this.providers.has(this.preferred)) return this.preferred;
    return this.names()[0] ?? null;
  }

  get(name?: string | null): SttProvider | null {
    const key = name || this.defaultName();
    return key ? (this.providers.get(key) ?? null) : null;
  }
}

/** Registers each provider only when it is configured. */
export function providersFromConfig(config: AppConfig): ProviderRegistry {
  const list: SttProvider[] = [];
  if (config.geminiApiKey) {
    list.push(new GeminiLiveProvider(config.geminiApiKey, config.geminiModel, config.finalizeTimeoutMs));
  }
  if (config.whisperUrl) list.push(new WhisperProvider(config.whisperUrl));
  return new ProviderRegistry(list, config.defaultProvider);
}
