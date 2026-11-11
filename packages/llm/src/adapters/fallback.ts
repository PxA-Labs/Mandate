import type { FallbackLlmConfig } from '../config.js';
import { ProviderError } from '../errors.js';
import { type Logger, noopLogger } from '../logger.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '../provider.js';
import { type Clock, systemClock } from '../time.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

export interface FallbackStep {
  /** Lowercase provider name, e.g. "groq". */
  name: string;
  adapter: ProviderAdapter;
  /** The most this provider may take of the remaining deadline. Ignored for the last provider tried. */
  timeoutMs: number;
}

export interface FallbackAdapterOptions {
  steps: readonly FallbackStep[];
  /** How long a provider that just failed is skipped. */
  cooldownMs: number;
  logger?: Logger;
  clock?: Clock;
}

/**
 * Tries providers in order, for slow or overloaded free tiers. A provider that fails with any
 * ProviderError except ABORTED hands over to the next one and is skipped for cooldownMs, so one slow
 * provider does not cost every request its timeout. Safe to repeat: the LLM layer has no tools and moves
 * no money (ADR 0004). Retries, repair and the overall deadline stay with LlmClient; this only picks who answers.
 */
export class FallbackAdapter implements ProviderAdapter {
  readonly provider = 'fallback';
  readonly model: string;
  readonly #steps: readonly FallbackStep[];
  readonly #cooldownMs: number;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #skipUntil = new Map<string, number>();

  constructor(options: FallbackAdapterOptions) {
    const first = options.steps[0];
    if (first === undefined) throw new Error('FallbackAdapter needs at least one provider');
    this.#steps = options.steps;
    this.model = `${first.name}/${first.adapter.model}`;
    this.#cooldownMs = options.cooldownMs;
    this.#logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? systemClock;
  }

  static fromConfig(config: FallbackLlmConfig, logger?: Logger): FallbackAdapter {
    return new FallbackAdapter({
      steps: config.links.map((link) => ({ name: link.name, adapter: OpenAICompatibleAdapter.fromConfig(link), timeoutMs: link.timeoutMs })),
      cooldownMs: config.cooldownMs,
      ...(logger ? { logger } : {}),
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const deadline = this.#clock.now() + request.timeoutMs;
    // When every provider is cooling down, try them all rather than none.
    const ready = this.#steps.filter((step) => (this.#skipUntil.get(step.name) ?? 0) <= this.#clock.now());
    const order = ready.length > 0 ? ready : this.#steps;

    let lastError: ProviderError | undefined;
    for (const [index, step] of order.entries()) {
      if (request.signal?.aborted) throw new ProviderError('ABORTED');
      const remaining = deadline - this.#clock.now();
      if (remaining <= 0) break;
      const timeoutMs = index === order.length - 1 ? remaining : Math.min(step.timeoutMs, remaining);
      try {
        const response = await step.adapter.complete({ ...request, timeoutMs });
        this.#skipUntil.delete(step.name);
        return { ...response, model: `${step.name}/${response.model}` };
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code === 'ABORTED') throw error;
        this.#skipUntil.set(step.name, this.#clock.now() + this.#cooldownMs);
        // Codes and status only: a provider message could echo request content.
        this.#logger.warn('llm.fallback', { provider: step.name, code: error.code, status: error.details.status ?? null, timeoutMs });
        lastError = error;
      }
    }
    throw lastError ?? new ProviderError('PROVIDER_TIMEOUT');
  }
}
