/** Shared error helpers: expected errors are checked explicitly, unexpected ones are warned. */

const PREFIX = '[halley-dev-edit]';

/** ENOENT / ENOTDIR: the path (or a parent) does not exist — an expected, recoverable condition. */
export function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Log an unexpected (but recoverable) error with the integration prefix. */
export function warnUnexpected(context: string, err: unknown): void {
  console.warn(`${PREFIX} ${context}:`, err instanceof Error ? err.message : err);
}

/** Missing paths are silently expected; anything else is logged as unexpected. */
export function ignoreMissingPath(context: string, err: unknown): void {
  if (!isMissingPathError(err)) warnUnexpected(context, err);
}
