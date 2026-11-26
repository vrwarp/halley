import crypto from 'node:crypto';
import type { UserDto } from '@halley/shared';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb } from '../db.js';

const COOKIE_NAME = 'halley_session';
const OAUTH_STATE_COOKIE = 'halley_oauth_state';

interface SessionPayload {
  userId: string;
  exp: number;
}

function signToken(payload: object, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken<T>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts as [string, string];
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T & { exp?: number };
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class AuthService {
  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
  ) {}

  private resolveUserFromRawToken(raw: string | undefined): UserDto | null {
    if (!raw) return null;
    const payload = verifyToken<SessionPayload>(raw, this.config.sessionSecret);
    if (!payload) return null;
    const user = this.db.getUserById(payload.userId);
    if (!user) return null;
    if (!this.db.isEmailAllowed(user.email)) return null;
    return user;
  }

  getUserFromContext(c: Context): UserDto | null {
    return this.resolveUserFromRawToken(getCookie(c, COOKIE_NAME));
  }

  getUserFromCookieHeader(cookieHeader?: string): UserDto | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === COOKIE_NAME) {
        const raw = part.slice(idx + 1).trim();
        try {
          return this.resolveUserFromRawToken(decodeURIComponent(raw));
        } catch {
          return this.resolveUserFromRawToken(raw);
        }
      }
    }
    return null;
  }

  issueSessionCookie(c: Context, userId: string): void {
    const token = signToken(
      { userId, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 } satisfies SessionPayload,
      this.config.sessionSecret,
    );
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: this.config.publicUrl.startsWith('https://'),
      maxAge: 14 * 24 * 60 * 60,
    });
  }

  clearSessionCookie(c: Context): void {
    deleteCookie(c, COOKIE_NAME, { path: '/' });
  }

  buildGoogleAuthUrl(c: Context): string {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const cookieVal = signToken(
      { state, codeVerifier, exp: Date.now() + 10 * 60_000 },
      this.config.sessionSecret,
    );
    setCookie(c, OAUTH_STATE_COOKIE, cookieVal, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });

    const params = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: `${this.config.publicUrl}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleGoogleCallback(
    c: Context,
    code: string,
    state: string,
  ): Promise<{ ok: true; user: UserDto } | { ok: false; reason: string; email?: string }> {
    const rawCookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    if (!rawCookie) return { ok: false, reason: 'Missing OAuth state cookie' };

    const saved = verifyToken<{ state: string; codeVerifier: string; exp: number }>(
      rawCookie,
      this.config.sessionSecret,
    );
    if (!saved || saved.state !== state) {
      return { ok: false, reason: 'Invalid OAuth state' };
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: `${this.config.publicUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
        code_verifier: saved.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) {
      return { ok: false, reason: 'Failed to exchange Google authorization code' };
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      return { ok: false, reason: 'No access token from Google' };
    }

    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!userRes.ok) {
      return { ok: false, reason: 'Failed to fetch Google profile' };
    }
    const profile = (await userRes.json()) as {
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!profile.email || !profile.email_verified) {
      return { ok: false, reason: 'Google email is not verified' };
    }
    if (!this.db.isEmailAllowed(profile.email)) {
      return { ok: false, reason: 'not_allowed', email: profile.email };
    }

    const user = this.db.upsertUser({
      email: profile.email,
      name: profile.name || profile.email.split('@')[0] || 'Editor',
      picture: profile.picture || null,
    });
    this.issueSessionCookie(c, user.id);
    return { ok: true, user };
  }

  requireAuth = async (c: Context, next: Next) => {
    const user = this.getUserFromContext(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  };

  requireAdmin = async (c: Context, next: Next) => {
    const user = this.getUserFromContext(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!user.isAdmin) return c.json({ error: 'Forbidden' }, 403);
    c.set('user', user);
    await next();
  };
}
