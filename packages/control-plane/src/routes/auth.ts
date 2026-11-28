import { readJsonObject } from '../http-body.js';
import { ignore } from '../log.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the auth (session cookie, Google OAuth, dev login, preferences). */
export function register(app: App, ctx: ControlPlaneContext) {
  const { config, clock, runnerFetch, db, auth } = ctx;
  // Auth routes
  app.get('/api/auth/me', (c) => {
    const user = auth.getUserFromContext(c);
    if (!user) {
      return c.json({
        authenticated: false,
        devLoginEnabled: config.devLoginEnabled,
        googleEnabled: Boolean(config.googleClientId && config.googleClientSecret),
        repo: config.repo,
      });
    }
    return c.json({
      authenticated: true,
      user,
      spend: db.getSpendStatus(user.id),
      repo: config.repo,
      baseBranch: config.baseBranch,
    });
  });

  app.get('/api/auth/google', (c) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return c.text('Google OAuth is not configured', 500);
    }
    return c.redirect(auth.buildGoogleAuthUrl(c));
  });

  app.get('/api/auth/google/callback', async (c) => {
    const code = c.req.query('code') || '';
    const state = c.req.query('state') || '';
    const err = c.req.query('error');
    if (err || !code || !state) {
      return c.redirect('/?authError=cancelled');
    }
    const result = await auth.handleGoogleCallback(c, code, state);
    if (!result.ok) {
      if (result.reason === 'not_allowed') {
        return c.redirect(`/?authError=not_allowed&email=${encodeURIComponent(result.email || '')}`);
      }
      return c.redirect(`/?authError=${encodeURIComponent(result.reason)}`);
    }
    return c.redirect('/');
  });

  app.post('/api/auth/dev-login', async (c) => {
    if (!config.devLoginEnabled) {
      return c.json({ error: 'Dev login is disabled' }, 403);
    }
    const body = (await readJsonObject(c)) as {
      email?: string;
      name?: string;
    };
    const email = (body.email || config.adminEmails[0] || 'dev@example.com').toLowerCase();
    if (!db.isEmailAllowed(email)) {
      db.addAllowlist('email', email, 'dev-login');
    }
    const user = db.upsertUser({
      email,
      name: body.name || 'Dev Editor',
      picture: null,
    });
    auth.issueSessionCookie(c, user.id);
    return c.json({ user, spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/auth/logout', (c) => {
    auth.clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.patch('/api/auth/preferences', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json()) as { persona?: 'non-technical' | 'developer' };
    const persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    db.setUserPersona(user.id, persona);
    // Notify any running sessions owned by this user
    for (const s of db.listSessionsByOwner(user.id)) {
      if (s.status === 'running' && s.runner_url) {
        void runnerFetch(`${s.runner_url}/internal/persona`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona }),
          signal: clock.timeoutSignal(5000),
        }).catch((err) => ignore(err, 'notifying runner of persona change failed', { sessionId: s.id }, 'debug'));
      }
    }
    return c.json({ user: db.getUserById(user.id) });
  });
}
