import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PurchaseView } from '../src/api';
import { DecisionSlip } from '../src/components/DecisionSlip';
import { stampFor } from '../src/copy';

const decision = (outcome: 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY'): NonNullable<PurchaseView['decision']> => ({
  outcome,
  reasons: [],
  policyVersion: '0.1.0',
  evaluatedTotal: { amountMinor: 35500, currency: 'USD' },
});

const purchase = (status: string, outcome: 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY', order?: PurchaseView['order']): PurchaseView => ({
  id: '18f28e55-8844-4427-8584-7c47ce7d1d5b',
  mandateId: '00000000-0000-4000-8000-000000000021',
  status,
  decision: decision(outcome),
  ...(order ? { order } : {}),
});

const ORDER = { id: '0ab3751f-5f4e-43c2-9888-361677563574', state: 'PAYMENT_PENDING', providerStatus: 'PAYER_ACTION_REQUIRED' };

describe('stampFor', () => {
  it('stamps the policy outcome while the request waits for the approver', () => {
    expect(stampFor(purchase('PENDING_APPROVAL', 'NEEDS_APPROVAL'))).toEqual({ label: 'Needs approval', tone: 'review' });
  });

  it.each(['PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED', 'FAILED'])('stamps Approved once an approved request is %s', (status) => {
    expect(stampFor(purchase(status, 'NEEDS_APPROVAL'))).toEqual({ label: 'Approved', tone: 'allow' });
  });

  it('stamps the approver rejecting it, or nobody deciding in time', () => {
    expect(stampFor(purchase('REJECTED', 'NEEDS_APPROVAL'))).toEqual({ label: 'Rejected', tone: 'deny' });
    expect(stampFor(purchase('EXPIRED', 'NEEDS_APPROVAL'))).toEqual({ label: 'Expired', tone: 'deny' });
  });

  it('keeps the policy outcome for carts that never needed a person', () => {
    expect(stampFor(purchase('CAPTURED', 'ALLOW'))).toEqual({ label: 'Allowed', tone: 'allow' });
    expect(stampFor(purchase('DENIED', 'DENY'))).toEqual({ label: 'Denied', tone: 'deny' });
  });

  it('has no stamp before the policy has decided', () => {
    expect(stampFor({ id: ORDER.id, mandateId: ORDER.id, status: 'RECEIVED' })).toBeUndefined();
  });
});

describe('DecisionSlip', () => {
  const html = (view: PurchaseView) => renderToStaticMarkup(createElement(DecisionSlip, { purchase: view }));

  it('shows Approved, not Needs approval, after the approver said yes', () => {
    const out = html(purchase('PAYMENT_PENDING', 'NEEDS_APPROVAL', ORDER));
    expect(out).toContain('aria-label="Decision: Approved"');
    expect(out).toContain('stamp stamp--allow');
    expect(out).not.toContain('Needs approval');
  });

  it('labels our internal order id as "Order", not as a PayPal order id', () => {
    const out = html(purchase('PAYMENT_PENDING', 'ALLOW', ORDER));
    expect(out).toContain(`Order <code>${ORDER.id}</code>`);
    expect(out).not.toContain('PayPal order');
  });
});
