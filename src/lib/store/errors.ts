/** Integrity violations raised by every Store implementation (Postgres error codes 23xxx map onto these). */
export type ConstraintKind = 'unique' | 'foreign_key' | 'check' | 'not_null' | 'other';

export class ConstraintError extends Error {
  constructor(
    readonly kind: ConstraintKind,
    readonly table: string,
    readonly constraint: string,
    message?: string,
  ) {
    super(message ?? `${kind} constraint violated on ${table}${constraint ? ` (${constraint})` : ''}`);
    this.name = 'ConstraintError';
  }
}
export const isUniqueViolation = (e: unknown): e is ConstraintError => e instanceof ConstraintError && e.kind === 'unique';

/** Translate a node-postgres / pg-mem error into a ConstraintError when it is one. */
export function mapPgError(e: unknown, table: string): unknown {
  const code = (e as { code?: string })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  const constraint = (e as { constraint?: string })?.constraint ?? /constraint "([^"]+)"/.exec(msg)?.[1] ?? '';
  if (code === '23505' || /duplicate key value violates unique constraint/i.test(msg) || /unique constraint/i.test(msg)) return new ConstraintError('unique', table, constraint);
  if (code === '23503' || /violates foreign key constraint/i.test(msg)) return new ConstraintError('foreign_key', table, constraint);
  if (code === '23514' || /violates check constraint|check constraint .* is violated/i.test(msg)) return new ConstraintError('check', table, constraint);
  if (code === '23502' || /null value in column|violates not-null constraint/i.test(msg)) return new ConstraintError('not_null', table, constraint);
  return e;
}
