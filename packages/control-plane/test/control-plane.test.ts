import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createControlPlane } from '../src/index.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';

function createMockDriver(): WorkspaceDriver {
  return {
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
  it('enforces allowlist, daily USD spend cap + admin grant, and teammate read-only guard', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-test-'));
    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        allowedDomains: ['thecrossing.website'],
        dailyCostCapUsd: 5,
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, createMockDriver());

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
      const dupData = (await dupRes.json()) as { session: { canEdit: boolean; isOwner: boolean } };
      expect(dupData.session.isOwner).toBe(true);
      expect(dupData.session.canEdit).toBe(true);
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
});
