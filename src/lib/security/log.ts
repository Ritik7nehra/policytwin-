import { sanitizeFinancialEvidence } from './sanitize';

type Level = 'debug' | 'info' | 'warn' | 'error';

const defaultSink = (line: string): void => {
  if (process.env.NODE_ENV === 'test' && process.env.POLICYTWIN_LOG !== '1') return; // keep test output quiet
  // eslint-disable-next-line no-console
  console.log(line);
};

/** Sink is replaceable so tests can assert on exactly what would have been logged. */
let sink: (line: string) => void = defaultSink;
export function setLogSink(fn: (line: string) => void): () => void {
  const prev = sink;
  sink = fn;
  return () => {
    sink = prev;
  };
}

/** Structured JSON log line. Meta always goes through sanitizeFinancialEvidence first. */
export function log(level: Level, msg: string, meta: Record<string, unknown> = {}): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg: sanitizeFinancialEvidence(msg), ...(sanitizeFinancialEvidence(meta) as object) }));
}
