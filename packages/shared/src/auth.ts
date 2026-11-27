import crypto from 'node:crypto';

const HKDF_SALT = Buffer.from('halley-v2-auth-salt', 'utf8');

/**
 * Derives a deterministic internal host Bearer token from SESSION_SECRET so
 * control-plane <-> workspaces communication and /internal/git/repo.git
 * enforce mandatory authentication with zero extra .env configuration.
 */
export function deriveInternalHostToken(sessionSecret: string): string {
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(sessionSecret || 'halley-dev-insecure-secret', 'utf8'),
      HKDF_SALT,
      Buffer.from('halley-internal-host-v2', 'utf8'),
      32,
    ),
  );
  return key.toString('base64url');
}

/**
 * Derives a deterministic, stateless per-session workspace token from SESSION_SECRET,
 * sessionId, and tokenEpoch. Survives control-plane restarts without invalidating
 * in-flight workspace-runner LLM/screenshot/callback requests; revocable by bumping tokenEpoch.
 */
export function deriveWorkspaceToken(
  sessionSecret: string,
  sessionId: string,
  tokenEpoch = 0,
): string {
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(sessionSecret || 'halley-dev-insecure-secret', 'utf8'),
      HKDF_SALT,
      Buffer.from(`halley-workspace-token-v2:${sessionId}:${tokenEpoch}`, 'utf8'),
      32,
    ),
  );
  return key.toString('base64url');
}

export function hashWorkspaceToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time token comparison using SHA-256 digests so variable lengths never throw or leak.
 */
export function safeEqualToken(a: string, b: string): boolean {
  if (!a || !b) return false;
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

export function extractBearerToken(authHeader?: string | null): string {
  if (!authHeader) return '';
  const trimmed = authHeader.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, '').trim();
  }
  return '';
}
