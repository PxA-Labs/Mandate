import { ApiError, type PurchaseView } from './api';

/** What each request status means to the person who asked, in plain words. */
export const STATUS_TEXT: Record<string, string> = {
  RECEIVED: 'Received. Working on it.',
  NEEDS_CLARIFICATION: 'The agent needs a bit more detail.',
  NO_MATCH: 'No matching products were found.',
  QUOTED: 'Priced. Checking it against the mandate.',
  DENIED: 'Denied by the mandate. Nothing was bought.',
  PENDING_APPROVAL: 'Sent to the approver. Nothing is paid until they approve.',
  REJECTED: 'The approver rejected this request.',
  EXPIRED: 'The approval window closed before anyone decided.',
  PAYMENT_PENDING: 'Allowed. Finish the payment on PayPal.',
  UNKNOWN_OUTCOME: 'PayPal has not confirmed the payment yet. It is being checked.',
  CAPTURED: 'Paid.',
  FAILED: 'Stopped before anything was paid.',
};

/** Why a request stopped. Codes come from the purchase flow; anything unlisted is shown as its code. */
const FAILURE_TEXT: Record<string, string> = {
  INTENT_FAILED: 'The request could not be read. Name the products and quantities you need.',
  CATALOG_FAILED: 'The product catalog did not answer. Try again in a minute.',
  RANKING_FAILED: "The agent's product choice was refused or did not arrive. Nothing was bought.",
  UNKNOWN_CANDIDATE: 'The agent picked a product that was not in the search results, so the order was refused.',
  INVALID_PROPOSAL: "The agent's proposal was malformed, so the order was refused.",
  MIXED_CURRENCY: 'The products were priced in different currencies. Ask for them separately.',
  OVERFLOW: 'The total was too large to compute safely.',
  EXPIRED: 'The approval window closed.',
  PAYPAL_VOIDED: 'PayPal voided the order. The budget hold was released.',
  INTERNAL: 'Something went wrong on our side. Nothing was paid.',
};

export function failureText(code: string | undefined | null): string {
  if (!code) return STATUS_TEXT.FAILED ?? '';
  return FAILURE_TEXT[code] ?? `Stopped: ${code}.`;
}

export const OUTCOME_LABEL: Record<string, string> = { ALLOW: 'Allowed', NEEDS_APPROVAL: 'Needs approval', DENY: 'Denied' };

export type StampTone = 'allow' | 'review' | 'deny';
const OUTCOME_TONE: Record<string, StampTone> = { ALLOW: 'allow', NEEDS_APPROVAL: 'review', DENY: 'deny' };
const APPROVER_STAMP: Record<string, { label: string; tone: StampTone }> = {
  PENDING_APPROVAL: { label: 'Needs approval', tone: 'review' },
  REJECTED: { label: 'Rejected', tone: 'deny' },
  EXPIRED: { label: 'Expired', tone: 'deny' },
};

/**
 * The stamp on the slip. A cart that needed a person shows what the approver did: once the request has left
 * PENDING_APPROVAL other than by a rejection or expiry, it was approved (the policy decision itself never changes).
 */
export function stampFor(purchase: PurchaseView): { label: string; tone: StampTone } | undefined {
  const outcome = purchase.decision?.outcome;
  if (!outcome) return undefined;
  if (outcome === 'NEEDS_APPROVAL') return APPROVER_STAMP[purchase.status] ?? { label: 'Approved', tone: 'allow' };
  return { label: OUTCOME_LABEL[outcome] ?? outcome, tone: OUTCOME_TONE[outcome] ?? 'review' };
}

/** An error a person can act on. Never shows response bodies, which could echo request text. */
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.code === 'NETWORK') return 'The API is not reachable. Check that it is running and that WEB_ORIGIN allows this site.';
  if (error.code === 'VALIDATION_FAILED' || error.status === 400) return 'The API refused the input. Check the values and try again.';
  if (error.status === 403) return 'That person is not allowed to do this.';
  if (error.status === 404) return 'Not found. The mandate or request may not exist on this API.';
  if (error.code === 'UNEXPECTED_RESPONSE') return 'The API answered in an unexpected format. Its version may not match this app.';
  return `The API returned an error (${error.status}).`;
}
