import { z } from 'zod';

/**
 * Runtime shape checks for PayPal SUCCESS responses. TypeScript types do not validate network
 * data, so a 2xx body that is missing an id/status/amount must be rejected as MALFORMED_RESPONSE
 * instead of crashing later (or, worse, being treated as proof of a financial operation).
 */
const money = z.object({ currency_code: z.string().min(3).max(3), value: z.string().regex(/^\d{1,9}\.\d{2}$/) });
const id = z.string().min(1).max(128);

export const CaptureShape = z.object({
  id,
  status: z.string().min(1),
  amount: money,
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});

export const OrderShape = z.object({
  id,
  status: z.string().min(1),
  purchase_units: z
    .array(
      z.object({
        amount: money.optional(),
        payee: z.object({ merchant_id: z.string().optional() }).passthrough().optional(),
        payments: z
          .object({
            captures: z.array(CaptureShape).optional(),
            authorizations: z.array(z.object({ id, status: z.string().min(1), amount: money })).optional(),
          })
          .passthrough()
          .optional(),
      }).passthrough(),
    )
    .optional(),
});

export const RefundShape = z.object({ id, status: z.string().min(1), amount: money.optional() });

/** Order-capture responses nest the capture; capture/authorization-capture responses are the capture itself. */
export function parseCapture(j: unknown): z.infer<typeof CaptureShape> {
  const nested = (j as any)?.purchase_units?.[0]?.payments?.captures?.[0];
  return CaptureShape.parse(nested ?? j);
}

export class MalformedResponseError extends Error {
  constructor(readonly detail: string) {
    super(`PayPal returned a success status with an unusable body (${detail})`);
    this.name = 'MalformedResponseError';
  }
}

export function validated<T>(schema: z.ZodType<T>, j: unknown): T {
  const r = schema.safeParse(j);
  if (!r.success) throw new MalformedResponseError(r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
