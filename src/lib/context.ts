import { PgStore } from './store/pg';
import { MemoryStore } from './store/memory';
import { SimulatedPayPal } from './paypal/simulated';
import { PayPalSandboxAdapter } from './paypal/live';
import { llmFromEnv } from './agents/llm';
import { limitsFromEnv } from './security/guard';
import { ensurePublicExamples } from './examples';
import { startJobWorker } from './jobs/worker';
import { log } from './security/log';
import type { Ctx } from './pipeline';
import type { Store } from './store/types';
import type { PayPalAdapter } from './paypal/types';

export async function buildStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const url = env.DATABASE_URL?.trim();
  if (!url) return new MemoryStore();
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  const store = new PgStore(pool);
  await store.init();
  return store;
}

export function buildAdapter(env: NodeJS.ProcessEnv = process.env): PayPalAdapter {
  const id = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!id || !secret) return new SimulatedPayPal();
  const allowDirectCard = env.PAYPAL_ALLOW_DIRECT_CARD_SANDBOX === '1';
  return new PayPalSandboxAdapter({
    clientId: id,
    clientSecret: secret,
    baseUrl: env.PAYPAL_BASE_URL?.trim() || undefined,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    merchantId: env.PAYPAL_MERCHANT_ID?.trim() || undefined,
    // The Sandbox test card is only ever read when direct-card testing is explicitly opted into (see README: PCI SAQ D note).
    allowDirectCard,
    card:
      allowDirectCard && env.PAYPAL_SANDBOX_CARD_NUMBER?.trim()
        ? { number: env.PAYPAL_SANDBOX_CARD_NUMBER.trim(), expiry: env.PAYPAL_SANDBOX_CARD_EXPIRY?.trim() || '2029-12', name: env.PAYPAL_SANDBOX_CARD_NAME?.trim() || 'Test Buyer' }
        : undefined,
  });
}

export async function buildContext(env: NodeJS.ProcessEnv = process.env): Promise<Ctx> {
  const ctx: Ctx = { store: await buildStore(env), adapter: buildAdapter(env), llm: llmFromEnv(env), limits: limitsFromEnv(env) };
  if (env.NODE_ENV !== 'test') {
    await ensurePublicExamples(ctx).catch((e) => log('error', 'could not seed the public example', { error: e instanceof Error ? e.message : String(e) }));
    startJobWorker(ctx);
  }
  return ctx;
}

const g = globalThis as unknown as { __policytwin_ctx?: Promise<Ctx> };

/** Process-wide singleton (survives Next.js hot reloads in dev). */
export function getContext(): Promise<Ctx> {
  if (!g.__policytwin_ctx) {
    g.__policytwin_ctx = buildContext();
    g.__policytwin_ctx.catch(() => {
      g.__policytwin_ctx = undefined;
    });
  }
  return g.__policytwin_ctx;
}
