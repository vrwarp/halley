import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AstroAuditReportDto, OptimizationFindingDto } from '@halley/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { createControlPlane } from '../src/index.js';

function makeSampleReport(sha: string, score: number, findings: OptimizationFindingDto[]): AstroAuditReportDto {
  return {
    id: `audit-${sha.slice(0, 12)}`,
    sha,
    shortSha: sha.slice(0, 7),
    baseBranch: 'main',
    score,
    pillarScores: {
      inline_edit: score,
      agent_context: 100,
      source_mapping: 100,
      guardrails: 100,
      speed_and_ci: 100,
    },
    metrics: {
      totalTextElements: 20,
      inlineEditableElements: 16,
      inlineEditablePct: 80,
      intentionalDynamicElements: 2,
      avoidableLockedElements: score < 100 ? 2 : 0,
      astroPageCount: 5,
      oversizedImageBytes: 0,
    },
    findings,
    aiReviewedAt: null,
    aiSummary: null,
    aiCostUsd: 0,
    createdAt: new Date().toISOString(),
  };
}

describe('control-plane Optimize Astro API, SQLite audit progression & Opus escalation gate', () => {
  it('enforces admin-only RBAC, tracks Before -> After SHA score delta, runs Deep AI Review, and gates Opus strictly to initial Optimization Draft pass', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-opt-'));
    const tokens = new Map<string, string>();
    const startedOptimizations: Array<{
      findingsCount: number;
      escalationModelId: string | null;
    }> = [];

    // Mock Anthropic API + Mock Workspace Runner server
    let anthropicCalls = 0;
    const mockServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'claude-opus-4-6' }, { id: 'claude-haiku-4-5' }],
          }),
        );
        return;
      }

      if (req.url === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 4200 }));
        return;
      }

      if (req.url === '/v1/messages') {
        anthropicCalls += 1;
        const parsed = JSON.parse(bodyStr) as { model: string };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_${anthropicCalls}`,
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  summary: 'Extracting ministry cards into a Content Collection will cut edits to 1 file.',
                  findings: [
                    {
                      pillar: 'agent_context',
                      severity: 'medium',
                      title: 'Extract repeated ministry cards into `src/content/ministries/`',
                      description: 'Avoids editing 400 lines of repeated Astro markup.',
                      impactLabel: 'Cuts ministry edits to 1 JSON file',
                      files: [{ path: 'src/pages/get-connected.astro', line: 42 }],
                      scorePenalty: 4,
                      agentInstructions: 'Move ministry card objects into a Content Collection.',
                    },
                  ],
                }),
              },
            ],
            usage: { input_tokens: 4200, output_tokens: 350 },
          }),
        );
        return;
      }

      if (req.url === '/internal/optimize/start') {
        const parsed = JSON.parse(bodyStr) as {
          findings: OptimizationFindingDto[];
          modelId?: string | null;
        };
        startedOptimizations.push({
          findingsCount: parsed.findings.length,
          escalationModelId: parsed.modelId ?? null,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: 'agent_and_prepass' }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockServer.address() as { port: number };
    const mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    const sha1 = '1111111111111111111111111111111111111111';
    const sha2 = '2222222222222222222222222222222222222222';
    const sampleFinding: OptimizationFindingDto = {
      id: 'finding-slot-1',
      pillar: 'inline_edit',
      severity: 'medium',
      actionKind: 'agent_refactor',
      source: 'static',
      title: 'Unlock inline editing in <PageHeader> via <slot />',
      description: 'Static props lock contenteditable.',
      impactLabel: 'Unlocks 8 headings',
      files: [{ path: 'src/components/PageHeader.astro', line: 1 }],
      scorePenalty: 6,
      agentInstructions: 'Add <slot /> support to PageHeader.astro.',
    };

    let currentScan = {
      sha: sha1,
      report: makeSampleReport(sha1, 74, [sampleFinding]),
      digest: '# Digest for test repo\nSample content',
    };

    const driver: WorkspaceDriver = {
      setRawWorkspaceToken: (id, token) => {
        tokens.set(id, token);
      },
      ensureRunning: async () => ({
        runnerUrl: mockBaseUrl,
        astroUrl: mockBaseUrl,
        astroBase: '/',
        baseSha: currentScan.sha,
      }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
      scanRepository: async () => currentScan,
    };

    try {
      const cfg = {
        ...loadConfig(),
        dataDir: tmp,
        adminEmails: ['admin@thecrossing.website'],
        allowedDomains: ['thecrossing.website'],
        anthropicApiKey: 'sk-ant-test-key',
        anthropicBaseUrl: mockBaseUrl,
        modelId: 'haiku-latest',
        escalationModelId: 'opus-latest',
        dailyCostCapUsd: 10,
        devLoginEnabled: true,
      };
      const cp = createControlPlane(cfg, driver);

      // 1. Non-admin editor is forbidden (403) from all /api/admin/optimize/* endpoints
      const editorLogin = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@thecrossing.website', name: 'Editor' }),
      });
      const editorCookie = editorLogin.headers.get('set-cookie')!.split(';')[0]!;

      const forbiddenRes = await cp.app.request('/api/admin/optimize/latest', {
        headers: { Cookie: editorCookie },
      });
      expect(forbiddenRes.status).toBe(403);

      // Normal session created by editor CANNOT spoof x-halley-purpose: optimize to use Opus!
      const normalCreate = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: editorCookie },
        body: JSON.stringify({ title: 'Regular Edit' }),
      });
      const { session: normalSession } = (await normalCreate.json()) as {
        session: { id: string };
      };
      const normalWsToken = tokens.get(normalSession.id)!;

      const spoofedOpusRes = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': normalWsToken,
          'x-halley-purpose': 'optimize',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Spoof attempt' }],
        }),
      });
      expect(spoofedOpusRes.status).toBe(403);

      // 2. Admin login + Scan #1 -> Scan #2 Before/After progression
      const adminLogin = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@thecrossing.website', name: 'Admin' }),
      });
      const adminCookie = adminLogin.headers.get('set-cookie')!.split(';')[0]!;

      const scan1Res = await cp.app.request('/api/admin/optimize/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ force: false }),
      });
      expect(scan1Res.status).toBe(200);
      const scan1Json = (await scan1Res.json()) as { report: AstroAuditReportDto };
      expect(scan1Json.report.score).toBe(74);
      expect(scan1Json.report.previousReport).toBeNull();

      // Advance live main to sha2 with higher score -> verify previousReport progression
      currentScan = {
        sha: sha2,
        report: makeSampleReport(sha2, 94, [sampleFinding]),
        digest: '# Digest v2\nImproved repo',
      };
      const scan2Res = await cp.app.request('/api/admin/optimize/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ force: false }),
      });
      expect(scan2Res.status).toBe(200);
      const scan2Json = (await scan2Res.json()) as { report: AstroAuditReportDto };
      expect(scan2Json.report.score).toBe(94);
      expect(scan2Json.report.previousReport?.shortSha).toBe('1111111');
      expect(scan2Json.report.previousReport?.score).toBe(74);

      // 3. Estimate + Run Deep AI Review on sha2 -> records 'optimize' spend & merges semantic finding
      const estRes = await cp.app.request('/api/admin/optimize/ai-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ sha: sha2 }),
      });
      expect(estRes.status).toBe(200);
      const { estimate } = (await estRes.json()) as {
        estimate: { modelId: string; inputTokens: number; ceilingUsd: number };
      };
      expect(estimate.modelId).toBe('claude-opus-4-6');
      expect(estimate.inputTokens).toBe(4200);
      expect(estimate.ceilingUsd).toBe(0.5);

      const aiRevRes = await cp.app.request('/api/admin/optimize/ai-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ sha: sha2 }),
      });
      expect(aiRevRes.status).toBe(200);
      const { report: aiReport } = (await aiRevRes.json()) as { report: AstroAuditReportDto };
      expect(aiReport.aiReviewedAt).toBeTruthy();
      expect(aiReport.aiSummary).toContain('Content Collection');
      expect(aiReport.findings.some((f) => f.source === 'ai')).toBe(true);

      const byPurpose = cp.db.listTodaySpendByPurpose();
      expect(byPurpose.some((p) => p.purpose === 'optimize' && p.costUsd > 0)).toBe(true);

      // 4. Create Optimization Draft -> allows Opus during initial pass, then blocks Opus once settled!
      const draftRes = await cp.app.request('/api/admin/optimize/create-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          sha: sha2,
          findingIds: [sampleFinding.id],
          useEscalationModel: true,
        }),
      });
      expect(draftRes.status).toBe(201);
      const { session: optSession } = (await draftRes.json()) as {
        session: { id: string; activeModelLabel: string | null };
      };
      expect(optSession.activeModelLabel).toBe('opus-latest');
      await vi.waitFor(
        () => {
          expect(startedOptimizations).toHaveLength(1);
        },
        { timeout: 2000 },
      );
      expect(startedOptimizations[0]?.escalationModelId).toBe('opus-latest');

      const optWsToken = tokens.get(optSession.id)!;

      // Initial optimization pass with Opus is ALLOWED (200)
      const allowedOpusRes = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': optWsToken,
          'x-halley-purpose': 'optimize',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Refactor PageHeader' }],
        }),
      });
      expect(allowedOpusRes.status).toBe(200);

      // Runner signals initial optimization pass settled -> steps back down to Haiku
      const settledRes = await cp.app.request('/internal/session/optimization-settled', {
        method: 'POST',
        headers: { Authorization: `Bearer ${optWsToken}` },
      });
      expect(settledRes.status).toBe(200);

      const afterSessionRes = await cp.app.request(`/api/sessions/${optSession.id}`, {
        headers: { Cookie: adminCookie },
      });
      const afterSessionJson = (await afterSessionRes.json()) as {
        session: { activeModelLabel: string | null };
      };
      expect(afterSessionJson.session.activeModelLabel).toBeNull();

      // Subsequent Opus call on the same session is now BLOCKED (403), while Haiku chat succeeds (200)!
      const postSettleOpusRes = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': optWsToken,
          'x-halley-purpose': 'optimize',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Another Opus turn' }],
        }),
      });
      expect(postSettleOpusRes.status).toBe(403);

      const haikuFollowupRes = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': optWsToken,
          'x-halley-purpose': 'chat',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Follow-up tweak' }],
        }),
      });
      expect(haikuFollowupRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
