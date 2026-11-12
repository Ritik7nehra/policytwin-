import { z } from 'zod';
import { CURRENCIES } from '../money';

/**
 * Every API input is validated at runtime (TypeScript types do not validate network data).
 * Limits: bounded string lengths, bounded arrays, allowlisted products/currencies, bounded body size (see http.ts).
 */
export const LIMITS = {
  body: 64 * 1024, // default max request body (bytes)
  webhookBody: 256 * 1024,
  name: 120,
  reason: 1000,
  policyText: 4000,
  note: 1000,
  actor: 80,
  products: 12,
  markets: 12,
} as const;

const ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be an id (letters, digits, "_" or "-")');

export const PRODUCT_PREFIX_ALLOWLIST = ['Orders API v2', 'Payments API v2', 'Authorizations API', 'Refunds', 'Webhooks', 'Disputes'] as const;
const product = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((s) => PRODUCT_PREFIX_ALLOWLIST.some((p) => s.toLowerCase().startsWith(p.toLowerCase())), `must start with one of: ${PRODUCT_PREFIX_ALLOWLIST.join(', ')}`);

const market = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9 .,/&()-]+$/, 'contains unsupported characters')
  .refine((s) => (s.match(/\b[A-Z]{3}\b/g) ?? []).every((c) => (CURRENCIES as readonly string[]).includes(c)), `currencies must be one of: ${CURRENCIES.join(', ')}`);

const text = (max: number, min = 0) => z.string().trim().min(min).max(max);
// An actor string from a client is accepted (older clients send one) but NEVER trusted — see security/guard.ts.
const ignoredActor = z.string().max(LIMITS.actor).optional();

export const PolicyIntakeSchema = z
  .object({
    name: text(LIMITS.name, 1),
    business_reason: text(LIMITS.reason).default(''),
    current_policy: text(LIMITS.policyText, 1),
    proposed_policy: text(LIMITS.policyText, 1),
    affected_products: z.array(product).max(LIMITS.products).default([]),
    target_markets: z.array(market).max(LIMITS.markets).default([]),
    expected_outcome: text(LIMITS.reason).default(''),
    created_by: ignoredActor,
  })
  .strip();
export type PolicyIntakeInput = z.infer<typeof PolicyIntakeSchema>;

export const VersionCreateSchema = z.object({ source_text: text(LIMITS.policyText, 1), label: z.enum(['A', 'B', 'C']).optional() }).strip();

export const RunCreateSchema = z
  .object({
    policy_id: ID,
    version_a_id: ID,
    version_b_id: ID,
    adversarial: z.boolean().optional(),
    run_all: z.boolean().optional(),
  })
  .strip();

export const RepairApprovalSchema = z.object({ note: text(LIMITS.note).default(''), actor: ignoredActor }).strip();

export const HumanDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: text(LIMITS.note).optional(),
    actor: ignoredActor,
  })
  .strip();

export const SandboxProofSchema = z.object({ pair_id: z.string().regex(/^pair_\d{2,3}$/, 'must look like "pair_03"') }).strip();

export const LoginSchema = z.object({ passcode: z.string().min(1).max(200) }).strip();

/** Minimal PayPal webhook envelope; extra fields pass through (they are normalised before storage). */
export const WebhookEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(128),
    event_type: z.string().min(1).max(128).regex(/^[A-Z0-9_.]+$/, 'unexpected event_type'),
    create_time: z.string().max(64).default(''),
    resource_type: z.string().max(64).optional(),
    resource: z
      .object({
        id: z.string().min(1).max(128),
        status: z.string().max(64).optional(),
        update_time: z.string().max(64).optional(),
        links: z.array(z.object({ rel: z.string().max(32), href: z.string().max(512) })).max(20).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const IdParam = ID;
