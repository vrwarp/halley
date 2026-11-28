import {
  PublishStateSchema,
  SessionStatusSchema,
  type PublishState,
  type SessionStatus,
} from '@halley/shared';

/** Publish steps during which a session must not be stopped, pruned, reset or re-published. */
export const IN_FLIGHT_PUBLISH_STATES: ReadonlySet<PublishState> = new Set<PublishState>([
  'verifying',
  'rebasing',
  'resolving_conflicts',
  'pushing_pr',
  'waiting_ci',
  'deploying_pages',
]);

/** `('verifying', 'rebasing', …)` for SQL `IN` clauses (values are fixed literals, not user input). */
export const IN_FLIGHT_PUBLISH_STATES_SQL = `(${[...IN_FLIGHT_PUBLISH_STATES].map((s) => `'${s}'`).join(', ')})`;

export function isPublishInFlight(state: string | null | undefined): boolean {
  return state !== null && state !== undefined && IN_FLIGHT_PUBLISH_STATES.has(state as PublishState);
}

export const SESSION_STATUS_SET: ReadonlySet<string> = new Set<string>(SessionStatusSchema.options);
export const PUBLISH_STATE_SET: ReadonlySet<string> = new Set<string>(PublishStateSchema.options);

const LIVE: SessionStatus[] = ['starting', 'running', 'sleeping', 'error'];

/**
 * For each target status, the statuses a session may move from via `db.setSessionStatus`.
 * `published` is terminal; `merged` only moves forward to `published` (or stays merged).
 * Un-freezing a merged session back to a live status requires an explicit
 * `transitionSession({ allowUnfreeze: true })`.
 */
export const ALLOWED_STATUS_SOURCES: Record<SessionStatus, SessionStatus[]> = {
  starting: LIVE,
  running: LIVE,
  sleeping: LIVE,
  error: LIVE,
  merged: [...LIVE, 'merged'],
  published: [...LIVE, 'merged', 'published'],
};
