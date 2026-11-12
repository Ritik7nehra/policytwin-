import { describe, expect, it } from 'vitest';
import { containsSensitive, luhnValid, safeCallEvidence, safeResponseEvidence, sanitizeFinancialEvidence, scrubString } from '@/lib/security/sanitize';
import { log, setLogSink } from '@/lib/security/log';
import { sanitizeExecution } from '@/lib/pipeline';

const PAN = '4111111111111111'; // a well-known SANDBOX/test card number (Luhn-valid), used only to prove it is removed

const confirmBody = { payment_source: { card: { number: PAN, expiry: '2030-01', name: 'Jane Q Buyer', security_code: '123' } } };
const orderResponse = {
  id: 'ORD-1',
  status: 'APPROVED',
  intent: 'CAPTURE',
  payment_source: { card: { name: 'Jane Q Buyer', last_digits: '1111', brand: 'VISA', expiry: '2030-01' } },
  payer: { name: { given_name: 'Jane', surname: 'Buyer' }, email_address: 'jane@example.com', payer_id: 'PAYERID', phone: { phone_number: { national_number: '5551234' } } },
  purchase_units: [
    { reference_id: 'r1', amount: { currency_code: 'USD', value: '40.00' }, shipping: { name: { full_name: 'Jane Buyer' }, address: { address_line_1: '1 Main St', admin_area_2: 'Town', postal_code: '12345', country_code: 'US' } }, payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' } }] } },
  ],
  links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD-1?token=abc' }],
};

describe('sanitizeFinancialEvidence', () => {
  it('removes the card number, expiry, name and security code from a confirm-payment-source request', () => {
    const out = JSON.stringify(sanitizeFinancialEvidence(confirmBody));
    for (const s of [PAN, '2030-01', 'Jane Q Buyer', '123', 'security_code', 'payment_source']) expect(out).not.toContain(s);
  });

  it('removes payer names, e-mail, phone, shipping address and card metadata from a PayPal response — but keeps the evidence', () => {
    const out = sanitizeFinancialEvidence(orderResponse) as any;
    const text = JSON.stringify(out);
    for (const s of ['Jane', 'Buyer', 'jane@example.com', 'PAYERID', '5551234', '1 Main St', '12345', 'Town', '1111', 'VISA', 'token=abc']) expect(text).not.toContain(s);
    // evidence survives
    expect(out.id).toBe('ORD-1');
    expect(out.status).toBe('APPROVED');
    expect(out.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '40.00' });
    expect(out.purchase_units[0].payments.captures[0]).toMatchObject({ id: 'CAP-1', status: 'COMPLETED' });
  });

  it('scrubs a Luhn-valid card number and e-mail address hidden inside a free-text string, and bearer tokens', () => {
    const s = scrubString(`declined card ${PAN.slice(0, 4)} ${PAN.slice(4, 8)} ${PAN.slice(8, 12)} ${PAN.slice(12)} for jane@example.com using Bearer abcdefghijklmnop12345`);
    expect(s).not.toMatch(/4111/);
    expect(s).not.toContain('jane@example.com');
    expect(s).not.toContain('abcdefghijklmnop12345');
    expect(s).toContain('[REDACTED-PAN]');
  });

  it('does not damage ordinary ids, amounts, timestamps or non-Luhn digit runs', () => {
    expect(luhnValid(PAN)).toBe(true);
    expect(luhnValid('1234567890123456')).toBe(false);
    const v = { id: 'run_ab12cd34-scenario_06-refund', request_id: 'WH-1234567890123456', amount: '40.00', t: '2026-01-01T00:00:00.000Z' };
    expect(sanitizeFinancialEvidence(v)).toEqual(v);
  });

  it('keeps PayPal error names (UNPROCESSABLE_ENTITY) but drops person/card names', () => {
    expect(sanitizeFinancialEvidence({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'CAPTURE_FULLY_REFUNDED' }] })).toEqual({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'CAPTURE_FULLY_REFUNDED' }] });
    expect(sanitizeFinancialEvidence({ name: 'Jane Q Buyer', id: 1 })).toEqual({ id: 1 });
  });

  it('is idempotent, never throws on cycles / odd values, and detects residual sensitive data', () => {
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    expect(() => sanitizeFinancialEvidence(cyc)).not.toThrow();
    const once = sanitizeFinancialEvidence(orderResponse);
    expect(sanitizeFinancialEvidence(once)).toEqual(once);
    expect(containsSensitive(orderResponse)).toBe(true);
    expect(containsSensitive(once)).toBe(false);
    expect(sanitizeFinancialEvidence(undefined)).toBeNull();
    expect(sanitizeFinancialEvidence(BigInt(5) as any)).toBe('5');
  });
});

describe('safe evidence projections keep ONLY method · endpoint · request id · amount · currency · resource id · HTTP status · issue code', () => {
  it('request: the confirm call is reduced to method/endpoint/request id (no payment source at all)', () => {
    const e = safeCallEvidence({ method: 'POST', path: '/v2/checkout/orders/ORD-1/confirm-payment-source', request_id: 'rid-1', body: confirmBody });
    expect(e).toEqual({ method: 'POST', endpoint: '/v2/checkout/orders/ORD-1/confirm-payment-source', request_id: 'rid-1', amount: null, currency: null });
  });

  it('request: a create-order call keeps amount and currency', () => {
    const e = safeCallEvidence({ method: 'POST', path: '/v2/checkout/orders', request_id: 'rid-2', body: { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '40.00' } }] } });
    expect(e).toMatchObject({ amount: '40.00', currency: 'USD' });
  });

  it('response: success keeps resource id/status/amount; error keeps the normalised issue code only', () => {
    expect(safeResponseEvidence(200, orderResponse)).toEqual({ http_status: 200, resource_id: 'CAP-1', resource_status: 'COMPLETED', amount: '40.00', currency: 'USD', issue_code: null, error_name: null, debug_id: null });
    const err = safeResponseEvidence(422, { name: 'UNPROCESSABLE_ENTITY', message: 'card 4111111111111111 declined for jane@example.com', debug_id: 'dbg1', details: [{ issue: 'CAPTURE_FULLY_REFUNDED', description: 'x' }] });
    expect(err).toMatchObject({ http_status: 422, issue_code: 'CAPTURE_FULLY_REFUNDED', error_name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1' });
    expect(JSON.stringify(err)).not.toMatch(/4111|jane@/);
  });
});

describe('sanitizer is applied at every output boundary', () => {
  it('execution rows are re-sanitized right before insertion / API output', () => {
    const row = sanitizeExecution({
      id: 'e', test_run_id: 'r', scenario_id: 's', policy_version: 'B', operation: 'confirm_payment_source', request_id: 'rid', logical_request_id: null, paypal_order_id: 'ORD-1', paypal_capture_id: null, paypal_refund_id: null,
      status: 'SUCCESS', http_status: 200, mode: 'sandbox', lane: 'sandbox_proof', request_json: confirmBody, response_json: orderResponse, note: `buyer jane@example.com paid with ${PAN}`,
    });
    const text = JSON.stringify(row);
    for (const s of [PAN, 'jane@example.com', 'Jane', '2030-01']) expect(text).not.toContain(s);
  });

  it('log lines are sanitized', () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    log('info', `charge for ${PAN}`, { payer: { email_address: 'jane@example.com' }, card: { number: PAN }, order_id: 'ORD-1', note: 'jane@example.com' });
    restore();
    expect(lines[0]).toContain('ORD-1');
    for (const s of [PAN, 'jane@example.com']) expect(lines[0]).not.toContain(s);
  });
});
