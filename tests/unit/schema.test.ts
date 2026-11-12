import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TABLE_DEFS, buildSchemaSql } from '@/lib/store/tables';

describe('database schema', () => {
  it('db/schema.sql is exactly what the table definitions generate (run `npm run db:schema` if this fails)', () => {
    const onDisk = readFileSync(path.resolve(__dirname, '../../db/schema.sql'), 'utf8');
    expect(onDisk).toBe(buildSchemaSql());
  });

  it('contains every table the spec’s data model requires', () => {
    const need = ['policies', 'policy_versions', 'test_runs', 'scenarios', 'policy_decisions', 'paypal_executions', 'invariant_results', 'agent_runs', 'audit_events', 'webhook_events'];
    for (const t of need) expect(Object.keys(TABLE_DEFS)).toContain(t);
  });

  it('webhook_events is keyed by the PayPal event id so a duplicate insert is impossible', () => {
    expect(buildSchemaSql()).toMatch(/CREATE TABLE IF NOT EXISTS webhook_events \([^)]*id TEXT PRIMARY KEY/s);
  });
});
