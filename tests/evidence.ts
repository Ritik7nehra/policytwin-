import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sanitizeFinancialEvidence } from '@/lib/security/sanitize';

/**
 * Evidence files for the opt-in LIVE suites. They contain only resource ids, request ids, HTTP statuses, issue codes,
 * counts and timestamps (everything is passed through sanitizeFinancialEvidence first) — never credentials, tokens or card data.
 * A file exists only if a live run really happened: the suites are skipped (and write nothing) without credentials.
 */
export function writeEvidence(kind: 'paypal-sandbox' | 'openai-eval', data: Record<string, unknown>): string {
  const dir = path.resolve(process.env.EVIDENCE_DIR || 'evidence');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${kind}-${stamp}.json`);
  const doc = { kind, executed_at: new Date().toISOString(), node: process.version, ...(sanitizeFinancialEvidence(data) as object) };
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
