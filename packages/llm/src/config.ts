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

interface CommonLlmConfig {
  model: string;
  apiKey: Secret;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

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

function variablesOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'env')))].sort();
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

  if (provider.data.LLM_PROVIDER === 'anthropic') {
    const parsed = AnthropicEnvSchema.safeParse(env);
    if (!parsed.success) throw new LlmConfigError(variablesOf(parsed.error));
    return {
      provider: 'anthropic',
      model: parsed.data.LLM_MODEL,
      apiKey: new Secret(parsed.data.ANTHROPIC_API_KEY),
      timeoutMs: parsed.data.LLM_TIMEOUT_MS,
      maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
    };
  }

  const parsed = CompatibleEnvSchema.safeParse(env);
  if (!parsed.success) throw new LlmConfigError(variablesOf(parsed.error));
  return {
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

/** One provider in the fallback chain: an OpenAI-compatible endpoint with its own share of the deadline. */
export type FallbackLink = Extract<LlmConfig, { provider: 'openai-compatible' }> & {
  /** Lowercase name from LLM_PROVIDERS, e.g. "groq". Prefixes the model in logs. */
  name: string;
};

export interface FallbackLlmConfig {
  /** Tried in order. Every link but the last gets at most its own timeoutMs; the last gets what is left. */
  links: readonly FallbackLink[];
  /** Overall deadline for one structured call, every provider and retry included (LLM_TIMEOUT_MS). */
  timeoutMs: number;
  maxOutputTokens: number;
  /** How long a provider that just failed is skipped (LLM_FALLBACK_COOLDOWN_MS). */
  cooldownMs: number;
}

/** Base URLs for well-known names, so only the key and model need setting. LLM_<NAME>_BASE_URL overrides. */
export const KNOWN_BASE_URLS: Readonly<Record<string, string>> = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

const ProviderNameSchema = z.string().regex(/^[a-z][a-z0-9]{0,19}$/);

const FallbackEnvSchema = z.object({
  ...CommonSchema,
  LLM_PROVIDERS: z
    .string()
    .transform((value) => value.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== ''))
    .pipe(z.array(ProviderNameSchema).min(1).max(5).refine((names) => new Set(names).size === names.length)),
  LLM_FALLBACK_COOLDOWN_MS: unsetIfEmpty(z.coerce.number().int().min(0).max(600_000).default(60_000)),
});

const LinkEnvSchema = z.object({
  BASE_URL: BaseUrlSchema,
  MODEL: unsetIfEmpty(ModelSchema),
  API_KEY: unsetIfEmpty(z.string().min(1)),
  TIMEOUT_MS: unsetIfEmpty(z.coerce.number().int().min(1_000).max(300_000).default(30_000)),
  REASONING_EFFORT: unsetIfEmpty(z.enum(['low', 'medium', 'high']).optional()),
  REQUESTS_PER_MINUTE: unsetIfEmpty(z.coerce.number().int().min(1).max(1_000).default(30)),
});

/**
 * The fallback chain (LLM_PROVIDERS=groq,gemini,nvidia), or undefined when LLM_PROVIDERS is unset and the
 * single-provider config applies. Each name reads LLM_<NAME>_API_KEY, LLM_<NAME>_MODEL and optionally
 * LLM_<NAME>_BASE_URL, _TIMEOUT_MS, _REASONING_EFFORT and _REQUESTS_PER_MINUTE. Every link is
 * OpenAI-compatible. Errors name variables only, never values.
 */
export function loadFallbackLlmConfig(env: Readonly<Record<string, string | undefined>> = process.env): FallbackLlmConfig | undefined {
  if (emptyAsUnset(env['LLM_PROVIDERS']) === undefined) return undefined;
  const parsed = FallbackEnvSchema.safeParse(env);
  if (!parsed.success) throw new LlmConfigError(variablesOf(parsed.error));

  const invalid: string[] = [];
  const links: FallbackLink[] = [];
  for (const name of parsed.data.LLM_PROVIDERS) {
    const prefix = `LLM_${name.toUpperCase()}_`;
    const linkEnv: Record<string, string | undefined> = Object.fromEntries(
      Object.keys(LinkEnvSchema.shape).map((key) => [key, env[`${prefix}${key}`]]),
    );
    const baseUrl = linkEnv['BASE_URL'];
    linkEnv['BASE_URL'] = baseUrl === undefined || baseUrl === '' ? KNOWN_BASE_URLS[name] : baseUrl;
    const link = LinkEnvSchema.safeParse(linkEnv);
    if (!link.success) {
      invalid.push(...variablesOf(link.error).map((key) => `${prefix}${key}`));
      continue;
    }
    links.push({
      name,
      provider: 'openai-compatible',
      baseUrl: link.data.BASE_URL,
      model: link.data.MODEL,
      apiKey: new Secret(link.data.API_KEY),
      timeoutMs: link.data.TIMEOUT_MS,
      maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
      requestsPerMinute: link.data.REQUESTS_PER_MINUTE,
      ...(link.data.REASONING_EFFORT === undefined ? {} : { reasoningEffort: link.data.REASONING_EFFORT }),
    });
  }
  if (invalid.length > 0) throw new LlmConfigError([...new Set(invalid)].sort());
  return {
    links,
    timeoutMs: parsed.data.LLM_TIMEOUT_MS,
    maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
    cooldownMs: parsed.data.LLM_FALLBACK_COOLDOWN_MS,
  };
}
