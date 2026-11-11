import { inspect } from 'node:util';
import { z } from 'zod';
import { trimTrailingSlashes } from './adapters/http.js';

const REDACTED = '[REDACTED]';

/** Holds a credential. Every serialization path prints [REDACTED]; only reveal() returns the value. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * A second OpenAI-compatible provider (Gemini by default) that answers when the primary fails at the
 * transport level. Never used for refusals or invalid output. See adapters/fallback.ts.
 */
export interface FallbackLlmConfig {
  baseUrl: string;
  model: string;
  apiKey: Secret;
  requestsPerMinute: number;
  reasoningEffort?: ReasoningEffort;
  /** Milliseconds of each call's deadline held back from the primary, so the fallback has time to answer. */
  reserveMs: number;
  /** After a primary failure, calls skip the primary for this long. */
  cooldownMs: number;
}

interface CommonLlmConfig {
  model: string;
  apiKey: Secret;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Set only when LLM_FALLBACK_API_KEY is. */
  fallback?: FallbackLlmConfig;
}

/** Which provider answers, and how to reach it. Every field comes from loadLlmConfig. */
export type LlmConfig =
  | (CommonLlmConfig & { provider: 'anthropic' })
  | (CommonLlmConfig & {
      provider: 'openai-compatible';
      /** Chat Completions base URL, e.g. https://integrate.api.nvidia.com/v1 (no trailing slash). */
      baseUrl: string;
      /** Sent as reasoning_effort when set; providers that do not know it may reject it. */
      reasoningEffort?: ReasoningEffort;
      /** Client-side throttle, kept under the provider limit. */
      requestsPerMinute: number;
    });

/** Names only, never values: a value could be the key itself. */
export class LlmConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid LLM configuration: ${variables.join(', ')}`);
    this.name = 'LlmConfigError';
    this.variables = variables;
  }
}

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);
const unsetIfEmpty = <T extends z.ZodType>(schema: T) => z.preprocess(emptyAsUnset, schema);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere; plain http only for a local server (Ollama). Never credentials in the URL. */
const BaseUrlSchema = z
  .string()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
    return secure && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  })
  .transform(trimTrailingSlashes);

const ModelSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);

const CommonSchema = {
  LLM_TIMEOUT_MS: unsetIfEmpty(z.coerce.number().int().min(1_000).max(300_000).default(120_000)),
  LLM_MAX_OUTPUT_TOKENS: unsetIfEmpty(z.coerce.number().int().min(256).max(16_000).default(8_192)),
};

const ProviderSchema = z.object({ LLM_PROVIDER: unsetIfEmpty(z.enum(['anthropic', 'openai-compatible']).default('anthropic')) });

const AnthropicEnvSchema = z.object({
  ...CommonSchema,
  LLM_MODEL: unsetIfEmpty(ModelSchema.default('claude-opus-5-5')),
  ANTHROPIC_API_KEY: unsetIfEmpty(z.string().min(1)),
});

const CompatibleEnvSchema = z.object({
  ...CommonSchema,
  LLM_MODEL: unsetIfEmpty(ModelSchema),
  LLM_BASE_URL: unsetIfEmpty(BaseUrlSchema),
  LLM_API_KEY: unsetIfEmpty(z.string().min(1)),
  LLM_REASONING_EFFORT: unsetIfEmpty(z.enum(['low', 'medium', 'high']).optional()),
  LLM_REQUESTS_PER_MINUTE: unsetIfEmpty(z.coerce.number().int().min(1).max(1_000).default(30)),
});

/** Gemini's OpenAI-compatible endpoint. https://ai.google.dev/gemini-api/docs/openai */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const FallbackEnvSchema = z.object({
  LLM_FALLBACK_BASE_URL: unsetIfEmpty(BaseUrlSchema.default(GEMINI_OPENAI_BASE_URL)),
  LLM_FALLBACK_MODEL: unsetIfEmpty(ModelSchema),
  LLM_FALLBACK_API_KEY: unsetIfEmpty(z.string().min(1)),
  LLM_FALLBACK_REASONING_EFFORT: unsetIfEmpty(z.enum(['low', 'medium', 'high']).optional()),
  LLM_FALLBACK_REQUESTS_PER_MINUTE: unsetIfEmpty(z.coerce.number().int().min(1).max(1_000).default(10)),
  LLM_FALLBACK_RESERVE_MS: unsetIfEmpty(z.coerce.number().int().min(1_000).max(120_000).default(30_000)),
  LLM_FALLBACK_COOLDOWN_MS: unsetIfEmpty(z.coerce.number().int().min(0).max(3_600_000).default(60_000)),
});

function variablesOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'env')))].sort();
}

/** Off unless LLM_FALLBACK_API_KEY is set; then LLM_FALLBACK_MODEL is required too. */
function loadFallback(env: Readonly<Record<string, string | undefined>>): FallbackLlmConfig | undefined {
  if (emptyAsUnset(env['LLM_FALLBACK_API_KEY']) === undefined) return undefined;
  const parsed = FallbackEnvSchema.safeParse(env);
  if (!parsed.success) throw new LlmConfigError(variablesOf(parsed.error));
  const data = parsed.data;
  return {
    baseUrl: data.LLM_FALLBACK_BASE_URL,
    model: data.LLM_FALLBACK_MODEL,
    apiKey: new Secret(data.LLM_FALLBACK_API_KEY),
    requestsPerMinute: data.LLM_FALLBACK_REQUESTS_PER_MINUTE,
    reserveMs: data.LLM_FALLBACK_RESERVE_MS,
    cooldownMs: data.LLM_FALLBACK_COOLDOWN_MS,
    ...(data.LLM_FALLBACK_REASONING_EFFORT === undefined ? {} : { reasoningEffort: data.LLM_FALLBACK_REASONING_EFFORT }),
  };
}

/**
 * The only place the LLM layer reads configuration or the API key. Reads the given env object
 * only, so callers and tests control exactly what is visible. LLM_PROVIDER picks which variables
 * apply: anthropic (default) reads ANTHROPIC_API_KEY; openai-compatible reads LLM_BASE_URL,
 * LLM_MODEL and LLM_API_KEY, and never the Anthropic key.
 */
export function loadLlmConfig(env: Readonly<Record<string, string | undefined>> = process.env): LlmConfig {
  const provider = ProviderSchema.safeParse(env);
  if (!provider.success) {
    // Report every problem at once: the rest is checked as for the default provider.
    const rest = AnthropicEnvSchema.safeParse(env);
    throw new LlmConfigError([...new Set([...variablesOf(provider.error), ...(rest.success ? [] : variablesOf(rest.error))])].sort());
  }

  let fallback: FallbackLlmConfig | undefined;
  let fallbackProblems: string[] = [];
  try {
    fallback = loadFallback(env);
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    fallbackProblems = [...error.variables];
  }
  const withFallback = fallback === undefined ? {} : { fallback };
  // Report primary and fallback problems together.
  const fail = (primary: z.ZodError | undefined): never => {
    throw new LlmConfigError([...new Set([...(primary ? variablesOf(primary) : []), ...fallbackProblems])].sort());
  };

  if (provider.data.LLM_PROVIDER === 'anthropic') {
    const parsed = AnthropicEnvSchema.safeParse(env);
    if (!parsed.success) return fail(parsed.error);
    if (fallbackProblems.length > 0) return fail(undefined);
    return {
      provider: 'anthropic',
      model: parsed.data.LLM_MODEL,
      apiKey: new Secret(parsed.data.ANTHROPIC_API_KEY),
      timeoutMs: parsed.data.LLM_TIMEOUT_MS,
      maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
      ...withFallback,
    };
  }

  const parsed = CompatibleEnvSchema.safeParse(env);
  if (!parsed.success) return fail(parsed.error);
  if (fallbackProblems.length > 0) return fail(undefined);
  return {
    ...withFallback,
    provider: 'openai-compatible',
    baseUrl: parsed.data.LLM_BASE_URL,
    model: parsed.data.LLM_MODEL,
    apiKey: new Secret(parsed.data.LLM_API_KEY),
    timeoutMs: parsed.data.LLM_TIMEOUT_MS,
    maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
    requestsPerMinute: parsed.data.LLM_REQUESTS_PER_MINUTE,
    ...(parsed.data.LLM_REASONING_EFFORT === undefined ? {} : { reasoningEffort: parsed.data.LLM_REASONING_EFFORT }),
  };
}
