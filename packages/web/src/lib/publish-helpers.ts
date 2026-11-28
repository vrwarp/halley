/**
 * Resolves the live website URL to link to after a successful publish.
 * - Returns `null` if `liveSiteUrl` is empty/unset (e.g. `HALLEY_LIVE_SITE_URL=none|off`).
 * - Deep-links to the changed page when exactly 1 unique page route was updated.
 * - Otherwise links to the site root (`<liveSiteUrl>/`).
 */
export function resolvePublishedSiteUrl(
  liveSiteUrl: string | null | undefined,
  changedRoutes: Array<string | null | undefined>,
): string | null {
  const base = (liveSiteUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;

  const uniqueRoutes = Array.from(
    new Set(
      changedRoutes
        .map((r) => (r || '').trim())
        .filter(Boolean)
        .map((r) => (r.startsWith('/') ? r : `/${r}`)),
    ),
  );

  if (uniqueRoutes.length === 1) {
    const route = uniqueRoutes[0]!;
    return route === '/' ? `${base}/` : `${base}${route}`;
  }
  return `${base}/`;
}

const TRANSIENT_ERROR_RE =
  /temporary hiccup|GitHub API .* failed \((429|5\d\d)\)|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|Lost connection to the workspace/i;

/**
 * Determines whether a publish failure was caused by a transient GitHub or network hiccup
 * (where retrying Publish directly is more appropriate than asking Halley to edit code).
 */
export function isTransientPublishError(
  retryable: boolean | undefined,
  errorMsg: string | null | undefined,
): boolean {
  if (retryable) return true;
  if (!errorMsg) return false;
  return TRANSIENT_ERROR_RE.test(errorMsg);
}
