/** Browser-side helpers shared by every screen: the API client, formatting, class names. */
export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly reference?: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get unauthenticated() {
    return this.status === 401;
  }
  /** True when the failure is a dependency problem (PayPal / OpenAI / database) rather than a bad request. */
  get dependency() {
    return this.status === 503 || this.status >= 500;
  }
}

export const AUTH_EVENT = 'pt:unauthenticated';

export async function api<T>(path: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('The server could not be reached. Check your connection and try again.', 0, 'NETWORK');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; reference?: string; issues?: { path: string; message: string }[] };
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_EVENT));
    throw new ApiError(data.error ?? `Request failed (HTTP ${res.status})`, res.status, data.code ?? `HTTP_${res.status}`, data.reference, data.issues);
  }
  return data as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour12: false });
};
export const fmtMoney = (n: number) => `$${n.toLocaleString('en-US')}`;
export const pct = (ratio: number | null | undefined) => (ratio == null ? '—' : `${Math.round(ratio * 100)}%`);
export const words = (s: string) => s.replace(/_/g, ' ').toLowerCase();

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** localStorage that never throws (private mode, blocked storage, SSR). */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the UI keeps working without persistence */
    }
  },
  remove(key: string): void {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
