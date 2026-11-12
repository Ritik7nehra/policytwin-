import { getContext } from './context';
import type { Ctx } from './pipeline';
import { assertAccess, guard, type GuardKind } from './security/guard';
import type { Session } from './security/session';
import { NotFoundError, UnauthenticatedError } from './errors';
import { parseId } from './http';
import type { PolicyRow, TestRunRow } from './store/types';

/** Authenticate (cookie), CSRF-check, rate-limit; resolve the shared context. */
export async function begin(req: Request, kind: GuardKind, allowAnonymous = false): Promise<{ ctx: Ctx; session: Session | null }> {
  const session = guard(req, { kind, allowAnonymous });
  return { ctx: await getContext(), session };
}

export async function runFor(ctx: Ctx, session: Session | null, rawId: string, mode: 'read' | 'write'): Promise<TestRunRow> {
  const run = await ctx.store.get('test_runs', parseId(rawId));
  // An anonymous caller learns nothing about which ids exist: everything that is not public answers 401.
  if (!run) throw session ? new NotFoundError('test run') : new UnauthenticatedError('Enter the demo passcode to continue');
  assertAccess(session, run.owner_session, mode);
  return run;
}

export async function policyFor(ctx: Ctx, session: Session | null, rawId: string, mode: 'read' | 'write'): Promise<PolicyRow> {
  const p = await ctx.store.get('policies', parseId(rawId));
  if (!p) throw session ? new NotFoundError('policy') : new UnauthenticatedError('Enter the demo passcode to continue');
  assertAccess(session, p.owner_session, mode);
  return p;
}
