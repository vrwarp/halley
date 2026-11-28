/**
 * Version of the supervisor <-> runner HTTP/WS protocol. Bump on any incompatible change to runner
 * endpoints or their payloads. The runner returns it from `/health` (`protocolVersion`) and in the
 * `X-Halley-Runner-Protocol` header of every response; the supervisor refuses to hand out a runner
 * that speaks a different version (e.g. a stale dist/index.js after a partial deploy).
 *
 * v2: WS messages carry `seq`/`epoch`; `/internal/git/fetch` + `/internal/git/push` (supervisor git
 *     ops under the runner's repo lock); `/health` reports boot progress and widened `busy`.
 */
export const RUNNER_PROTOCOL_VERSION = 2;
export const RUNNER_PROTOCOL_HEADER = 'X-Halley-Runner-Protocol';
