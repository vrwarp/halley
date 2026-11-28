/**
 * Minimal structured logger: one JSON object per line on stdout (info/debug) or stderr (warn/error).
 * Fields: ts, level, msg, sessionId (from HALLEY_SESSION_ID when set), err (serialized), plus extras.
 *
 * Use `ignore(err, reason)` instead of an empty catch block whenever an error is deliberately not
 * propagated, so the swallow is still visible in logs. High-frequency, expected failures use
 * `ignoreExpected` (debug level); `ignoreCodes` downgrades only the listed errno codes and keeps
 * anything unexpected at warn level.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Correlation ids of the request being served (from X-Request-Id / X-Halley-Run-Id). */
export interface RequestContext {
  requestId?: string;
  runId?: string;
}
export const REQUEST_ID_HEADER = 'X-Request-Id';
export const RUN_ID_HEADER = 'X-Halley-Run-Id';
const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `ctx` attached to every log line written during it (including async continuations). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStore.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/** Headers that forward the current correlation ids to a downstream service. */
export function correlationHeaders(): Record<string, string> {
  const ctx = requestContextStore.getStore();
  const h: Record<string, string> = {};
  if (ctx?.requestId) h[REQUEST_ID_HEADER] = ctx.requestId;
  if (ctx?.runId) h[RUN_ID_HEADER] = ctx.runId;
  return h;
}

/** Hono middleware: binds X-Request-Id / X-Halley-Run-Id of the incoming request to the log context. */
export function requestContextMiddleware() {
  return async (
    c: { req: { header: (name: string) => string | undefined } },
    next: () => Promise<void>,
  ): Promise<void> => {
    const requestId = c.req.header(REQUEST_ID_HEADER)?.slice(0, 200) || undefined;
    const runId = c.req.header(RUN_ID_HEADER)?.slice(0, 200) || undefined;
    if (!requestId && !runId) return next();
    return runWithRequestContext({ requestId, runId }, next);
  };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const raw = (process.env.HALLEY_LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LEVEL_ORDER[raw] ?? LEVEL_ORDER.info;
}

export function serializeError(err: unknown): Record<string, unknown> | string | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; signal?: unknown; stderr?: unknown };
    const out: Record<string, unknown> = { name: e.name, message: e.message };
    if (e.code !== undefined) out.code = e.code;
    if (e.signal) out.signal = e.signal;
    if (typeof e.stderr === 'string' && e.stderr) out.stderr = e.stderr.slice(0, 2000);
    if (e.stack) out.stack = e.stack.split('\n').slice(0, 6).join('\n');
    if (e.cause !== undefined) out.cause = serializeError(e.cause);
    return out;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch (stringifyErr) {
    // circular / BigInt payloads: keep the raw value AND why it could not be serialized
    // (this is the logger itself, so the failure is reported inline instead of via another log call)
    const why = stringifyErr instanceof Error ? stringifyErr.message : 'unknown';
    return `${String(err)} [unserializable: ${why}]`;
  }
}

export function log(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown> & { err?: unknown },
): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const { err, ...rest } = fields ?? {};
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  const sessionId = process.env.HALLEY_SESSION_ID;
  if (sessionId) record.sessionId = sessionId;
  const ctx = requestContextStore.getStore();
  if (ctx?.requestId) record.requestId = ctx.requestId;
  if (ctx?.runId) record.runId = ctx.runId;
  Object.assign(record, rest);
  if (err !== undefined) record.err = serializeError(err);
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg, sessionId, err: 'unserializable log fields' });
  }
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(`${line}\n`);
  } catch (writeErr) {
    // stdout/stderr closed: there is no sink left to report to; count it so tests/diagnostics can see it
    droppedLogWrites++;
    lastDropError = writeErr;
  }
}

let droppedLogWrites = 0;
let lastDropError: unknown;
/** Number of log lines that could not be written because stdout/stderr was closed. */
export function getDroppedLogWrites(): { count: number; lastError: unknown } {
  return { count: droppedLogWrites, lastError: lastDropError };
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};

/** Deliberately swallow `err`, but leave a structured trace explaining why. Always returns undefined. */
export function ignore(err: unknown, reason: string, fields?: Record<string, unknown>): undefined {
  log('warn', `ignored error: ${reason}`, { ...fields, err });
  return undefined;
}

/** Like `ignore`, but at debug level: for expected, high-frequency failures (probes, best-effort cleanup). */
export function ignoreExpected(err: unknown, reason: string, fields?: Record<string, unknown>): undefined {
  log('debug', `ignored expected error: ${reason}`, { ...fields, err });
  return undefined;
}

/** Errno-style `code` of an error, if any. */
export function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Swallows `err` when its errno code is one of `codes` (logged at debug); any other error is
 * logged at warn level (still swallowed). Use for "file may not exist" / "process already gone".
 */
export function ignoreCodes(
  err: unknown,
  codes: readonly string[],
  reason: string,
  fields?: Record<string, unknown>,
): undefined {
  const code = errCode(err);
  if (code && codes.includes(code)) return ignoreExpected(err, reason, fields);
  return ignore(err, reason, fields);
}

/**
 * Swallows `err` when it is expected (debug level) and logs anything else at warn level. `expected`
 * is a list of errno codes or a predicate. Always returns undefined.
 */
export function ignoreUnless(
  err: unknown,
  expected: readonly string[] | ((err: unknown) => boolean),
  reason: string,
  fields?: Record<string, unknown>,
): undefined {
  const isExpected = typeof expected === 'function' ? expected(err) : expected.includes(errCode(err) ?? '');
  return isExpected ? ignoreExpected(err, reason, fields) : ignore(err, reason, fields);
}

export interface OrDefaultOptions {
  /** Errno codes (or a predicate) that are expected: logged at debug instead of warn. */
  expected?: readonly string[] | ((err: unknown) => boolean);
  /**
   * Expected errors are not logged at all (for per-file hot loops where even a debug record per
   * miss would be noise). Unexpected errors are still logged at warn.
   */
  silentExpected?: boolean;
  fields?: Record<string, unknown>;
}

/**
 * Resolves `promise`, or `fallback` when it rejects, logging the rejection: unexpected errors at
 * warn, `opts.expected` ones at debug (or not at all with `silentExpected`). Use instead of
 * `.catch(() => fallback)` so every fallback leaves a trace explaining why it was taken.
 */
export function orDefault<T, F>(
  promise: Promise<T>,
  fallback: F,
  reason: string,
  opts?: OrDefaultOptions,
): Promise<T | F> {
  return promise.catch((err: unknown) => {
    const expected = opts?.expected;
    if (expected) {
      const isExpected = typeof expected === 'function' ? expected(err) : expected.includes(errCode(err) ?? '');
      if (isExpected) {
        if (!opts.silentExpected) ignoreExpected(err, reason, opts.fields);
        return fallback;
      }
    }
    ignore(err, reason, opts?.fields);
    return fallback;
  });
}

/** Errno codes meaning "the path is not there" (a missing file, or a parent that is a file). */
export const MISSING_PATH_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

/** True when `err` means the path does not exist. */
export function isMissingPathError(err: unknown): boolean {
  const code = errCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Reads a request's JSON body, treating an empty body as `{}` (many POST endpoints take optional
 * fields). A malformed non-empty body is logged at warn and also yields `{}` so the endpoint applies
 * its defaults, matching the previous behaviour, but the client error is now visible.
 */
export async function readJsonBodyOrEmpty<T = Record<string, unknown>>(
  c: { req: { text: () => Promise<string>; path?: string } },
): Promise<Partial<T>> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch (err) {
    ignore(err, 'http: read request body', { path: c.req.path });
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Partial<T>;
    logger.warn('http: JSON body is not an object; using defaults', { path: c.req.path });
    return {};
  } catch (err) {
    ignore(err, 'http: malformed JSON body; using defaults', { path: c.req.path, bytes: raw.length });
    return {};
  }
}
