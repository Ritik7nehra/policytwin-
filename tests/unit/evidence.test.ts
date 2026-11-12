import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEvidence } from '../evidence';

describe('evidence files', () => {
  it('contain ids / statuses / codes only — card data, payer data and tokens are stripped before writing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pt-evidence-'));
    process.env.EVIDENCE_DIR = dir;
    try {
      const file = writeEvidence('paypal-sandbox', {
        order_id: 'ORD-1',
        refund: { refund_id: 'REF-1', http_status: 201, issue_code: null },
        leaked: { payment_source: { card: { number: '4111111111111111', expiry: '2030-01' } }, payer: { email_address: 'a@b.co' }, note: 'Bearer abcdefghijklmnop12345' },
      });
      const text = readFileSync(file, 'utf8');
      expect(path.dirname(file)).toBe(dir);
      expect(path.basename(file)).toMatch(/^paypal-sandbox-\d{4}-\d{2}-\d{2}T.*\.json$/);
      expect(JSON.parse(text)).toMatchObject({ kind: 'paypal-sandbox', order_id: 'ORD-1', refund: { refund_id: 'REF-1', http_status: 201 } });
      for (const s of ['4111111111111111', '2030-01', 'a@b.co', 'abcdefghijklmnop12345']) expect(text).not.toContain(s);
    } finally {
      delete process.env.EVIDENCE_DIR;
    }
  });
});
