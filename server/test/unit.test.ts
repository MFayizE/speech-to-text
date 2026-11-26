import { describe, expect, it } from 'vitest';
import { defaultTitle } from '../src/repository.js';
import { ProviderRegistry, providersFromConfig } from '../src/stt/registry.js';
import { config } from '../src/config.js';
import { MockProvider } from './helpers.js';

describe('defaultTitle', () => {
  it('uses the first eight words', () => {
    expect(defaultTitle('one two three four five six seven eight nine')).toBe('one two three four five six seven eight');
  });
  it('truncates long words to 60 characters', () => {
    const title = defaultTitle('a'.repeat(100));
    expect(title).toHaveLength(60);
    expect(title.endsWith('...')).toBe(true);
  });
  it('falls back to Untitled', () => {
    expect(defaultTitle('   ')).toBe('Untitled');
  });
});

describe('ProviderRegistry', () => {
  it('returns the preferred provider when configured, else the first', () => {
    const a = new MockProvider();
    const b = Object.assign(new MockProvider(), { name: 'other' });
    expect(new ProviderRegistry([a, b], 'other').defaultName()).toBe('other');
    expect(new ProviderRegistry([a, b], 'missing').defaultName()).toBe('mock');
    expect(new ProviderRegistry([]).get()).toBeNull();
  });

  it('only registers providers that have configuration', () => {
    const none = providersFromConfig({ ...config, geminiApiKey: '', whisperUrl: '' });
    expect(none.names()).toEqual([]);
    const both = providersFromConfig({ ...config, geminiApiKey: 'test-key', whisperUrl: 'ws://localhost:8001/ws' });
    expect(both.names()).toEqual(['gemini', 'whisper']);
  });
});
