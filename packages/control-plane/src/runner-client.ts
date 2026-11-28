import { z } from 'zod';
import { realClock, type Clock, type FetchFn } from './clock.js';
import { ignore } from './log.js';
import { correlationHeaders } from './request-context.js';

/** Resolved per call so a global fetch replaced after module load is still honoured. */
const globalFetch: FetchFn = (input, init) => fetch(input, init);

/**
 * `fetch` to a workspace runner that forwards the current X-Request-Id / X-Halley-Run-Id.
 * `fetchImpl` is the injected transport (ControlPlaneDeps.fetch); defaults to the global fetch.
 */
export function runnerFetch(url: string, init: RequestInit = {}, fetchImpl: FetchFn = globalFetch): Promise<Response> {
  const corr = correlationHeaders();
  const keys = Object.keys(corr);
  if (keys.length === 0) return fetchImpl(url, init);
  const headers = new Headers(init.headers);
  for (const k of keys) if (!headers.has(k)) headers.set(k, corr[k]!);
  return fetchImpl(url, { ...init, headers });
}

/**
 * Typed client for workspace-runner `/internal/*` endpoints used by the publish pipeline.
 * Every call checks the HTTP status and validates the response shape so a 409/502 error body
 * can never be mistaken for a successful result (fail closed).
 */
export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status: number | null,
    public readonly kind: 'http' | 'network' | 'timeout' | 'invalid_response',
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface CallRunnerOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  /** Injected transport (default: global fetch). */
  fetch?: FetchFn;
  /** Injected time source for the request deadline (default: realClock). */
  clock?: Clock;
}

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown };
    if (typeof b.error === 'string' && b.error.trim()) return b.error;
    if (typeof b.message === 'string' && b.message.trim()) return b.message;
  }
  return null;
}

export async function callRunner<S extends z.ZodTypeAny>(
  runnerUrl: string,
  path: string,
  schema: S,
  opts: CallRunnerOptions,
): Promise<z.infer<S>> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  let res: Response;
  try {
    res = await (opts.fetch ?? globalFetch)(`${runnerUrl}${path}`, {
      method,
      headers: {
        ...correlationHeaders(),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: (opts.clock ?? realClock).timeoutSignal(opts.timeoutMs),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const detail = err instanceof Error ? err.message : String(err);
    throw new RunnerError(
      isTimeout ? `Workspace request ${path} timed out after ${opts.timeoutMs}ms` : `fetch failed: ${detail}`,
      path,
      null,
      isTimeout ? 'timeout' : 'network',
    );
  }
  const text = await res.text().catch((err) => {
    ignore(err, 'runner: reading response body failed', { path, status: res.status }, 'debug');
    return '';
  });
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Non-JSON body (e.g. a proxy error page): treated as "no body"; the schema check below
      // fails closed on a 2xx, and a non-2xx falls back to the status-based message.
      ignore(err, 'runner: response body is not JSON', { path, status: res.status }, 'debug');
      body = null;
    }
  }
  if (!res.ok) {
    const msg = extractErrorMessage(body) || `Workspace request ${path} failed (${res.status})`;
    throw new RunnerError(msg, path, res.status, 'http', body);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RunnerError(
      `Workspace returned an unexpected response for ${path}: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
      path,
      res.status,
      'invalid_response',
      body,
    );
  }
  return parsed.data;
}

// ---- response schemas (only the fields the control-plane reads; unknown keys pass through) ----

export const CheckpointResponseSchema = z.object({ checkpoint: z.unknown().optional() }).passthrough();

export const ExcludePathsResponseSchema = z
  .object({
    preExcludeSha: z.string().nullable().optional(),
    changedFilesCount: z.number().optional(),
  })
  .passthrough();

const SyncReviewSchema = z
  .object({
    status: z.enum(['clean', 'applied', 'ready_for_review', 'needs_choices']),
    alreadyUpToDate: z.boolean().optional(),
    newBaseSha: z.string().optional(),
    prevBaseSha: z.string().optional(),
    touchedUserFiles: z.array(z.string()).optional(),
  })
  .passthrough();

export const SyncStartResponseSchema = z
  .object({
    heldForUser: z.boolean().optional(),
    overlapCount: z.number().optional(),
    review: SyncReviewSchema.optional(),
  })
  .passthrough()
  .refine((d) => d.heldForUser === true || d.review !== undefined, {
    message: 'expected either heldForUser or a review result',
  });

export const FullSyncResponseSchema = z
  .object({
    review: z
      .object({
        status: z.string().optional(),
        newBaseSha: z.string().optional(),
        prevBaseSha: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const VerificationCheckResultSchema = z
  .object({
    name: z.string(),
    passed: z.boolean(),
  })
  .passthrough();

export const VerifyResponseSchema = z
  .object({
    allPassed: z.boolean(),
    results: z.array(VerificationCheckResultSchema),
    /** HEAD commit the checks ran against (newer runners); otherwise read via /internal/git/changes. */
    headSha: z.string().min(7).optional(),
  })
  .passthrough();

/** `/internal/git/changes`: newest-first first-parent checkpoints since base (checkpoints[0] = HEAD). */
export const GitChangesHeadSchema = z
  .object({
    headSha: z.string().min(7).optional(),
    checkpoints: z.array(z.object({ sha: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export const ProtectedDiffResponseSchema = z
  .object({
    clean: z.boolean(),
    protectedFiles: z.array(z.string()).default([]),
  })
  .passthrough();

export const AnyJsonSchema = z.unknown();

export interface RunnerClient {
  runnerFetch(url: string, init?: RequestInit): Promise<Response>;
  callRunner<S extends z.ZodTypeAny>(runnerUrl: string, path: string, schema: S, opts: CallRunnerOptions): Promise<z.infer<S>>;
}

/** Runner client bound to one transport and clock, so callers thread ControlPlaneDeps.fetch once. */
export function createRunnerClient(fetchImpl: FetchFn = globalFetch, clock: Clock = realClock): RunnerClient {
  return {
    runnerFetch: (url, init) => runnerFetch(url, init, fetchImpl),
    callRunner: (runnerUrl, path, schema, opts) => callRunner(runnerUrl, path, schema, { fetch: fetchImpl, clock, ...opts }),
  };
}
