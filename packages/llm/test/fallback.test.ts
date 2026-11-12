import { describe, expect, it } from 'vitest';
import { createAdapter, createServingAdapter } from '../src/adapters/create.js';
import { FakeProvider, type FakeStep } from '../src/adapters/fake.js';
import { FALLBACK_CODES, FallbackAdapter } from '../src/adapters/fallback.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { LlmClient } from '../src/client.js';
import { GEMINI_OPENAI_BASE_URL, LlmConfigError, loadLlmConfig } from '../src/config.js';
import { ProviderError, type ProviderErrorCode } from '../src/errors.js';
import type { LogFields, Logger } from '../src/logger.js';
import type { ProviderRequest } from '../src/provider.js';

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 'sys',
  userText: 'user',
  maxOutputTokens: 100,
  timeoutMs: 100_000,
  ...overrides,
});

function recordingLogger(): Logger & { warnings: Array<{ message: string; fields: LogFields }> } {
  const warnings: Array<{ message: string; fields: LogFields }> = [];
  const noop = () => undefined;
  return { warnings, debug: noop, info: noop, error: noop, warn: (message, fields) => warnings.push({ message, fields }) };
}

function setup(primarySteps: FakeStep[], fallbackSteps: FakeStep[], options: { cooldownMs?: number; now?: () => number } = {}) {
  const primary = new FakeProvider(primarySteps, { model: 'nvidia-model' });
  const fallback = new FakeProvider(fallbackSteps, { model: 'gemini-model' });
  const logger = recordingLogger();
  const adapter = new FallbackAdapter({
    primary,
    fallback,
    reserveMs: 30_000,
    cooldownMs: options.cooldownMs ?? 0,
    logger,
    clock: { now: options.now ?? (() => 0) },
  });
  return { primary, fallback, logger, adapter };
}

describe('FallbackAdapter', () => {
  it('uses only the primary when it answers', async () => {
    const { adapter, fallback } = setup([FakeProvider.json({ ok: 1 })], []);
    const response = await adapter.complete(request());
    expect(response.model).toBe('nvidia-model');
    expect(fallback.requests).toHaveLength(0);
  });

  it.each([...FALLBACK_CODES])('hands %s to the fallback and reports the model that answered', async (code) => {
    const { adapter, logger } = setup([{ kind: 'error', code }], [FakeProvider.json({ ok: 1 })]);
    const response = await adapter.complete(request());
    expect(response.model).toBe('gemini-model');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toBe('llm.fallback');
    expect(logger.warnings[0]?.fields).toMatchObject({ reason: 'primary_failed', code, primaryModel: 'nvidia-model', fallbackModel: 'gemini-model' });
  });

  it.each<ProviderErrorCode>(['PROVIDER_BAD_REQUEST', 'ABORTED', 'CONTEXT_TOO_LARGE'])('does not fall back on %s', async (code) => {
    const { adapter, fallback } = setup([{ kind: 'error', code }], [FakeProvider.json({ ok: 1 })]);
    await expect(adapter.complete(request())).rejects.toMatchObject({ code });
    expect(fallback.requests).toHaveLength(0);
  });

  it('a 400 on one request neither falls back nor starts the cooldown for the next caller', async () => {
    const { adapter, primary, fallback } = setup(
      [{ kind: 'error', code: 'PROVIDER_BAD_REQUEST' }, FakeProvider.json({ ok: 'next caller' })],
      [FakeProvider.json({ ok: 1 })],
      { cooldownMs: 60_000 },
    );
    await expect(adapter.complete(request())).rejects.toMatchObject({ code: 'PROVIDER_BAD_REQUEST' });
    expect((await adapter.complete(request())).model).toBe('nvidia-model');
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
  });

  it('times out without calling the fallback when the primary used up all the time', async () => {
    let now = 0;
    const primary = {
      provider: 'p',
      model: 'nvidia-model',
      complete(r: ProviderRequest) {
        now += r.timeoutMs + 40_000; // overran its slice and the reserve, e.g. an adapter ignoring its timeout
        return Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE'));
      },
    };
    const fallback = new FakeProvider([FakeProvider.json({ ok: 1 })], { model: 'gemini-model' });
    const adapter = new FallbackAdapter({ primary, fallback, reserveMs: 30_000, cooldownMs: 0, clock: { now: () => now } });

    await expect(adapter.complete(request({ timeoutMs: 120_000 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(fallback.requests).toHaveLength(0);
  });

  it('does not fall back on a refusal: the reply is returned for LlmClient to reject', async () => {
    const { adapter, fallback } = setup([FakeProvider.json({}, { stopReason: 'refusal' })], [FakeProvider.json({ ok: 1 })]);
    const response = await adapter.complete(request());
    expect(response.stopReason).toBe('refusal');
    expect(fallback.requests).toHaveLength(0);
  });

  it('does not fall back once the caller has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, fallback } = setup([{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }], [FakeProvider.json({ ok: 1 })]);
    await expect(adapter.complete(request({ signal: controller.signal }))).rejects.toBeInstanceOf(ProviderError);
    expect(fallback.requests).toHaveLength(0);
  });

  it('rethrows the fallback error when both fail', async () => {
    const { adapter } = setup([{ kind: 'error', code: 'PROVIDER_TIMEOUT' }], [{ kind: 'error', code: 'PROVIDER_AUTH' }]);
    await expect(adapter.complete(request())).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('holds reserveMs back from the primary and gives the fallback the time that is left', async () => {
    let now = 0;
    const primary = {
      provider: 'p',
      model: 'nvidia-model',
      requests: [] as ProviderRequest[],
      complete(r: ProviderRequest) {
        this.requests.push(r);
        now += r.timeoutMs; // the primary used its whole slice, then timed out
        return Promise.reject(new ProviderError('PROVIDER_TIMEOUT'));
      },
    };
    const fallback = new FakeProvider([FakeProvider.json({ ok: 1 })], { model: 'gemini-model' });
    const adapter = new FallbackAdapter({ primary, fallback, reserveMs: 30_000, cooldownMs: 0, clock: { now: () => now } });

    await adapter.complete(request({ timeoutMs: 120_000 }));
    expect(primary.requests[0]?.timeoutMs).toBe(90_000);
    expect(fallback.requests[0]?.timeoutMs).toBe(30_000);
  });

  it('splits a short deadline evenly', async () => {
    const { adapter, primary } = setup([FakeProvider.json({ ok: 1 })], []);
    await adapter.complete(request({ timeoutMs: 40_000 }));
    expect(primary.requests[0]?.timeoutMs).toBe(20_000);
  });

  it('skips the primary during the cooldown, then tries it again', async () => {
    let now = 0;
    const { adapter, primary, fallback, logger } = setup(
      [{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }, FakeProvider.json({ ok: 'back' })],
      [FakeProvider.json({ ok: 1 }), FakeProvider.json({ ok: 2 })],
      { cooldownMs: 60_000, now: () => now },
    );

    await adapter.complete(request()); // primary fails, fallback answers
    now = 59_999;
    expect((await adapter.complete(request())).model).toBe('gemini-model'); // cooldown: primary not called
    expect(primary.requests).toHaveLength(1);
    expect(logger.warnings.at(-1)?.fields).toMatchObject({ reason: 'cooldown' });

    now = 60_000;
    expect((await adapter.complete(request())).model).toBe('nvidia-model');
    expect(fallback.requests).toHaveLength(2);
  });

  it('surfaces the switch through LlmClient: the result names the fallback model', async () => {
    const { adapter } = setup([{ kind: 'error', code: 'PROVIDER_AUTH' }], [FakeProvider.json({ item: 'markers' })]);
    const { z } = await import('zod');
    const client = new LlmClient({ adapter, timeoutMs: 100_000, maxOutputTokens: 1_000 });
    const result = await client.generateStructured({
      schemaName: 'test',
      schema: z.strictObject({ item: z.string() }),
      system: 'sys',
      parts: [{ kind: 'trusted', text: 'buy markers' }],
    });
    expect(result).toMatchObject({ data: { item: 'markers' }, model: 'gemini-model', attempts: 1 });
  });
});

describe('fallback configuration', () => {
  const primaryEnv = {
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    LLM_MODEL: 'mistralai/mistral-large-4-1t-a52b',
    LLM_API_KEY: 'nvapi-PLACEHOLDER',
  };
  const fallbackEnv = { LLM_FALLBACK_API_KEY: 'gemini-PLACEHOLDER', LLM_FALLBACK_MODEL: 'gemini-test-model' };

  it('is off without LLM_FALLBACK_API_KEY', () => {
    expect(loadLlmConfig(primaryEnv).fallback).toBeUndefined();
    expect(loadLlmConfig({ ...primaryEnv, LLM_FALLBACK_API_KEY: '' }).fallback).toBeUndefined();
  });

  it('defaults to Gemini and documented limits', () => {
    const { fallback } = loadLlmConfig({ ...primaryEnv, ...fallbackEnv });
    expect(fallback).toMatchObject({
      baseUrl: GEMINI_OPENAI_BASE_URL,
      model: 'gemini-test-model',
      requestsPerMinute: 10,
      reserveMs: 30_000,
      cooldownMs: 60_000,
    });
    expect(fallback?.apiKey.reveal()).toBe('gemini-PLACEHOLDER');
    expect(JSON.stringify(fallback)).not.toContain('gemini-PLACEHOLDER');
  });

  it('requires a model once the key is set, and reports it with primary problems', () => {
    let caught: unknown;
    try {
      loadLlmConfig({ ...primaryEnv, LLM_API_KEY: '', LLM_FALLBACK_API_KEY: 'gemini-PLACEHOLDER' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmConfigError);
    expect((caught as LlmConfigError).variables).toEqual(['LLM_API_KEY', 'LLM_FALLBACK_MODEL']);
  });

  it('works behind the anthropic provider too', () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-PLACEHOLDER', ...fallbackEnv }).fallback?.model).toBe('gemini-test-model');
  });

  it('createAdapter never adds the fallback (evals measure one model); createServingAdapter does', () => {
    const config = loadLlmConfig({ ...primaryEnv, ...fallbackEnv });
    expect(createAdapter(config)).toBeInstanceOf(OpenAICompatibleAdapter);
    const serving = createServingAdapter(config);
    expect(serving).toBeInstanceOf(FallbackAdapter);
    expect(serving.provider).toBe('openai-compatible+fallback:openai-compatible');
    expect(createServingAdapter(loadLlmConfig(primaryEnv))).toBeInstanceOf(OpenAICompatibleAdapter);
  });
});
