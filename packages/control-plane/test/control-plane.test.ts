import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ControlPlaneDb } from '../src/db.js';
import {
  CrashLoopTracker,
  WorkspaceCrashLoopError,
  type WorkspaceDriver,
} from '../src/drivers/workspace-driver.js';
import { WorkspaceHostDriver } from '../src/drivers/workspace-host-driver.js';
import { GitHubService } from '../src/github/client.js';
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
              screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
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

      // /internal/screenshot streams JPEG and deduplicates base prefix if included
      const validShot = await cp.app.request('/internal/screenshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${wsToken}`,
        },
        body: JSON.stringify({ route: '/thecrossing.website/im-new', viewport: 'mobile' }),
      });
      expect(validShot.status).toBe(200);
      expect(validShot.headers.get('content-type')).toBe('image/jpeg');
      expect(validShot.headers.get('x-screenshot-width')).toBe('390');
      const jpegBytes = Buffer.from(await validShot.arrayBuffer());
      expect(jpegBytes[0]).toBe(0xff);
      expect(jpegBytes[1]).toBe(0xd8);
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

  it('rotates/persists session token, detects protocol version mismatch, and reconciles sessions after workspaces restart', async () => {
    const http = await import('node:http');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-host-test-'));
    let fakeProtocolVersion = 2;
    let fakeInstanceId = 'inst-1';
    let fakeActiveIds: string[] = [];
    const fakeServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            protocolVersion: fakeProtocolVersion,
            instanceId: fakeInstanceId,
            activeSessionIds: fakeActiveIds,
            activeCount: fakeActiveIds.length,
            maxActiveWorkspaces: 5,
            warmPool: { enabled: false, target: 0, ready: 0, warming: 0 },
            buildQueue: { activeSessionId: null, queueLength: 0, queuedSessionIds: [] },
            diskUsage: { totalBytes: 1000, freeBytes: 500, usedBytes: 500, usedPercent: 50 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = fakeServer.address() as { port: number };
    const fakeHostUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        workspaceHostUrl: fakeHostUrl,
        adminEmails: ['admin@thecrossing.website'],
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, createMockDriver());
      const user = cp.db.upsertUser({
        email: 'admin@thecrossing.website',
        name: 'Admin',
        picture: null,
      });
      const initialToken = 'initial-token-before-restart';
      const session = cp.db.createSession({
        id: '8c758298-cf3e-4fee-a4fc-a7f2731e6dae',
        title: 'Test6',
        slug: 'test6',
        ownerUserId: user.id,
        repo: cfg.repo || 'vrwarp/thecrossing.website',
        baseBranch: 'main',
        workingBranch: 'halley/test6-8c7582',
        volumeName: 'halley-ws-8c758298-cf3e-4fee-a4fc-a7f2731e6dae',
        workspaceTokenHash: hashWorkspaceToken(initialToken),
      });

      const hostDriver = new WorkspaceHostDriver(cfg, cp.db, {} as never);
      const rotated = hostDriver.ensureSessionToken(session.id);
      expect(rotated.length).toBeGreaterThanOrEqual(32);
      expect(rotated).not.toBe(initialToken);
      expect(cp.db.getSessionByTokenHash(hashWorkspaceToken(rotated))?.id).toBe(session.id);
      expect(cp.db.getSessionByTokenHash(hashWorkspaceToken(initialToken))).toBeNull();
      expect(hostDriver.ensureSessionToken(session.id)).toBe(rotated);

      // Reconcile after workspaces container restart: sessions marked 'running' or stale 'starting' in DB
      // but absent from supervisor flip to 'sleeping'
      cp.db.updateSession(session.id, {
        status: 'running',
        runner_url: 'http://workspaces:4101',
        astro_url: 'http://workspaces:4322',
      });
      fakeInstanceId = 'inst-2';
      fakeActiveIds = [];
      await hostDriver.reconcileSessions();
      const afterReconcile = cp.db.getSession(session.id)!;
      expect(afterReconcile.status).toBe('sleeping');
      expect(afterReconcile.runner_url).toBeNull();
      expect(afterReconcile.astro_url).toBeNull();

      cp.db.updateSession(session.id, { status: 'starting' });
      fakeInstanceId = 'inst-3';
      await hostDriver.reconcileSessions();
      expect(cp.db.getSession(session.id)!.status).toBe('sleeping');

      // Doctor reports clear error on protocol version mismatch
      fakeProtocolVersion = 99;
      const doc = await hostDriver.runDoctorChecks();
      expect(doc.ok).toBe(false);
      expect(doc.errors.some((e) => e.includes('update both halley-control-plane and halley-workspace'))).toBe(true);
    } finally {
      fakeServer.close();
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

  it('opens crash-loop circuit breaker after 3 failures, makes transcript non-waking, and supports /restart', async () => {
    const tracker = new CrashLoopTracker({
      threshold: 3,
      windowMs: 60_000,
      cooldownsMs: [10_000, 30_000],
    });
    const t0 = 1_000_000;
    tracker.recordFailure('s1', 'exit 137', { oom: true, now: t0 });
    tracker.assertCanAttempt('s1', t0 + 100);
    tracker.recordFailure('s1', 'exit 137', { oom: true, now: t0 + 1000 });
    tracker.assertCanAttempt('s1', t0 + 1100);
    const info = tracker.recordFailure('s1', 'OOMKilled', { oom: true, now: t0 + 2000 });
    expect(info.crashLoop).toBe(true);
    expect(info.oom).toBe(true);

    expect(() => tracker.assertCanAttempt('s1', t0 + 3000)).toThrow(WorkspaceCrashLoopError);
    tracker.reset('s1');
    expect(() => tracker.assertCanAttempt('s1', t0 + 3000)).not.toThrow();

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-breaker-test-'));
    try {
      let ensureCalls = 0;
      let restartCalls = 0;
      const driver: WorkspaceDriver = {
        ...createMockDriver(),
        ensureRunning: async () => {
          ensureCalls += 1;
          return {
            runnerUrl: 'http://127.0.0.1:49999',
            astroUrl: 'http://127.0.0.1:49998',
            astroBase: '/',
            baseSha: 'abc1234',
          };
        },
        restart: async () => {
          restartCalls += 1;
          return {
            runnerUrl: 'http://127.0.0.1:49999',
            astroUrl: 'http://127.0.0.1:49998',
            astroBase: '/',
            baseSha: 'abc1234',
          };
        },
      };
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        allowedDomains: ['thecrossing.website'],
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, driver);
      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sarah@thecrossing.website', name: 'Sarah' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const createRes = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Crash Test' }),
      });
      const { session } = (await createRes.json()) as { session: { id: string } };
      cp.db.updateSession(session.id, { status: 'error', runner_url: null });
      const before = ensureCalls;

      // Transcript endpoint must NOT wake a stopped/errored session
      const trRes = await cp.app.request(`/api/sessions/${session.id}/transcript`, {
        headers: { Cookie: cookie },
      });
      expect(trRes.status).toBe(503);
      expect(ensureCalls).toBe(before);

      // Teammate cannot restart Sarah's session
      const login2 = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'david@thecrossing.website', name: 'David' }),
      });
      const cookie2 = login2.headers.get('set-cookie')!.split(';')[0]!;
      const forbidRestart = await cp.app.request(`/api/sessions/${session.id}/restart`, {
        method: 'POST',
        headers: { Cookie: cookie2 },
      });
      expect(forbidRestart.status).toBe(403);

      // Owner can restart
      const okRestart = await cp.app.request(`/api/sessions/${session.id}/restart`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(okRestart.status).toBe(200);
      expect(restartCalls).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent mirror syncs via TTL/single-flight and falls back to stale mirror on transient error', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-mirror-test-'));
    try {
      const upstream = path.join(tmp, 'upstream');
      await fs.mkdir(upstream, { recursive: true });
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: upstream });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: upstream });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
      await fs.writeFile(path.join(upstream, 'README.md'), 'hello\n');
      await execFileAsync('git', ['add', '-A'], { cwd: upstream });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: upstream });

      const cfg = {
        ...loadConfig(),
        dataDir: path.join(tmp, 'data'),
        devLocalRepo: upstream,
        baseBranch: 'main',
      };
      const cp = createControlPlane(cfg, createMockDriver());
      const hostDriver = new WorkspaceHostDriver(cfg, cp.db, {} as never);

      // Concurrent calls share one in-flight fetch and populate the local bare mirror
      const [m1, m2] = await Promise.all([
        hostDriver.ensureControlPlaneMirror('main'),
        hostDriver.ensureControlPlaneMirror('main'),
      ]);
      expect(m1).toBe(m2);

      // Remove upstream repo to simulate a transient GitHub SSL/network outage;
      // force=true + allowStaleOnError=true must fall back cleanly to the existing local mirror
      await fs.rm(upstream, { recursive: true, force: true });
      const stale = await hostDriver.ensureControlPlaneMirror('main', {
        force: true,
        allowStaleOnError: true,
      });
      expect(stale).toBe(m1);

      // Without allowStaleOnError, force=true surfaces the error
      await expect(
        hostDriver.ensureControlPlaneMirror('main', { force: true, allowStaleOnError: false }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('pushes Undo + prior-chat digest to context-note and converts diverged revert drafts so History does not mark them wholly undone', async () => {
    const http = await import('node:http');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-undo-ctx-'));
    const capturedContextNotes: Array<{ note: string; persist?: boolean }> = [];
    const tokensBySession = new Map<string, string>();

    const mockRunner = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/internal/git/revert-start') {
          res.end(
            JSON.stringify({
              status: 'clean',
              revertCheckpointSha: 'ffd9078000000000000000000000000000000000',
              revertedCommits: [
                {
                  sha: '318648242c35b6c3e6bba74a94c35a844c2d95bb',
                  shortSha: '3186482',
                  author: 'Sarah',
                  date: '2026-11-25T17:13:06-08:00',
                  subject: 'test10',
                  body: '',
                  files: [
                    { path: 'src/pages/events/index.astro', status: 'modified', additions: 37, deletions: 1 },
                    { path: 'src/pages/im-new/index.astro', status: 'modified', additions: 10, deletions: 0 },
                  ],
                },
              ],
              conflictedFiles: [],
            }),
          );
          return;
        }
        if (req.url === '/internal/context-note') {
          capturedContextNotes.push(JSON.parse(body || '{}'));
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/internal/git/revert-file') {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => mockRunner.listen(0, '127.0.0.1', resolve));
    const addr = mockRunner.address();
    const runnerUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

    try {
      const baseDriver = createMockDriver();
      const driver = {
        ...baseDriver,
        setRawWorkspaceToken(sessionId: string, token: string) {
          tokensBySession.set(sessionId, token);
        },
        async ensureRunning(session: { id: string }) {
          return {
            sessionId: session.id,
            runnerUrl,
            astroUrl: 'http://127.0.0.1:4321',
            astroBase: '/',
          };
        },
      };

      // Hermetic GitHub: the revert route verifies commit files before undoing.
      const mockGitHub = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && /\/commits\/[0-9a-f]{40}$/.test(req.url ?? '')) {
          res.end(JSON.stringify({ files: [{ filename: 'src/pages/index.astro' }] }));
          return;
        }
        res.end('[]');
      });
      await new Promise<void>((r) => mockGitHub.listen(0, '127.0.0.1', () => r()));
      const mockGitHubUrl = `http://127.0.0.1:${(mockGitHub.address() as AddressInfo).port}`;
      mockGitHub.unref(); // never keeps the test process alive

      const cfg = {
        ...loadConfig(),
        dataDir: path.join(tmp, 'data'),
        devLoginEnabled: true,
        adminEmails: ['sarah@thecrossing.website'],
        githubApiBaseUrl: mockGitHubUrl,
        githubToken: 'test-token',
        githubAppId: '',
        githubAppPrivateKey: '',
        githubAppInstallationId: '',
        devLocalRepo: '',
      };
      const cp = createControlPlane(cfg, driver as never);

      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sarah@thecrossing.website', name: 'Sarah' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const { user: sarah } = (await login.json()) as { user: { id: string } };

      // Create a published parent session with archived transcript
      const parent = cp.db.createSession({
        id: 'parent-test10',
        title: 'test10',
        slug: 'test10',
        ownerUserId: sarah.id,
        repo: cfg.repo,
        baseBranch: 'main',
        workingBranch: 'halley/test10-123456',
        volumeName: 'halley-ws-parent-test10',
        workspaceTokenHash: 'parent-hash',
      });
      cp.db.updateSession(parent.id, {
        status: 'published',
        publish_state: 'published',
        merged_sha: '318648242c35b6c3e6bba74a94c35a844c2d95bb',
        merged_at: '2026-11-25T17:13:06Z',
      });
      cp.db.upsertSessionArchive({
        sessionId: parent.id,
        transcriptJson: JSON.stringify({
          entries: [
            {
              id: 'u1',
              role: 'user',
              text: '[Current Preview] route=/events viewport=desktop mode=browse\n\nAdd Brunch, Christmas, and Joint Service.',
            },
            {
              id: 'a1',
              role: 'assistant',
              text: 'I added Community Brunch, Christmas Celebration, and the Joint Service notice.',
            },
          ],
        }),
        diffSummary: JSON.stringify([{ path: 'src/pages/events/index.astro', status: 'modified' }]),
        mergedSha: '318648242c35b6c3e6bba74a94c35a844c2d95bb',
      });

      // 1. Start an Undo session -> should push Undo + Prior-Chat digest to /internal/context-note
      const revRes = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          sessionId: parent.id,
          reason: 'Joint service cancelled',
        }),
      });
      expect(revRes.status).toBe(201);
      const { session: revSession } = (await revRes.json()) as {
        session: { id: string; kind: string; title: string; revertsSha: string | null };
      };
      expect(revSession.kind).toBe('revert');
      expect(revSession.title).toBe('Undo: test10');
      expect(revSession.revertsSha).toBe('318648242c35b6c3e6bba74a94c35a844c2d95bb');
      expect(cp.db.getSession(revSession.id)?.initial_revert_sha).toBe(
        'ffd9078000000000000000000000000000000000',
      );

      expect(capturedContextNotes).toHaveLength(1);
      expect(capturedContextNotes[0]?.persist).toBe(true);
      expect(capturedContextNotes[0]?.note).toContain('UNDO DRAFT CONTEXT');
      expect(capturedContextNotes[0]?.note).toContain('Partial-undo rule:');
      expect(capturedContextNotes[0]?.note).toContain('Joint service cancelled');
      expect(capturedContextNotes[0]?.note).toContain('src/pages/events/index.astro (modified, +37/-1)');
      expect(capturedContextNotes[0]?.note).toContain('User: Add Brunch, Christmas, and Joint Service.');
      expect(capturedContextNotes[0]?.note).toContain(
        'Halley: I added Community Brunch, Christmas Celebration, and the Joint Service notice.',
      );

      // 2. Workspace notifies /internal/session/diverged after chat file edit -> converts to continuation
      const wsToken = tokensBySession.get(revSession.id)!;
      const divRes = await cp.app.request('/internal/session/diverged', {
        method: 'POST',
        headers: { Authorization: `Bearer ${wsToken}` },
      });
      expect(divRes.status).toBe(200);
      const divData = (await divRes.json()) as { converted: boolean; kind: string };
      expect(divData.converted).toBe(true);
      expect(divData.kind).toBe('continuation');

      const updated = cp.db.getSession(revSession.id)!;
      expect(updated.kind).toBe('continuation');
      expect(updated.reverts_sha).toBeNull();
      expect(updated.title).toBe('Continued: test10');

      // Publishing the converted session must NOT mark parent test10 as revertedBy in /api/history
      cp.db.updateSession(revSession.id, {
        status: 'published',
        publish_state: 'published',
        merged_sha: '9999999000000000000000000000000000000000',
        merged_at: '2026-11-26T00:00:00Z',
      });
      const histRes = await cp.app.request('/api/history', { headers: { Cookie: cookie } });
      expect(histRes.status).toBe(200);
      const hist = (await histRes.json()) as {
        entries: Array<{ sessionId?: string; revertedBy?: unknown }>;
      };
      const parentEntry = hist.entries.find((e) => e.sessionId === parent.id);
      expect(parentEntry?.revertedBy).toBeNull();

      // 3. Unchecking files via /revert-file on a standalone revert converts kind -> 'edit' & title -> 'Adjusted: ...'
      const rawRev = await cp.app.request('/api/sessions/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          title: 'Footer fix',
          reason: 'Keep one file',
        }),
      });
      expect(rawRev.status).toBe(201);
      const { session: rawRevSession } = (await rawRev.json()) as { session: { id: string } };
      const rfRes = await cp.app.request(`/api/sessions/${rawRevSession.id}/revert-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ path: 'src/pages/index.astro' }),
      });
      expect(rfRes.status).toBe(200);
      const rawUpdated = cp.db.getSession(rawRevSession.id)!;
      expect(rawUpdated.kind).toBe('edit');
      expect(rawUpdated.reverts_sha).toBeNull();
      expect(rawUpdated.title).toBe('Adjusted: Footer fix');
    } finally {
      mockRunner.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('uses fast path in WorkspaceHostDriver.ensureRunning without mirror sync or boot_progress, and reconciles on LRU eviction', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-fastpath-test-'));
    let activeIds: string[] = [];
    let startCalls = 0;
    const mockSupervisor = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            protocolVersion: 2,
            instanceId: 'sup-same-instance',
            activeSessionIds: activeIds,
            activeCount: activeIds.length,
            maxActiveWorkspaces: 5,
            warmPool: { enabled: false, target: 0, ready: 0, warming: 0 },
            buildQueue: { activeSessionId: null, queueLength: 0, queuedSessionIds: [] },
            diskUsage: null,
          }),
        );
        return;
      }
      if (req.url?.endsWith('/start')) {
        startCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            runnerPort: 4510,
            astroPort: 4511,
            astroBase: '/',
            baseSha: 'abc123',
            instanceId: 'sup-same-instance',
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ progress: null }));
    });
    await new Promise<void>((r) => mockSupervisor.listen(0, '127.0.0.1', () => r()));
    const supPort = (mockSupervisor.address() as AddressInfo).port;

    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        workspaceHostUrl: `http://127.0.0.1:${supPort}`,
        devLocalRepo: '',
      };
      const db = new ControlPlaneDb(path.join(tmp, 'cp.sqlite'), cfg);
      const user = db.upsertUser({ email: 'sarah@thecrossing.website', name: 'Sarah', picture: null });
      const sess = db.createSession({
        id: 'sess-fast-path-1',
        title: 'Fast path test',
        slug: 'fast-path',
        ownerUserId: user.id,
        repo: cfg.repo,
        workingBranch: 'halley/fast-path',
        baseBranch: 'main',
        baseSha: 'abc123',
        volumeName: 'vol-fast',
        workspaceTokenHash: hashWorkspaceToken('tok-fast'),
      });
      db.updateSession(sess.id, {
        status: 'running',
        runner_url: 'http://127.0.0.1:4510',
        astro_url: 'http://127.0.0.1:4511',
      });
      activeIds = [sess.id];

      const gh = new GitHubService(cfg);
      const driver = new WorkspaceHostDriver(cfg, db, gh);
      driver.setRawWorkspaceToken(sess.id, 'tok-fast');

      const progressEvents: string[] = [];
      driver.setBootProgressListener((_id, p) => progressEvents.push(p.stage));

      // Fast path: returns immediately without calling /start or emitting boot_progress
      const fresh = db.getSession(sess.id)!;
      const ep1 = await driver.ensureRunning(fresh);
      const ep2 = await driver.ensureRunning(fresh);
      expect(ep1.runnerUrl).toBe('http://127.0.0.1:4510');
      expect(ep2.astroUrl).toBe('http://127.0.0.1:4511');
      expect(startCalls).toBe(0);
      expect(progressEvents).toHaveLength(0);

      // Simulate LRU eviction (same supervisor instanceId, session removed from activeSessionIds)
      activeIds = [];
      // Wait for health cache TTL? Call reconcileSessions directly to verify LRU reconciliation on same instanceId
      await driver.reconcileSessions();
      const afterEvict = db.getSession(sess.id)!;
      expect(afterEvict.status).toBe('sleeping');
      expect(afterEvict.runner_url).toBeNull();
      expect(afterEvict.astro_url).toBeNull();
    } finally {
      mockSupervisor.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
