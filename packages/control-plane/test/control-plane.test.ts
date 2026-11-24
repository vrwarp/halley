import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DockerWorkspaceDriver, hasEmptyWorkspaceToken } from '../src/drivers/docker-driver.js';
import { LocalWorkspaceDriver } from '../src/drivers/local-driver.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { createControlPlane } from '../src/index.js';
import { hashWorkspaceToken } from '../src/proxy/llm-proxy.js';
import { ScreenshotService } from '../src/screenshot-service.js';

function createMockDriver(tokens?: Map<string, string>): WorkspaceDriver & {
  setRawWorkspaceToken: (id: string, token: string) => void;
} {
  return {
    setRawWorkspaceToken: (id, token) => {
      tokens?.set(id, token);
    },
    ensureRunning: async () => ({
      runnerUrl: 'http://127.0.0.1:49999',
      astroUrl: 'http://127.0.0.1:49998',
      astroBase: '/thecrossing.website',
      baseSha: 'abc1234',
    }),
    stop: async () => {},
    destroy: async () => {},
    duplicateWorkspace: async () => {},
    pushSessionBranch: async () => {},
    fetchIntoSession: async () => {},
  };
}

describe('control-plane auth, allowlist, spend caps & session permissions', () => {
  it('enforces allowlist, daily USD spend cap + admin grant, teammate read-only guard, and /internal/screenshot auth/routing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-test-'));
    const capturedUrls: string[] = [];
    const tokens = new Map<string, string>();
    const fakeScreenshotService = new ScreenshotService({
      settleWaitMs: 0,
      launchBrowser: async () => {
        const emitter = new EventEmitter();
        let connected = true;
        return Object.assign(emitter, {
          isConnected: () => connected,
          newContext: async () => ({
            newPage: async () => ({
              goto: async (url: string) => {
                capturedUrls.push(url);
              },
              waitForTimeout: async () => {},
              screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            }),
            close: async () => {},
          }),
          close: async () => {
            connected = false;
            emitter.emit('disconnected');
          },
        }) as unknown as Browser;
      },
    });
    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        allowedDomains: ['thecrossing.website'],
        dailyCostCapUsd: 5,
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, createMockDriver(tokens), fakeScreenshotService);

      expect(cp.db.isEmailAllowed('admin@thecrossing.website')).toBe(true);
      expect(cp.db.isEmailAllowed('pastor@thecrossing.website')).toBe(true);
      expect(cp.db.isEmailAllowed('stranger@gmail.com')).toBe(false);

      // Sign in as editor1 via dev-login
      const login1 = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sarah@thecrossing.website', name: 'Sarah' }),
      });
      expect(login1.status).toBe(200);
      const cookie1 = login1.headers.get('set-cookie')!.split(';')[0]!;
      const { user: sarah } = (await login1.json()) as { user: { id: string } };

      // Spend tracking & cap
      cp.db.recordSpend(sarah.id, 5.1, 1000, 1000);
      expect(cp.db.getSpendStatus(sarah.id).capped).toBe(true);

      // Admin grants extra $10
      cp.db.grantExtraSpend(sarah.id, 10);
      expect(cp.db.getSpendStatus(sarah.id).capped).toBe(false);

      // Sarah creates a session
      const createRes = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ title: 'Update Easter Times' }),
      });
      expect(createRes.status).toBe(201);
      const { session } = (await createRes.json()) as { session: { id: string } };
      const wsToken = tokens.get(session.id)!;
      expect(wsToken).toBeTruthy();

      // /internal/screenshot rejects missing or invalid tokens
      const unauthShot = await cp.app.request('/internal/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: '/', viewport: 'desktop' }),
      });
      expect(unauthShot.status).toBe(401);

      // /internal/screenshot rejects path traversal escaping session prefix
      const traversalShot = await cp.app.request('/internal/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${wsToken}`,
        },
        body: JSON.stringify({ route: '/../../../etc/passwd', viewport: 'desktop' }),
      });
      expect(traversalShot.status).toBe(400);

      // /internal/screenshot streams PNG and deduplicates base prefix if included
      const validShot = await cp.app.request('/internal/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${wsToken}`,
        },
        body: JSON.stringify({ route: '/thecrossing.website/im-new', viewport: 'mobile' }),
      });
      expect(validShot.status).toBe(200);
      expect(validShot.headers.get('content-type')).toBe('image/png');
      expect(validShot.headers.get('x-screenshot-width')).toBe('390');
      const pngBytes = Buffer.from(await validShot.arrayBuffer());
      expect(pngBytes[0]).toBe(0x89);
      expect(capturedUrls).toEqual([
        `http://127.0.0.1:49998/p/${session.id}/thecrossing.website/im-new`,
      ]);

      // Teammate signs in
      const login2 = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'david@thecrossing.website', name: 'David' }),
      });
      const cookie2 = login2.headers.get('set-cookie')!.split(';')[0]!;

      // Teammate sees Sarah's session as read-only
      const viewRes = await cp.app.request(`/api/sessions/${session.id}`, {
        headers: { Cookie: cookie2 },
      });
      const viewData = (await viewRes.json()) as { session: { canEdit: boolean; isOwner: boolean } };
      expect(viewData.session.isOwner).toBe(false);
      expect(viewData.session.canEdit).toBe(false);

      // Teammate cannot publish Sarah's session
      const pubRes = await cp.app.request(`/api/sessions/${session.id}/publish`, {
        method: 'POST',
        headers: { Cookie: cookie2 },
      });
      expect(pubRes.status).toBe(403);

      // Teammate CAN duplicate Sarah's session into their own edit
      const dupRes = await cp.app.request(`/api/sessions/${session.id}/duplicate`, {
        method: 'POST',
        headers: { Cookie: cookie2 },
      });
      expect(dupRes.status).toBe(201);
      const dupData = (await dupRes.json()) as {
        session: { canEdit: boolean; isOwner: boolean; parentSessionId: string | null; kind: string };
      };
      expect(dupData.session.isOwner).toBe(true);
      expect(dupData.session.canEdit).toBe(true);
      expect(dupData.session.parentSessionId).toBe(session.id);
      expect(dupData.session.kind).toBe('edit');

      // Marking Sarah's session 'merged' freezes editing and duplicating it creates a 'continuation'
      cp.db.updateSession(session.id, { status: 'merged', merged_sha: 'deadbeef' });
      const mergedView = await cp.app.request(`/api/sessions/${session.id}`, {
        headers: { Cookie: cookie1 },
      });
      const mergedDto = (await mergedView.json()) as { session: { canEdit: boolean; status: string } };
      expect(mergedDto.session.status).toBe('merged');
      expect(mergedDto.session.canEdit).toBe(false);

      const mergedPubRes = await cp.app.request(`/api/sessions/${session.id}/publish`, {
        method: 'POST',
        headers: { Cookie: cookie1 },
      });
      expect(mergedPubRes.status).toBe(409);

      const contRes = await cp.app.request(`/api/sessions/${session.id}/duplicate`, {
        method: 'POST',
        headers: { Cookie: cookie1 },
      });
      expect(contRes.status).toBe(201);
      const contData = (await contRes.json()) as {
        session: { kind: string; title: string; parentSessionId: string | null };
      };
      expect(contData.session.kind).toBe('continuation');
      expect(contData.session.title).toContain('Continued:');
      expect(contData.session.parentSessionId).toBe(session.id);

      // Session archive upsert & GET /api/sessions/:id/archive
      cp.db.upsertSessionArchive({
        sessionId: session.id,
        transcriptJson: JSON.stringify({ entries: [{ id: '1', role: 'user', text: 'Update Easter' }] }),
        diffSummary: JSON.stringify([{ path: 'src/pages/index.astro', status: 'modified', additions: 2, deletions: 1 }]),
        mergedSha: 'deadbeef',
        prUrl: 'https://github.com/vrwarp/thecrossing.website/pull/99',
      });
      const archRes = await cp.app.request(`/api/sessions/${session.id}/archive`, {
        headers: { Cookie: cookie2 },
      });
      expect(archRes.status).toBe(200);
      const archData = (await archRes.json()) as { archive: { mergedSha: string; handoffSummary: string | null } };
      expect(archData.archive.mergedSha).toBe('deadbeef');
      expect(archData.archive.handoffSummary).toBeNull();
    } finally {
      await fakeScreenshotService.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('runs reaper rules: 7d node_modules prune, 420d published & draft expiry, skipping in-flight and merged drafts', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-reaper-test-'));
    try {
      const pruned: string[] = [];
      const destroyed: string[] = [];
      const driver: WorkspaceDriver = {
        ...createMockDriver(),
        pruneNodeModules: async (s) => {
          pruned.push(s.id);
        },
        destroy: async (s) => {
          destroyed.push(s.id);
        },
      };

      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        archiveRetentionDays: 420,
        nodeModulesPruneDays: 7,
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, driver);
      const user = cp.db.upsertUser({ email: 'editor@thecrossing.website', name: 'Editor', picture: null });

      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const mkSession = (id: string, patch: Record<string, unknown>) => {
        cp.db.createSession({
          id,
          title: id,
          slug: id,
          ownerUserId: user.id,
          repo: 'vrwarp/thecrossing.website',
          baseBranch: 'main',
          workingBranch: `halley/${id}`,
          volumeName: `halley-ws-${id}`,
          workspaceTokenHash: `hash-${id}`,
        });
        cp.db.updateSession(id, patch);
      };

      // 1. Sleeping draft 10 days old -> should prune node_modules, NOT destroy
      mkSession('draft-10d', {
        status: 'sleeping',
        last_active_at: new Date(now - 10 * DAY).toISOString(),
      });
      // 2. Abandoned draft 425 days old -> should destroy + mark volume_expired_at
      mkSession('draft-425d', {
        status: 'sleeping',
        last_active_at: new Date(now - 425 * DAY).toISOString(),
      });
      // 3. Published session 425 days old -> should destroy + mark volume_expired_at
      mkSession('pub-425d', {
        status: 'published',
        archived_at: new Date(now - 425 * DAY).toISOString(),
      });
      // 4. Merged session 425 days old -> prune node_modules, do NOT expire as abandoned draft
      mkSession('merged-425d', {
        status: 'merged',
        merged_at: new Date(now - 425 * DAY).toISOString(),
        last_active_at: new Date(now - 425 * DAY).toISOString(),
      });
      // 5. In-flight publish 425 days old -> do NOT prune or destroy
      mkSession('inflight-425d', {
        status: 'sleeping',
        publish_state: 'waiting_ci',
        last_active_at: new Date(now - 425 * DAY).toISOString(),
      });

      const { runReaperPass } = await import('../src/reaper.js');
      await runReaperPass(cfg, cp.db, driver, now);

      expect(pruned).toContain('draft-10d');
      expect(pruned).toContain('merged-425d');
      expect(pruned).not.toContain('inflight-425d');

      expect(destroyed).toContain('draft-425d');
      expect(destroyed).toContain('pub-425d');
      expect(destroyed).not.toContain('draft-10d');
      expect(destroyed).not.toContain('merged-425d');
      expect(destroyed).not.toContain('inflight-425d');

      expect(cp.db.getSession('draft-425d')?.volume_expired_at).toBeTruthy();
      expect(cp.db.getSession('pub-425d')?.volume_expired_at).toBeTruthy();
      expect(cp.db.getSession('draft-10d')?.node_modules_pruned_at).toBeTruthy();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('enforces LLM proxy model allowlist (F15), current Opus pricing (F17), revert permissions/in-flight lock, history, and expired transcript fallback', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-p1-p6-test-'));
    try {
      const { computeCostUsd, isModelAllowedForPurpose } = await import('../src/proxy/llm-proxy.js');
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        modelId: 'haiku-latest',
        conflictModelId: 'haiku-latest',
        escalationModelId: 'opus-latest',
        adminEmails: ['admin@thecrossing.website'],
        allowedDomains: ['thecrossing.website'],
        devLoginEnabled: true,
      };

      // F15: Opus blocked for normal chat, allowed for conflict-escalation
      expect(isModelAllowedForPurpose('claude-opus-4-6', 'chat', cfg)).toBe(false);
      expect(isModelAllowedForPurpose('claude-opus-4-6', 'conflict', cfg)).toBe(false);
      expect(isModelAllowedForPurpose('claude-opus-4-6', 'conflict-escalation', cfg)).toBe(true);
      expect(isModelAllowedForPurpose('claude-haiku-4-5-20251001', 'chat', cfg)).toBe(true);

      // F17: Current Opus 4.5 / 4.6 priced at $5 input / $25 output per MTok (not legacy $15/$75)
      const opusCost = computeCostUsd('claude-opus-4-6', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      expect(opusCost).toBeCloseTo(30, 5);

      const cp = createControlPlane(cfg, createMockDriver());

      const login1 = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sarah@thecrossing.website', name: 'Sarah' }),
      });
      const cookieSarah = login1.headers.get('set-cookie')!.split(';')[0]!;
      const { user: sarah } = (await login1.json()) as { user: { id: string } };

      const login2 = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'david@thecrossing.website', name: 'David' }),
      });
      const cookieDavid = login2.headers.get('set-cookie')!.split(';')[0]!;

      // Create & publish Sarah's session, then expire its volume (>420d) while keeping DB archive
      const pubSession = cp.db.createSession({
        id: 'pub-1',
        title: 'Easter Banner',
        slug: 'easter-banner',
        ownerUserId: sarah.id,
        repo: cfg.repo,
        baseBranch: 'main',
        workingBranch: 'halley/easter-1',
        volumeName: 'halley-ws-pub-1',
        workspaceTokenHash: 'tok-pub-1',
      });
      cp.db.updateSession(pubSession.id, {
        status: 'published',
        publish_state: 'published',
        merged_sha: '1111222233334444555566667777888899990000',
        merged_at: new Date().toISOString(),
        archived_at: null,
        volume_expired_at: new Date().toISOString(),
      });
      cp.db.upsertSessionArchive({
        sessionId: pubSession.id,
        transcriptJson: JSON.stringify({
          entries: [{ id: 'e1', kind: 'user', role: 'user', text: 'Update Easter banner' }],
          live: { busy: false, activeTools: [], queuedCount: 0 },
          usageUsd: 0.05,
        }),
        mergedSha: '1111222233334444555566667777888899990000',
      });

      // Expired volume still serves archived transcript without waking container
      const txRes = await cp.app.request(`/api/sessions/${pubSession.id}/transcript`, {
        headers: { Cookie: cookieDavid },
      });
      expect(txRes.status).toBe(200);
      const txData = (await txRes.json()) as { volumeExpired?: boolean; entries: Array<{ text: string }> };
      expect(txData.volumeExpired).toBe(true);
      expect(txData.entries[0]?.text).toBe('Update Easter banner');

      // Q1: Any editor (David) can undo Sarah's publication, but reason is required
      const noReason = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieDavid },
        body: JSON.stringify({ sessionId: pubSession.id, reason: '   ' }),
      });
      expect(noReason.status).toBe(400);

      const rev1 = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieDavid },
        body: JSON.stringify({ sessionId: pubSession.id, reason: 'Wrong date' }),
      });
      expect(rev1.status).toBe(201);
      const { session: revSession } = (await rev1.json()) as { session: { id: string; kind: string; revertsSha: string } };
      expect(revSession.kind).toBe('revert');
      expect(revSession.revertsSha).toBe('1111222233334444555566667777888899990000');

      // Idle revert draft must NOT block another editor from starting an undo
      const rev2 = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieSarah },
        body: JSON.stringify({ sessionId: pubSession.id, reason: 'Fixing date' }),
      });
      expect(rev2.status).toBe(201);

      // An actively IN-FLIGHT revert publish MUST lock and return 409
      cp.db.updateSession(revSession.id, { publish_state: 'waiting_ci' });
      const revBlocked = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieSarah },
        body: JSON.stringify({ sessionId: pubSession.id, reason: 'Duplicate while publishing' }),
      });
      expect(revBlocked.status).toBe(409);

      // Published History lists Sarah's publication
      const histRes = await cp.app.request('/api/history', {
        headers: { Cookie: cookieDavid },
      });
      expect(histRes.status).toBe(200);
      const histData = (await histRes.json()) as { entries: Array<{ sessionId?: string; canUndo: boolean }> };
      expect(histData.entries.some((e) => e.sessionId === pubSession.id && e.canUndo)).toBe(true);

      // Purpose-tagged spend tracking
      cp.db.recordSpend(sarah.id, 0.42, 5000, 1200, undefined, {
        sessionId: pubSession.id,
        purpose: 'conflict-escalation',
        model: 'claude-opus-4-6',
      });
      const byPurpose = cp.db.listTodaySpendByPurpose();
      expect(byPurpose.some((p) => p.purpose === 'conflict-escalation' && p.costUsd >= 0.42)).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('adopts a reserved warm standby workspace and exposes bootProgress on session creation & wake', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-warm-test-'));
    try {
      const warmId = '11111111-2222-3333-4444-555555555555';
      const warmProgress = {
        stage: 'claiming_warm' as const,
        message: 'Connecting to ready workspace…',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        warmHit: true,
      };
      let warmUsed = false;
      const driver: WorkspaceDriver = {
        ...createMockDriver(),
        reserveWarmWorkspace: () => {
          if (warmUsed) return null;
          warmUsed = true;
          return {
            id: warmId,
            volumeName: `halley-ws-${warmId}`,
            rawToken: 'warm-secret-token',
            adoptedWarming: false,
          };
        },
        getBootProgress: (sessionId) => (sessionId === warmId ? warmProgress : null),
      };

      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, driver);

      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@thecrossing.website', name: 'Admin' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

      // First session claims the warm standby container's ID & volume
      const create1 = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Instant Warm Edit' }),
      });
      expect(create1.status).toBe(201);
      const data1 = (await create1.json()) as {
        session: { id: string; bootProgress?: { stage: string; warmHit?: boolean } | null };
      };
      expect(data1.session.id).toBe(warmId);
      expect(data1.session.bootProgress?.stage).toBe('claiming_warm');
      expect(data1.session.bootProgress?.warmHit).toBe(true);
      expect(cp.db.getSession(warmId)?.volume_name).toBe(`halley-ws-${warmId}`);

      // Second session falls back cleanly to cold boot with a fresh UUID
      const create2 = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Cold Fallback Edit' }),
      });
      expect(create2.status).toBe(201);
      const data2 = (await create2.json()) as { session: { id: string } };
      expect(data2.session.id).not.toBe(warmId);

      // Waking a sleeping session immediately transitions it to 'starting'
      cp.db.updateSession(data2.session.id, { status: 'sleeping' });
      const wakeRes = await cp.app.request(`/api/sessions/${data2.session.id}/wake`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(wakeRes.status).toBe(200);
      const wakeData = (await wakeRes.json()) as { session: { status: string } };
      expect(wakeData.session.status).toBe('starting');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('detects empty WORKSPACE_TOKEN env and mints/persists a fresh token after control-plane restart', async () => {
    expect(hasEmptyWorkspaceToken(['HALLEY_SESSION_ID=1', 'WORKSPACE_TOKEN='])).toBe(true);
    expect(hasEmptyWorkspaceToken(['HALLEY_SESSION_ID=1', 'WORKSPACE_TOKEN=   '])).toBe(true);
    expect(hasEmptyWorkspaceToken(['HALLEY_SESSION_ID=1'])).toBe(true);
    expect(hasEmptyWorkspaceToken(['HALLEY_SESSION_ID=1', 'WORKSPACE_TOKEN=abc123'])).toBe(false);
    expect(hasEmptyWorkspaceToken(undefined)).toBe(false);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-token-test-'));
    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, createMockDriver());
      const user = cp.db.upsertUser({
        email: 'admin@thecrossing.website',
        name: 'Admin',
        picture: null,
        isAdmin: true,
      });
      const initialToken = 'initial-token-before-restart';
      const session = cp.db.createSession({
        id: '8c758298-cf3e-4fee-a4fc-a7f2731e6dae',
        title: 'Test6',
        slug: 'test6',
        ownerUserId: user.id,
        repo: cfg.targetRepo || 'vrwarp/thecrossing.website',
        baseBranch: 'main',
        workingBranch: 'halley/test6-8c7582',
        volumeName: 'halley-ws-8c758298-cf3e-4fee-a4fc-a7f2731e6dae',
        workspaceTokenHash: hashWorkspaceToken(initialToken),
      });

      // Fresh DockerWorkspaceDriver simulating a control-plane restart (empty in-memory sessionTokens)
      const dockerDriver = new DockerWorkspaceDriver(cfg, cp.db, {} as never);
      const rotated = dockerDriver.ensureSessionToken(session.id);
      expect(rotated.length).toBeGreaterThanOrEqual(32);
      expect(rotated).not.toBe(initialToken);
      expect(cp.db.getSessionByTokenHash(hashWorkspaceToken(rotated))?.id).toBe(session.id);
      expect(cp.db.getSessionByTokenHash(hashWorkspaceToken(initialToken))).toBeNull();
      // Subsequent call returns the cached token without rotating again
      expect(dockerDriver.ensureSessionToken(session.id)).toBe(rotated);

      // Fresh LocalWorkspaceDriver also rotates & persists cleanly
      const localDriver = new LocalWorkspaceDriver(cfg, cp.db, {} as never);
      const localRotated = localDriver.ensureSessionToken(session.id);
      expect(localRotated.length).toBeGreaterThanOrEqual(32);
      expect(cp.db.getSessionByTokenHash(hashWorkspaceToken(localRotated))?.id).toBe(session.id);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('computes claude-haiku-5-5 spend in alignment with pi-ai pricing', async () => {
    const { computeCostUsd } = await import('../src/proxy/llm-proxy.js');
    const cost = computeCostUsd('claude-haiku-5-5', {
      input_tokens: 54,
      output_tokens: 24423,
      cache_read_input_tokens: 1022962,
      cache_creation_input_tokens: 119789,
    });
    expect(cost).toBeCloseTo(0.037420145, 6);
  });
});
