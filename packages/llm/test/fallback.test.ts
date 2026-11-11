import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider, type FakeStep } from '../src/adapters/fake.js';
import { FallbackAdapter } from '../src/adapters/fallback.js';
import { LlmClient } from '../src/client.js';
import { KNOWN_BASE_URLS, LlmConfigError, loadFallbackLlmConfig } from '../src/config.js';
import { ProviderError } from '../src/errors.js';
import type { LogFields, Logger } from '../src/logger.js';
import type { ProviderRequest } from '../src/provider.js';

const KEY = 'sk-test-PLACEHOLDER-not-a-real-key';
const OK = { answer: 42 };

/** A clock that only moves when a fake provider "waits", so timeouts are exact and instant. */
function manualTime() {
  const time = { now: 1_000_000 };
  const clock = { now: () => time.now };
  const sleep = (ms: number) => {
    time.now += ms;
    return Promise.resolve();
  };
  return { time, clock, sleep };
}

function recordingLogger() {
  const warnings: { message: string; fields: LogFields | undefined }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => warnings.push({ message, fields }),
    error: () => undefined,
  };
  return { logger, warnings };
}

function chain(steps: Record<string, FakeStep[]>, options: { cooldownMs?: number; timeouts?: Record<string, number> } = {}) {
  const { clock, sleep, time } = manualTime();
  const { logger, warnings } = recordingLogger();
  const providers = Object.fromEntries(Object.entries(steps).map(([name, s]) => [name, new FakeProvider(s, { model: `${name}-model`, sleep })]));
  const adapter = new FallbackAdapter({
    steps: Object.entries(providers).map(([name, provider]) => ({ name, adapter: provider, timeoutMs: options.timeouts?.[name] ?? 15_000 })),
    cooldownMs: options.cooldownMs ?? 60_000,
    logger,
    clock,
  });
  return { adapter, providers, warnings, time };
}

const request = (timeoutMs = 100_000): ProviderRequest => ({ system: 'SYSTEM', userText: 'USER', maxOutputTokens: 256, timeoutMs });
const reply = FakeProvider.json(OK);

describe('FallbackAdapter', () => {
  it('answers from the first provider and prefixes the model with its name', async () => {
    const { adapter, providers } = chain({ groq: [reply], gemini: [], nvidia: [] });
    const response = await adapter.complete(request());
    expect(response.model).toBe('groq/groq-model');
    expect(providers['gemini']?.requests).toHaveLength(0);
    expect(adapter.model).toBe('groq/groq-model');
  });

  it.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH', 'PROVIDER_BAD_REQUEST'] as const)(
    'falls back to the next provider on %s and logs the code only',
    async (code) => {
      const { adapter, warnings } = chain({ groq: [{ kind: 'error', code }], gemini: [reply], nvidia: [] });
      const response = await adapter.complete(request());
      expect(response.model).toBe('gemini/gemini-model');
      expect(warnings).toEqual([{ message: 'llm.fallback', fields: { provider: 'groq', code, status: null, timeoutMs: 15_000 } }]);
    },
  );

  it('caps every provider but the last at its own timeout, and gives the last whatever is left', async () => {
    const { adapter, providers } = chain(
      { groq: [{ kind: 'reply', text: '{}', delayMs: 20_000 }], gemini: [{ kind: 'reply', text: '{}', delayMs: 30_000 }], nvidia: [reply] },
      { timeouts: { groq: 15_000, gemini: 25_000, nvidia: 15_000 } },
    );
    const response = await adapter.complete(request(100_000));
    expect(response.model).toBe('nvidia/nvidia-model');
    expect(providers['groq']?.requests[0]?.timeoutMs).toBe(15_000);
    expect(providers['gemini']?.requests[0]?.timeoutMs).toBe(25_000);
    expect(providers['nvidia']?.requests[0]?.timeoutMs).toBe(60_000);
  });

  it('never gives a provider more than the caller has left', async () => {
    const { adapter, providers } = chain({ groq: [reply], gemini: [] }, { timeouts: { groq: 15_000 } });
    await adapter.complete(request(5_000));
    expect(providers['groq']?.requests[0]?.timeoutMs).toBe(5_000);
  });

  it('skips a provider that just failed until its cooldown ends', async () => {
    const { adapter, providers, time } = chain({ groq: [{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }, reply], gemini: [reply, reply] }, { cooldownMs: 60_000 });
    await adapter.complete(request());
    expect((await adapter.complete(request())).model).toBe('gemini/gemini-model');
    expect(providers['groq']?.requests).toHaveLength(1);

    time.now += 60_000;
    expect((await adapter.complete(request())).model).toBe('groq/groq-model');
  });

  it('tries every provider when all of them are cooling down', async () => {
    const { adapter } = chain({
      groq: [{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }, reply],
      gemini: [{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }],
    });
    await expect(adapter.complete(request())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((await adapter.complete(request())).model).toBe('groq/groq-model');
  });

  it('throws the last error when every provider fails', async () => {
    const { adapter } = chain({ groq: [{ kind: 'error', code: 'PROVIDER_AUTH' }], gemini: [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED' }] });
    const error = await adapter.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });
  });

  it('stops at once on ABORTED and never tries the next provider', async () => {
    const { adapter, providers } = chain({ groq: [{ kind: 'error', code: 'ABORTED' }], gemini: [reply] });
    await expect(adapter.complete(request())).rejects.toMatchObject({ code: 'ABORTED' });
    expect(providers['gemini']?.requests).toHaveLength(0);
  });

  it('works under LlmClient: a failing first provider still yields a schema-valid result', async () => {
    const { adapter } = chain({ groq: [{ kind: 'error', code: 'PROVIDER_TIMEOUT' }], gemini: [reply] });
    const client = new LlmClient({ adapter, timeoutMs: 100_000, maxOutputTokens: 256 });
    const result = await client.generateStructured({
      schemaName: 'answer',
      schema: z.strictObject({ answer: z.int() }),
      system: 'Reply with JSON.',
      parts: [{ kind: 'trusted', text: 'What is 6 x 7?' }],
    });
    expect(result).toMatchObject({ data: OK, model: 'gemini/gemini-model', attempts: 1 });
  });

  it('refuses an empty chain', () => {
    expect(() => new FallbackAdapter({ steps: [], cooldownMs: 0 })).toThrow();
  });
});

describe('loadFallbackLlmConfig', () => {
  const full = {
    LLM_PROVIDERS: 'groq, Gemini ,nvidia',
    LLM_GROQ_API_KEY: KEY,
    LLM_GROQ_MODEL: 'groq-model',
    LLM_GEMINI_API_KEY: KEY,
    LLM_GEMINI_MODEL: 'gemini-model',
    LLM_NVIDIA_API_KEY: KEY,
    LLM_NVIDIA_MODEL: 'mistralai/mistral-large-4-1t-a52b',
  };

  function configError(env: Record<string, string | undefined>): LlmConfigError {
    try {
      loadFallbackLlmConfig(env);
    } catch (error) {
      if (error instanceof LlmConfigError) return error;
      throw error;
    }
    throw new Error('expected loadFallbackLlmConfig to throw');
  }

  it('is undefined when LLM_PROVIDERS is unset or empty, so the single-provider config applies', () => {
    expect(loadFallbackLlmConfig({ LLM_API_KEY: KEY })).toBeUndefined();
    expect(loadFallbackLlmConfig({ LLM_PROVIDERS: '' })).toBeUndefined();
  });

  it('reads the chain in order, with known base URLs and documented defaults', () => {
    const config = loadFallbackLlmConfig(full);
    expect(config?.links.map((link) => [link.name, link.baseUrl, link.model, link.timeoutMs])).toEqual([
      ['groq', KNOWN_BASE_URLS['groq'], 'groq-model', 30_000],
      ['gemini', KNOWN_BASE_URLS['gemini'], 'gemini-model', 30_000],
      ['nvidia', KNOWN_BASE_URLS['nvidia'], 'mistralai/mistral-large-4-1t-a52b', 30_000],
    ]);
    expect(config).toMatchObject({ timeoutMs: 120_000, maxOutputTokens: 8_192, cooldownMs: 60_000 });
    expect(config?.links[0]).toMatchObject({ provider: 'openai-compatible', requestsPerMinute: 30, maxOutputTokens: 8_192 });
  });

  it('reads per-provider overrides', () => {
    const config = loadFallbackLlmConfig({
      ...full,
      LLM_TIMEOUT_MS: '100000',
      LLM_FALLBACK_COOLDOWN_MS: '30000',
      LLM_GROQ_TIMEOUT_MS: '15000',
      LLM_GROQ_REASONING_EFFORT: 'low',
      LLM_GROQ_REQUESTS_PER_MINUTE: '20',
      LLM_GEMINI_BASE_URL: 'https://example.test/v1/',
    });
    expect(config).toMatchObject({ timeoutMs: 100_000, cooldownMs: 30_000 });
    expect(config?.links[0]).toMatchObject({ timeoutMs: 15_000, reasoningEffort: 'low', requestsPerMinute: 20 });
    expect(config?.links[1]?.baseUrl).toBe('https://example.test/v1');
  });

  it('names every missing variable at once, never a value', () => {
    const error = configError({ LLM_PROVIDERS: 'groq,gemini', LLM_GROQ_MODEL: 'm', LLM_GEMINI_API_KEY: KEY });
    expect(error.variables).toEqual(['LLM_GEMINI_MODEL', 'LLM_GROQ_API_KEY']);
    expect(error.message).not.toContain(KEY);
  });

  it('needs a base URL for a name it does not know', () => {
    expect(configError({ LLM_PROVIDERS: 'acme', LLM_ACME_API_KEY: KEY, LLM_ACME_MODEL: 'm' }).variables).toEqual(['LLM_ACME_BASE_URL']);
  });

  it.each(['groq,groq', 'gr-oq', ',', 'a,b,c,d,e,f'])('rejects LLM_PROVIDERS=%j', (value) => {
    expect(configError({ ...full, LLM_PROVIDERS: value }).variables).toEqual(['LLM_PROVIDERS']);
  });

  it('never serializes a key', () => {
    expect(JSON.stringify(loadFallbackLlmConfig(full))).not.toContain(KEY);
  });
});
