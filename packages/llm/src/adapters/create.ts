import type { LlmConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { ProviderAdapter } from '../provider.js';
import { AnthropicAdapter } from './anthropic.js';
import { FallbackAdapter } from './fallback.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

/**
 * The primary adapter for a loaded config. The one place that maps LLM_PROVIDER to an adapter.
 * Never adds the fallback: evals call this, so a benchmark run always measures one model.
 */
export function createAdapter(config: LlmConfig): ProviderAdapter {
  return config.provider === 'anthropic' ? AnthropicAdapter.fromConfig(config) : OpenAICompatibleAdapter.fromConfig(config);
}

/** The serving adapter: the primary, wrapped with the fallback when LLM_FALLBACK_API_KEY is set. */
export function createServingAdapter(config: LlmConfig, logger?: Logger): ProviderAdapter {
  const primary = createAdapter(config);
  const { fallback } = config;
  if (fallback === undefined) return primary;
  return new FallbackAdapter({
    primary,
    fallback: new OpenAICompatibleAdapter({
      baseUrl: fallback.baseUrl,
      model: fallback.model,
      apiKey: fallback.apiKey,
      requestsPerMinute: fallback.requestsPerMinute,
      ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort }),
    }),
    reserveMs: fallback.reserveMs,
    cooldownMs: fallback.cooldownMs,
    ...(logger === undefined ? {} : { logger }),
  });
}
