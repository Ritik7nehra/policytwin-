import type { z } from 'zod';
import { getBreaker, withRetry, type Sleep } from '../resilience';

/**
 * LLM access. Six agent ROLES share one model. The model only ever PROPOSES structured
 * output; every output is validated against a zod schema and then by deterministic guards
 * (see roles.ts) before anything uses it.
 */
export interface LlmClient {
  readonly mode: 'deterministic' | 'openai';
  readonly model: string;
  structured<T>(a: { agent: string; system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T>;
}

/** No API key configured: agents use their deterministic fallbacks and this is never called. */
export class OfflineLlm implements LlmClient {
  readonly mode = 'deterministic' as const;
  readonly model = 'offline-deterministic';
  async structured<T>(): Promise<T> {
    throw new Error('OfflineLlm.structured should never be called');
  }
}

export interface OpenAiOptions {
  /** Per-request timeout. OpenAI: 18s. */
  timeoutMs?: number;
  attempts?: number;
  /** Base URL override (used by the local stub server in tests). */
  baseURL?: string;
  sleep?: Sleep;
  random?: () => number;
}

export class OpenAiLlm implements LlmClient {
  readonly mode = 'openai' as const;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: OpenAiOptions = {},
  ) {}

  async structured<T>(a: { agent: string; system: string; user: string; schema: z.ZodType<T>; schemaName: string }): Promise<T> {
    const { default: OpenAI } = await import('openai');
    const { zodResponseFormat } = await import('openai/helpers/zod');
    const timeout = this.opts.timeoutMs ?? 18_000;
    // The SDK's own retries are disabled: retries (network / 429 / 5xx only, exponential backoff + jitter) and the
    // circuit breaker are handled by withRetry so behaviour is identical for every dependency and testable.
    const client = new OpenAI({ apiKey: this.apiKey, timeout, maxRetries: 0, baseURL: this.opts.baseURL });
    return withRetry(
      async (_attempt, signal) => {
        const completion = await client.chat.completions.parse(
          {
            model: this.model,
            messages: [
              { role: 'system', content: a.system },
              { role: 'user', content: a.user },
            ],
            response_format: zodResponseFormat(a.schema as any, a.schemaName),
          },
          { signal },
        );
        const msg = completion.choices[0]?.message;
        if (!msg) throw new Error('OpenAI returned no message');
        if (msg.refusal) throw new Error(`OpenAI refused: ${msg.refusal}`);
        if (msg.parsed == null) throw new Error('OpenAI returned no parsed structured output');
        return msg.parsed as T;
      },
      { label: 'openai', timeoutMs: timeout, attempts: this.opts.attempts ?? 2, breaker: getBreaker('openai'), sleep: this.opts.sleep, random: this.opts.random },
    );
  }
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const key = env.OPENAI_API_KEY?.trim();
  return key ? new OpenAiLlm(key, env.OPENAI_MODEL?.trim() || 'gpt-4o') : new OfflineLlm();
}
