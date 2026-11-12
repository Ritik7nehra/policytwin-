import type { CaptureState } from '../types';
import type { PayPalAdapter } from './types';

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource_type?: string;
  resource: {
    id: string;
    status?: string;
    update_time?: string;
    links?: { rel: string; href: string }[];
    [k: string]: unknown;
  };
}

export const STATE_RANK: Record<CaptureState, number> = { PENDING: 0, COMPLETED: 1, PARTIALLY_REFUNDED: 2, REFUNDED: 3 };
export const rankOf = (s: string | null | undefined): number => (s && s in STATE_RANK ? STATE_RANK[s as CaptureState] : -1);

/**
 * Webhook lifecycle (persisted in webhook_events):
 *   RECEIVED → VERIFIED → PROCESSING → PROCESSED      (failures: FAILED_RETRYABLE / FAILED_PERMANENT)
 * RECEIVED is the transient state between arrival and signature verification — unverified events are NEVER persisted
 * (otherwise a forged event could pre-claim a real event id), so stored rows begin at VERIFIED.
 * A duplicate delivery is ignored ONLY when the stored event is PROCESSED.
 */
export type BeginResult =
  | 'new' //                 first sighting: now PROCESSING
  | 'retry' //               seen before but not PROCESSED (failed, or a crashed attempt): now PROCESSING again
  | 'duplicate_processed' // already PROCESSED → ignore
  | 'in_progress' //         another delivery is PROCESSING right now (lease valid)
  | 'failed_permanent'; //   gave up earlier

export interface FailInfo {
  retryable: boolean;
  error: string;
}

/** Persistence the processor needs. Backed by the Store in the app, by memory inside scenarios. */
export interface WebhookState {
  beginEvent(e: { event_id: string; event_type: string; resource_id: string | null; payload: unknown }): Promise<BeginResult>;
  completeEvent(eventId: string): Promise<void>;
  failEvent(eventId: string, f: FailInfo): Promise<{ status: 'FAILED_RETRYABLE' | 'FAILED_PERMANENT'; attempts: number }>;
  getResource(resourceId: string): Promise<{ status: CaptureState; as_of: string } | null>;
  setResource(resourceId: string, v: { status: CaptureState; as_of: string }): Promise<void>;
}

export class InMemoryWebhookState implements WebhookState {
  private events = new Map<string, { status: 'PROCESSING' | 'PROCESSED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT'; attempts: number }>();
  private resources = new Map<string, { status: CaptureState; as_of: string }>();
  async beginEvent(e: { event_id: string }): Promise<BeginResult> {
    const cur = this.events.get(e.event_id);
    if (!cur) {
      this.events.set(e.event_id, { status: 'PROCESSING', attempts: 1 });
      return 'new';
    }
    if (cur.status === 'PROCESSED') return 'duplicate_processed';
    if (cur.status === 'PROCESSING') return 'in_progress';
    if (cur.status === 'FAILED_PERMANENT') return 'failed_permanent';
    this.events.set(e.event_id, { status: 'PROCESSING', attempts: cur.attempts + 1 });
    return 'retry';
  }
  async completeEvent(id: string) {
    const cur = this.events.get(id);
    if (cur) this.events.set(id, { ...cur, status: 'PROCESSED' });
  }
  async failEvent(id: string, f: FailInfo) {
    const cur = this.events.get(id) ?? { status: 'PROCESSING' as const, attempts: 1 };
    const status = f.retryable && cur.attempts < MAX_WEBHOOK_ATTEMPTS ? ('FAILED_RETRYABLE' as const) : ('FAILED_PERMANENT' as const);
    this.events.set(id, { status, attempts: cur.attempts });
    return { status, attempts: cur.attempts };
  }
  async getResource(id: string) {
    return this.resources.get(id) ?? null;
  }
  async setResource(id: string, v: { status: CaptureState; as_of: string }) {
    this.resources.set(id, v);
  }
}

/**
 * canonical_dedupe — the spec's recommended flow: dedupe by event id, store once, fetch the
 *                    canonical PayPal resource, update local state only if it is newer.
 * naive_last_write_wins — how a handler behaves when the policy says nothing about duplicates:
 *                    trust the payload and overwrite local state every time.
 */
export type WebhookMode = 'canonical_dedupe' | 'naive_last_write_wins';

export type WebhookOutcome = 'PROCESSED' | 'DUPLICATE' | 'IN_PROGRESS' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';

export interface WebhookResult {
  event_id: string;
  /** Lifecycle outcome of THIS delivery. */
  outcome: WebhookOutcome;
  /** True when the delivery was not re-applied (already PROCESSED, or another delivery is processing it). */
  ignored_duplicate: boolean;
  applied: boolean;
  state_before: CaptureState | null;
  state_after: CaptureState | null;
  canonical_fetched: boolean;
  reason: string;
}

export const MAX_WEBHOOK_ATTEMPTS = 8;

/** Keep only what processing needs (and what is safe to store): ids, type, times, status and the derived capture id. */
export function normalizeEvent(e: WebhookEvent): WebhookEvent {
  const capture_id = captureIdFromEvent(e);
  return {
    id: e.id,
    event_type: e.event_type,
    create_time: e.create_time,
    resource_type: e.resource_type,
    resource: { id: e.resource.id, status: e.resource.status, update_time: e.resource.update_time, ...(capture_id ? { capture_id } : {}) },
  };
}

export function captureIdFromEvent(e: WebhookEvent): string | null {
  if (typeof e.resource.capture_id === 'string' && e.resource.capture_id) return e.resource.capture_id;
  if (e.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
    const up = e.resource.links?.find((l) => l.rel === 'up')?.href;
    return up ? (up.split('/').filter(Boolean).pop() ?? null) : null;
  }
  if (e.event_type.startsWith('PAYMENT.CAPTURE.')) return e.resource.id ?? null;
  return null;
}

/** State implied by the payload alone (what a naive handler would trust). */
export function impliedState(e: WebhookEvent): CaptureState | null {
  switch (e.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'COMPLETED';
    case 'PAYMENT.CAPTURE.REFUNDED':
      return 'REFUNDED';
    case 'PAYMENT.CAPTURE.PENDING':
      return 'PENDING';
    default:
      return null;
  }
}

const retryableStatus = (s: number) => s === 401 || s === 403 || s === 404 || s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

export async function processWebhookEvent(
  deps: { state: WebhookState; adapter: PayPalAdapter; mode: WebhookMode },
  event: WebhookEvent,
): Promise<WebhookResult> {
  const { state, adapter, mode } = deps;
  const captureId = captureIdFromEvent(event);
  const before = captureId ? ((await state.getResource(captureId))?.status ?? null) : null;
  const base = { event_id: event.id, outcome: 'PROCESSED' as WebhookOutcome, ignored_duplicate: false, applied: false, state_before: before, state_after: before, canonical_fetched: false };

  if (mode === 'naive_last_write_wins') {
    const s = impliedState(event);
    if (!captureId || !s) return { ...base, reason: 'event has no capture state to apply' };
    await state.setResource(captureId, { status: s, as_of: event.create_time });
    return { ...base, applied: true, state_after: s, reason: 'payload trusted; local state overwritten (no dedupe, no canonical fetch)' };
  }

  // canonical_dedupe: lifecycle-aware. A duplicate is ignored ONLY when the stored event is PROCESSED.
  const begin = await state.beginEvent({ event_id: event.id, event_type: event.event_type, resource_id: captureId, payload: event });
  if (begin === 'duplicate_processed') return { ...base, outcome: 'DUPLICATE', ignored_duplicate: true, reason: 'event id already PROCESSED; ignored' };
  if (begin === 'in_progress') return { ...base, outcome: 'IN_PROGRESS', ignored_duplicate: true, reason: 'another delivery of this event is being processed; if it fails the queue retries it' };
  if (begin === 'failed_permanent') return { ...base, outcome: 'FAILED_PERMANENT', ignored_duplicate: true, reason: 'event previously failed permanently; not re-applied' };

  const fail = async (retryable: boolean, error: string, canonical_fetched: boolean): Promise<WebhookResult> => {
    const f = await state.failEvent(event.id, { retryable, error });
    return { ...base, outcome: f.status, canonical_fetched, reason: `${error}; local state unchanged; ${f.status === 'FAILED_RETRYABLE' ? `will be retried (attempt ${f.attempts})` : 'giving up'}` };
  };

  try {
    if (!captureId) {
      await state.completeEvent(event.id);
      return { ...base, reason: 'event is not about a capture; stored only' };
    }
    const canonical = await adapter.getCapture(captureId);
    if (!canonical.ok) return await fail(retryableStatus(canonical.status), `canonical fetch failed (HTTP ${canonical.status})`, true);
    const next = canonical.data.status as CaptureState;
    const local = await state.getResource(captureId);
    const newer = !local || (canonical.data.update_time >= local.as_of && rankOf(next) >= rankOf(local.status));
    if (!newer) {
      await state.completeEvent(event.id);
      return { ...base, canonical_fetched: true, reason: 'canonical state is not newer than local state; unchanged' };
    }
    await state.setResource(captureId, { status: next, as_of: canonical.data.update_time });
    await state.completeEvent(event.id);
    return { ...base, applied: true, canonical_fetched: true, state_after: next, reason: 'applied canonical PayPal state' };
  } catch (e) {
    // Network / timeout / circuit-open while fetching the canonical resource → retryable, never "processed".
    return await fail(true, `canonical fetch error: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`, true);
  }
}
