import { TABLE_DEFS, TABLE_SPECS, buildSchemaStatements, type ColKind } from './tables';
import { mapPgError } from './errors';
import type { Store, TableName, TableRows, Where } from './types';

/** The subset of pg.Pool / pg.PoolClient we use (also satisfied by pg-mem's adapter in tests). */
export interface QueryResult {
  rows: any[];
  rowCount?: number | null;
}
export interface ClientLike {
  query(text: string, params?: unknown[]): Promise<QueryResult>;
  release?(err?: unknown): void;
}
export interface PoolLike extends ClientLike {
  connect?(): Promise<ClientLike>;
  end?(): Promise<void>;
}

const isRange = (v: unknown): v is { gte?: unknown; lt?: unknown } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k === 'gte' || k === 'lt');

const ser = (kind: ColKind, v: unknown): unknown => {
  if (v === undefined || v === null) return null;
  return kind === 'json' ? JSON.stringify(v) : v;
};
/** Drop the surrogate `seq` column and turn TIMESTAMPTZ values back into the ISO strings the app uses. */
const clean = (t: TableName, row: any) => {
  if (!row) return row;
  const { seq: _seq, ...rest } = row;
  for (const [c, k] of Object.entries(TABLE_DEFS[t])) {
    if (k === 'ts' && rest[c] instanceof Date) rest[c] = rest[c].toISOString();
  }
  return rest;
};

export class PgStore implements Store {
  readonly mode = 'postgres' as const;
  /** `q` is the pool for the root store, or the checked-out client for a transaction-scoped store. */
  constructor(
    private readonly pool: PoolLike,
    private readonly q: ClientLike = pool,
    private readonly inTx = false,
  ) {}

  async init(): Promise<void> {
    for (const stmt of buildSchemaStatements()) await this.pool.query(stmt);
    // v1 → v2 guard: CREATE TABLE IF NOT EXISTS does not add columns to an old database.
    try {
      await this.pool.query('SELECT owner_session FROM policies LIMIT 0');
      await this.pool.query('SELECT stage FROM test_runs LIMIT 0');
    } catch {
      throw new Error('The database was created by PolicyTwin v1 (older schema). Drop and recreate it (nothing in v1 was ever deployed), or run db/schema.sql on an empty database.');
    }
  }

  async ping(): Promise<void> {
    await this.q.query('SELECT 1');
  }

  private cols(t: TableName) {
    return Object.entries(TABLE_DEFS[t]);
  }

  private async run(t: TableName, sql: string, params: unknown[]): Promise<QueryResult> {
    try {
      return await this.q.query(sql, params);
    } catch (e) {
      throw mapPgError(e, t);
    }
  }

  async insert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]> {
    const cols = this.cols(t);
    const sql = `INSERT INTO ${t} (${cols.map(([c]) => c).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    const r = await this.run(t, sql, cols.map(([c, k]) => ser(k, (row as any)[c])));
    return clean(t, r.rows[0]);
  }

  async insertMany<T extends TableName>(t: T, rows: TableRows[T][]): Promise<void> {
    await this.transaction(async (tx) => {
      for (const r of rows) await tx.insert(t, r);
    });
  }

  async get<T extends TableName>(t: T, id: string): Promise<TableRows[T] | null> {
    const r = await this.run(t, `SELECT * FROM ${t} WHERE id = $1`, [id]);
    return r.rows[0] ? clean(t, r.rows[0]) : null;
  }

  private where(t: TableName, where: Where<any>, params: unknown[]): string[] {
    const defs = TABLE_DEFS[t];
    return Object.entries(where).map(([k, v]) => {
      if (!(k in defs)) throw new Error(`unknown column ${t}.${k}`);
      if (v === null || v === undefined) return `${k} IS NULL`;
      if (isRange(v)) {
        const parts: string[] = [];
        if (v.gte !== undefined) {
          params.push(ser(defs[k], v.gte));
          parts.push(`${k} >= $${params.length}`);
        }
        if (v.lt !== undefined) {
          params.push(ser(defs[k], v.lt));
          parts.push(`${k} < $${params.length}`);
        }
        return `(${parts.join(' AND ')})`;
      }
      params.push(ser(defs[k], v));
      return `${k} = $${params.length}`;
    });
  }

  async list<T extends TableName>(t: T, where: Where<TableRows[T]> = {}): Promise<TableRows[T][]> {
    const params: unknown[] = [];
    const conds = this.where(t, where, params);
    const r = await this.run(t, `SELECT * FROM ${t}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY seq`, params);
    return r.rows.map((x) => clean(t, x));
  }

  async count<T extends TableName>(t: T, where: Where<TableRows[T]> = {}): Promise<number> {
    const params: unknown[] = [];
    const conds = this.where(t, where, params);
    const r = await this.run(t, `SELECT COUNT(*) AS n FROM ${t}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`, params);
    return Number(r.rows[0]?.n ?? 0);
  }

  async update<T extends TableName>(t: T, id: string, patch: Partial<TableRows[T]>): Promise<TableRows[T]> {
    const defs = TABLE_DEFS[t];
    const entries = Object.entries(patch).filter(([k]) => k !== 'id');
    for (const [k] of entries) if (!(k in defs)) throw new Error(`unknown column ${t}.${k}`);
    if (entries.length === 0) {
      const cur = await this.get(t, id);
      if (!cur) throw new Error(`not found: ${t}.${id}`);
      return cur;
    }
    const sql = `UPDATE ${t} SET ${entries.map(([k], i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${entries.length + 1} RETURNING *`;
    const r = await this.run(t, sql, [...entries.map(([k, v]) => ser(defs[k], v)), id]);
    if (!r.rows[0]) throw new Error(`not found: ${t}.${id}`);
    return clean(t, r.rows[0]);
  }

  async upsert<T extends TableName>(t: T, row: TableRows[T]): Promise<TableRows[T]> {
    const existing = await this.get(t, (row as any).id);
    return existing ? this.update(t, (row as any).id, row) : this.insert(t, row);
  }

  async compareAndSet<T extends TableName>(t: T, id: string, expected: Partial<TableRows[T]>, patch: Partial<TableRows[T]>): Promise<TableRows[T] | null> {
    const defs = TABLE_DEFS[t];
    const sets = Object.entries(patch).filter(([k]) => k !== 'id');
    for (const [k] of sets) if (!(k in defs)) throw new Error(`unknown column ${t}.${k}`);
    if (sets.length === 0) return (await this.get(t, id)) as TableRows[T] | null;
    const params: unknown[] = sets.map(([k, v]) => ser(defs[k], v));
    const setSql = sets.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    params.push(id);
    const conds = [`id = $${params.length}`, ...this.where(t, expected as Where<any>, params)];
    // One conditional UPDATE: atomic in PostgreSQL, so exactly one concurrent caller can win.
    const r = await this.run(t, `UPDATE ${t} SET ${setSql} WHERE ${conds.join(' AND ')} RETURNING *`, params);
    return r.rows[0] ? clean(t, r.rows[0]) : null;
  }

  async deleteWhere<T extends TableName>(t: T, where: Where<TableRows[T]>): Promise<number> {
    const params: unknown[] = [];
    const conds = this.where(t, where, params);
    if (!conds.length) throw new Error('deleteWhere requires a condition');
    const r = await this.run(t, `DELETE FROM ${t} WHERE ${conds.join(' AND ')}`, params);
    return r.rowCount ?? 0;
  }

  async transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R> {
    if (this.inTx) return fn(this); // nested: join
    if (!this.pool.connect) {
      // A pool without checkout support cannot give us one session; refuse rather than pretend.
      throw new Error('PgStore.transaction requires a pool that supports connect()');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgStore(this.pool, client, true));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error matters more */
      }
      throw e;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

// Keep the spec import used (constraint metadata is part of the PgStore contract surface for tooling).
export const CONSTRAINED_TABLES = Object.keys(TABLE_SPECS);
