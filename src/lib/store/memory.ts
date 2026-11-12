import { TABLE_SPECS } from './tables';
import { ConstraintError } from './errors';
import type { Store, TableName, TableRows, Where } from './types';

const isRange = (v: unknown): v is { gte?: unknown; lt?: unknown } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k === 'gte' || k === 'lt');

export function rowMatches(row: any, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = row[k];
    if (v === null || v === undefined) return cur == null;
    if (isRange(v)) {
      if (cur == null) return false;
      if (v.gte !== undefined && !(cur >= (v.gte as any))) return false;
      if (v.lt !== undefined && !(cur < (v.lt as any))) return false;
      return true;
    }
    return cur === v;
  });
}

/** Serialises operations: the in-memory store behaves like a single-writer database. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

type Tables = Map<TableName, any[]>;

/**
 * In-memory store: the default when DATABASE_URL is unset. Data is lost on restart.
 * It enforces the SAME constraints as the PostgreSQL schema (not-null, CHECK lists, UNIQUE, FOREIGN KEY
 * with restrict-on-delete) and supports real transactions (copy-on-write + commit/rollback), so tests
 * on this backend exercise the same integrity rules as production.
 */
export class MemoryStore implements Store {
  readonly mode = 'memory' as const;
  private tables: Tables = new Map();
  private readonly mu = new Mutex();
  constructor(private readonly inTx = false, tables?: Tables) {
    if (tables) this.tables = tables;
  }

  async init(): Promise<void> {}
  async ping(): Promise<void> {}

  private exec<R>(fn: () => Promise<R> | R): Promise<R> {
    return this.inTx ? Promise.resolve().then(fn) : this.mu.run(async () => fn());
  }

  private rows<T extends TableName>(t: T): TableRows[T][] {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }

  // ───────────────────────── validation (mirrors the SQL constraints) ─────────────────────────
  private normalize<T extends TableName>(t: T, row: Record<string, unknown>): Record<string, any> {
    const spec = TABLE_SPECS[t];
    for (const k of Object.keys(row)) if (!(k in spec.cols)) throw new Error(`unknown column ${t}.${k}`);
    const out: Record<string, any> = {};
    for (const [k, cs] of Object.entries(spec.cols)) {
      const v = row[k] === undefined ? null : structuredClone(row[k]);
      // TIMESTAMPTZ parity: Postgres hands back canonical ISO-8601 (ms precision, Z).
      out[k] = cs.kind === 'ts' && typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v;
    }
    return out;
  }

  private validate<T extends TableName>(t: T, row: Record<string, any>, selfId: string | null): void {
    const spec = TABLE_SPECS[t];
    for (const [col, cs] of Object.entries(spec.cols)) {
      const v = row[col];
      if (v === null) {
        if (cs.notNull || col === 'id') throw new ConstraintError('not_null', t, `${t}.${col}`, `null value in column "${col}" of relation "${t}" violates not-null constraint`);
        continue;
      }
      const bad =
        (cs.kind === 'text' && typeof v !== 'string') ||
        (cs.kind === 'int' && !Number.isInteger(v)) ||
        (cs.kind === 'bool' && typeof v !== 'boolean') ||
        (cs.kind === 'ts' && (typeof v !== 'string' || Number.isNaN(Date.parse(v))));
      if (bad) throw new ConstraintError('check', t, `${t}_${col}_type`, `invalid ${cs.kind} value for ${t}.${col}`);
    }
    for (const [col, allowed] of Object.entries(spec.checks ?? {})) {
      const v = row[col];
      if (v !== null && !allowed.includes(v)) throw new ConstraintError('check', t, `${t}_${col}_check`, `new row for relation "${t}" violates check constraint "${t}_${col}_check"`);
    }
    const others = this.rows(t).filter((r: any) => r.id !== selfId);
    if (others.some((r: any) => r.id === row.id)) throw new ConstraintError('unique', t, `${t}_pkey`, `duplicate key value violates unique constraint "${t}_pkey" (${t}.${row.id})`);
    for (const cols of spec.unique ?? []) {
      if (cols.some((c) => row[c] === null)) continue; // NULLs never conflict
      if (others.some((r: any) => cols.every((c) => r[c] === row[c]))) {
        throw new ConstraintError('unique', t, `${t}_${cols.join('_')}_key`, `duplicate key value violates unique constraint "${t}_${cols.join('_')}_key"`);
      }
    }
    for (const [col, ref] of Object.entries(spec.fks ?? {})) {
      const v = row[col];
      if (v === null) continue;
      const target = ref === t ? [...this.rows(t), row] : this.rows(ref);
      if (!target.some((r: any) => r.id === v)) throw new ConstraintError('foreign_key', t, `${t}_${col}_fkey`, `insert or update on table "${t}" violates foreign key constraint "${t}_${col}_fkey"`);
    }
  }

  // ───────────────────────── operations ─────────────────────────
  private insertSync<T extends TableName>(t: T, row: TableRows[T]): TableRows[T] {
    const n = this.normalize(t, row as any);
    this.validate(t, n, null);
    this.rows(t).push(n as any);
    return structuredClone(n) as TableRows[T];
  }

  insert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]> {
    return this.exec(() => this.insertSync(t, row));
  }

  insertMany<T extends TableName>(t: T, rows: TableRows[T][]): Promise<void> {
    return this.exec(() => {
      const before = [...this.rows(t)];
      try {
        for (const r of rows) this.insertSync(t, r);
      } catch (e) {
        this.tables.set(t, before); // all-or-nothing
        throw e;
      }
    });
  }

  get<T extends TableName>(t: T, id: string): Promise<TableRows[T] | null> {
    return this.exec(() => {
      const r = this.rows(t).find((x: any) => x.id === id);
      return r ? structuredClone(r) : null;
    });
  }

  list<T extends TableName>(t: T, where: Where<TableRows[T]> = {}): Promise<TableRows[T][]> {
    return this.exec(() => this.rows(t).filter((r) => rowMatches(r, where as any)).map((r) => structuredClone(r)));
  }

  count<T extends TableName>(t: T, where: Where<TableRows[T]> = {}): Promise<number> {
    return this.exec(() => this.rows(t).filter((r) => rowMatches(r, where as any)).length);
  }

  private updateSync<T extends TableName>(t: T, id: string, patch: Partial<TableRows[T]>): TableRows[T] {
    const idx = this.rows(t).findIndex((x: any) => x.id === id);
    if (idx < 0) throw new Error(`not found: ${t}.${id}`);
    const cur: any = this.rows(t)[idx];
    const spec = TABLE_SPECS[t];
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!(k in spec.cols)) throw new Error(`unknown column ${t}.${k}`);
      if (k === 'id') continue;
      const nv = v === undefined ? null : structuredClone(v);
      next[k] = spec.cols[k].kind === 'ts' && typeof nv === 'string' && !Number.isNaN(Date.parse(nv)) ? new Date(nv).toISOString() : nv;
    }
    this.validate(t, next, id);
    this.rows(t)[idx] = next;
    return structuredClone(next);
  }

  update<T extends TableName>(t: T, id: string, patch: Partial<TableRows[T]>): Promise<TableRows[T]> {
    return this.exec(() => this.updateSync(t, id, patch));
  }

  upsert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]> {
    return this.exec(() => (this.rows(t).some((x: any) => x.id === (row as any).id) ? this.updateSync(t, (row as any).id, row) : this.insertSync(t, row)));
  }

  compareAndSet<T extends TableName>(t: T, id: string, expected: Partial<TableRows[T]>, patch: Partial<TableRows[T]>): Promise<TableRows[T] | null> {
    return this.exec(() => {
      const cur: any = this.rows(t).find((x: any) => x.id === id);
      if (!cur) return null;
      if (!rowMatches(cur, expected as any)) return null;
      return this.updateSync(t, id, patch);
    });
  }

  deleteWhere<T extends TableName>(t: T, where: Where<TableRows[T]>): Promise<number> {
    return this.exec(() => {
      const doomed = this.rows(t).filter((r) => rowMatches(r, where as any));
      const doomedIds = new Set(doomed.map((r: any) => r.id));
      for (const [other, spec] of Object.entries(TABLE_SPECS) as [TableName, (typeof TABLE_SPECS)[TableName]][]) {
        for (const [col, ref] of Object.entries(spec.fks ?? {})) {
          if (ref !== t) continue;
          const blocked = this.rows(other).find((r: any) => r[col] !== null && doomedIds.has(r[col]) && !(other === t && doomedIds.has(r.id)));
          if (blocked) throw new ConstraintError('foreign_key', t, `${other}_${col}_fkey`, `update or delete on table "${t}" violates foreign key constraint "${other}_${col}_fkey" on table "${other}"`);
        }
      }
      this.tables.set(t, this.rows(t).filter((r: any) => !doomedIds.has(r.id)));
      return doomed.length;
    });
  }

  transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R> {
    if (this.inTx) return fn(this); // nested: join the outer transaction
    return this.mu.run(async () => {
      const tx = new MemoryStore(true, structuredClone(this.tables));
      const result = await fn(tx); // throws → the copy is discarded (rollback)
      this.tables = tx.tables; // commit
      return result;
    });
  }
}
