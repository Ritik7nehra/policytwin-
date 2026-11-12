'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { safeStorage } from './client';

/** State mirrored to localStorage. Starts at `initial` on the server and first client render (no hydration mismatch), then hydrates. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const raw = safeStorage.get(key);
    if (raw !== null) {
      try {
        setValue(JSON.parse(raw) as T);
      } catch {
        /* corrupted draft: ignore */
      }
    }
    setReady(true);
  }, [key]);
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        safeStorage.set(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );
  return [value, set, ready];
}

export function useMediaQuery(query: string, initial = false): boolean {
  const [match, setMatch] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/** Counts up to `target` once when it first becomes available (instant under reduced motion). */
export function useCountUp(target: number | null | undefined, ms = 700): number {
  const reduce = usePrefersReducedMotion();
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (target == null) return;
    if (reduce || target === 0) {
      setV(target);
      return;
    }
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms, reduce]);
  return target == null ? 0 : v;
}

/** Runs `fn` on mount and whenever `deps` change; exposes loading / error / reload. */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    fn(ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

/** Global key handler that ignores keystrokes aimed at form fields. */
export function useHotkey(match: (e: KeyboardEvent) => boolean, handler: (e: KeyboardEvent) => void, enabled = true) {
  const h = useRef(handler);
  h.current = handler;
  const m = useRef(match);
  m.current = match;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing && !(e.metaKey || e.ctrlKey)) return;
      if (m.current(e)) h.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}
