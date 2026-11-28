import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

/**
 * Per-request (and per-publish-run) correlation context. The logger stamps every line with these
 * ids automatically, and outbound calls to the supervisor/runner forward them as headers so one
 * user action can be followed across control-plane, supervisor and runner logs.
 */
export interface RequestContext {
  requestId?: string;
  runId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const RUN_ID_HEADER = 'X-Halley-Run-Id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Honour a well-formed incoming X-Request-Id; otherwise mint a fresh one. */
export function resolveRequestId(incoming: string | null | undefined): string {
  if (incoming && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return crypto.randomUUID();
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Headers to forward on calls to the workspaces supervisor / runner. */
export function correlationHeaders(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const h: Record<string, string> = {};
  if (ctx.requestId) h[REQUEST_ID_HEADER] = ctx.requestId;
  if (ctx.runId) h[RUN_ID_HEADER] = ctx.runId;
  return h;
}
