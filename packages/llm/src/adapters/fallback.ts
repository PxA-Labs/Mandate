import { ProviderError, type ProviderErrorCode } from '../errors.js';
import { type Logger, noopLogger } from '../logger.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '../provider.js';
import { type Clock, systemClock } from '../time.js';

/**
 * Failures of the primary provider itself (down, slow, throttled, or rejecting our key), which hand
 * the call to the fallback. Deliberately not included:
 * - PROVIDER_BAD_REQUEST: a 400 is usually about this request, not the provider. Request text is
 *   user-controlled, so one input the primary rejects (a content filter, say) would otherwise flip
 *   every user to the fallback for the cooldown: a silent model switch (decision 9). A 400 caused by
 *   our own bug must also fail loudly, not be hidden.
 * - ABORTED (the caller gave up) and CONTEXT_TOO_LARGE (the same prompt would not fit elsewhere).
 * Refusals and invalid output are not adapter errors at all, so they never reach this class: the
 * model is never switched to get a different answer (docs/llm-layer.md, decision 9).
 */
export const FALLBACK_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTH',
]);

export interface FallbackAdapterOptions {
  primary: ProviderAdapter;
  fallback: ProviderAdapter;
  /** Milliseconds of each call's time held back from the primary for the fallback. */
  reserveMs: number;
  /** After a primary failure, calls go straight to the fallback for this long. 0 disables it. */
  cooldownMs: number;
  logger?: Logger;
  clock?: Clock;
}

/**
 * Tries the primary provider, and on a transport failure sends the same request to the fallback.
 * Transport only, like every adapter: no parsing, validation or retries. LlmClient's retries and
 * deadline still wrap the whole call. Every hand-over is logged (llm.fallback), and
 * ProviderResponse.model names the model that actually answered (llm.result), so the logs never hide a
 * switch. The purchase's audit entry does not record the model yet.
 */
export class FallbackAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly model: string;
  readonly #primary: ProviderAdapter;
  readonly #fallback: ProviderAdapter;
  readonly #reserveMs: number;
  readonly #cooldownMs: number;
  readonly #logger: Logger;
  readonly #clock: Clock;
  #skipPrimaryUntil = 0;

  constructor(options: FallbackAdapterOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#reserveMs = options.reserveMs;
    this.#cooldownMs = options.cooldownMs;
    this.#logger = options.logger ?? noopLogger;
    this.#clock = options.clock ?? systemClock;
    this.provider = `${options.primary.provider}+fallback:${options.fallback.provider}`;
    this.model = options.primary.model;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.#clock.now() < this.#skipPrimaryUntil) {
      this.#log('cooldown', undefined);
      return this.#fallback.complete(request);
    }

    const started = this.#clock.now();
    try {
      return await this.#primary.complete({ ...request, timeoutMs: this.#primaryBudget(request.timeoutMs) });
    } catch (error) {
      if (!(error instanceof ProviderError) || !FALLBACK_CODES.has(error.code) || request.signal?.aborted) throw error;
      if (this.#cooldownMs > 0) this.#skipPrimaryUntil = this.#clock.now() + this.#cooldownMs;
      this.#log('primary_failed', error.code);
      const left = request.timeoutMs - (this.#clock.now() - started);
      if (left <= 0) throw new ProviderError('PROVIDER_TIMEOUT');
      return this.#fallback.complete({ ...request, timeoutMs: left });
    }
  }

  /**
   * The primary's share of the call's time. With room for both, the fallback keeps reserveMs; with
   * less, the time is split evenly so a short deadline never starves either side.
   */
  #primaryBudget(timeoutMs: number): number {
    return timeoutMs > 2 * this.#reserveMs ? timeoutMs - this.#reserveMs : Math.floor(timeoutMs / 2);
  }

  #log(reason: 'primary_failed' | 'cooldown', code: ProviderErrorCode | undefined): void {
    this.#logger.warn('llm.fallback', {
      reason,
      code: code ?? null,
      primaryProvider: this.#primary.provider,
      primaryModel: this.#primary.model,
      fallbackProvider: this.#fallback.provider,
      fallbackModel: this.#fallback.model,
    });
  }
}
