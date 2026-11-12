'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AUTH_EVENT, api, errMsg } from '@/lib/client';
import type { HealthInfo, SessionInfo } from '@/lib/ui-types';
import type { RuntimeInfo } from '@/lib/types';

type Status = 'loading' | 'ready' | 'login' | 'unavailable';

interface Ctx {
  status: Status;
  session: SessionInfo | null;
  health: HealthInfo | null;
  runtime: RuntimeInfo | null;
  problem: string | null;
  /** True when a signed-in (or open-mode) session exists. */
  authed: boolean;
  login: (passcode: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);
export const useSession = (): Ctx => {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession must be used inside <SessionProvider>');
  return c;
};

/** Owns "who am I / what is configured": one place that knows about auth, runtime modes and server health. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api<SessionInfo>('/api/session'), api<HealthInfo>('/api/health').catch(() => null)]);
      if (!alive.current) return;
      setSession(s);
      setHealth(h);
      setProblem(null);
      setStatus(s.authenticated ? 'ready' : 'login');
    } catch (e) {
      if (!alive.current) return;
      setProblem(errMsg(e));
      setStatus('unavailable');
      const h = await api<HealthInfo>('/api/health').catch(() => null);
      if (alive.current) setHealth(h);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onAuth = () => void refresh(); // any 401 re-checks the session → the gate appears if it expired
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => {
      alive.current = false;
      window.removeEventListener(AUTH_EVENT, onAuth);
    };
  }, [refresh]);

  const login = useCallback(
    async (passcode: string) => {
      await api('/api/session', { json: { passcode } });
      await refresh();
    },
    [refresh],
  );
  const logout = useCallback(async () => {
    await api('/api/session', { method: 'DELETE' }).catch(() => undefined);
    await refresh();
  }, [refresh]);

  const value = useMemo<Ctx>(
    () => ({ status, session, health, runtime: health?.runtime ?? null, problem, authed: status === 'ready', login, logout, refresh }),
    [status, session, health, problem, login, logout, refresh],
  );
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
