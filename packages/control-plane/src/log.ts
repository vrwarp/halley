/**
 * Tiny structured JSON logger. One line per event so `docker logs` / log shippers can parse it.
 * Debug lines are only emitted when HALLEY_LOG_LEVEL=debug.
 */
import { getRequestContext } from './request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  sessionId?: string;
  runId?: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let cachedLevelRaw: string | undefined;
let cachedMinLevel = LEVEL_ORDER.info;
function minLevel(): number {
  // Re-resolve only when the env var changes (tests flip it); avoids parsing on every log line.
  const raw = process.env.HALLEY_LOG_LEVEL;
  if (raw !== cachedLevelRaw) {
    cachedLevelRaw = raw;
    cachedMinLevel = LEVEL_ORDER[(raw || '').toLowerCase() as LogLevel] ?? LEVEL_ORDER.info;
  }
  return cachedMinLevel;
}

export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= minLevel();
}

export function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err === undefined ? undefined : String(err);
}

export function log(level: LogLevel, msg: string, ctx: LogContext & { err?: unknown } = {}): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const { err, ...rest } = ctx;
  const rc = getRequestContext();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(rc?.requestId ? { requestId: rc.requestId } : {}),
    ...(rc?.runId ? { runId: rc.runId } : {}),
    ...rest,
    ...(err !== undefined ? { err: serializeError(err) } : {}),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, ctx?: LogContext & { err?: unknown }) => log('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext & { err?: unknown }) => log('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext & { err?: unknown }) => log('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext & { err?: unknown }) => log('error', msg, ctx),
};

/**
 * Explicitly swallow an error that is safe to ignore, but leave a trace. Use instead of an empty
 * catch block so failures in best-effort paths remain diagnosable.
 */
export function ignore(err: unknown, reason: string, ctx: LogContext = {}, level: 'debug' | 'warn' = 'warn'): void {
  log(level, reason, { ...ctx, err });
}

/**
 * Awaits `promise`, substituting `fallback` when it rejects. The rejection is logged via `ignore`
 * (use 'debug' for high-frequency expected failures) so the fallback never hides a real fault.
 */
export function orDefault<T, F>(
  promise: Promise<T>,
  fallback: F,
  reason: string,
  ctx: LogContext = {},
  level: 'debug' | 'warn' = 'warn',
): Promise<T | F> {
  return promise.then(undefined, (err: unknown) => {
    ignore(err, reason, ctx, level);
    return fallback;
  });
}
