import { createHash, randomBytes } from 'node:crypto';

/** JSON.stringify with sorted keys so hashes are stable across runs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export const sha256 = (v: unknown): string =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : stableStringify(v))
    .digest('hex');

export const shortId = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;

export const nowIso = (): string => new Date().toISOString();

export const uniq = <T>(xs: T[]): T[] => Array.from(new Set(xs));
