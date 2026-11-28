import fs from 'node:fs/promises';
import path from 'node:path';
import { ChatClientMessageSchema, type OptimizationFindingDto } from '@halley/shared';
import type { Hono } from 'hono';
import { buildOptimizationPrompt, runDeterministicOptimizationPrePass } from '../astro-optimizer.js';
import { writeFileAtomic } from '../fs-util.js';
import { readJsonBodyOrEmpty } from '../log.js';
import type { RunnerContext } from '../runner-context.js';

/**
 * Agent (Pi) endpoints: context notes, optimization, prompts, transcript, debug trace. Registered
 * by createRunner (see RunnerContext).
 */
export function registerAgentRoutes(app: Hono, ctx: RunnerContext): void {
  const {
    REPO_ROOT,
    STATE_DIR,
    MODEL_ID,
    THINKING_LEVEL,
    gitIdentity,
    changesOrEmpty,
    broadcast,
    notifySessionDiverged,
    notifyOptimizationSettled,
    cancelSpeculativeVerify,
    scheduleIdleSpeculativeVerify,
    pageService,
  } = ctx;
  app.post('/internal/context-note', async (c) => {
    const body = (await c.req.json()) as { note?: string; persist?: boolean };
    if (body.note?.trim()) {
      ctx.piRuntime?.addSystemContextNote(body.note.trim());
      if (body.persist) {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await writeFileAtomic(path.join(STATE_DIR, 'handoff-context.txt'), body.note.trim(), { durable: true });
      }
    }
    return c.json({ ok: true });
  });

  app.post('/internal/optimize/start', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const body = (await readJsonBodyOrEmpty(c)) as {
      findings?: OptimizationFindingDto[];
      modelId?: string;
      defaultModelId?: string;
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    };
    const findings = body.findings ?? [];

    const prePass = await runDeterministicOptimizationPrePass(REPO_ROOT, findings, gitIdentity);
    if (prePass.checkpoint) {
      const changes = await changesOrEmpty();
      broadcast({
        type: 'checkpoint_created',
        checkpoint: prePass.checkpoint,
        changedFilesCount: changes.length,
      });
      notifySessionDiverged();
    }

    if (prePass.agentFindings.length > 0 && ctx.piRuntime) {
      const promptText = buildOptimizationPrompt({
        agentFindings: prePass.agentFindings,
        completedDeterministic: prePass.completedSummaries,
      });
      await ctx.piRuntime.submitOptimizationRequest(promptText, {
        modelId: body.modelId || MODEL_ID,
        defaultModelId: body.defaultModelId || MODEL_ID,
        thinkingLevel: body.thinkingLevel,
        defaultThinkingLevel: THINKING_LEVEL,
        onSettled: () => notifyOptimizationSettled(),
      });
    } else {
      await notifyOptimizationSettled();
      if (prePass.completedSummaries.length > 0) {
        scheduleIdleSpeculativeVerify(1_000);
      }
    }

    return c.json({
      ok: true,
      completedDeterministic: prePass.completedSummaries,
      agentRefactorCount: prePass.agentFindings.length,
      checkpoint: prePass.checkpoint,
    });
  });

  app.post('/internal/prompt', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = ChatClientMessageSchema.parse(await c.req.json());
    if (body.type === 'submit_input') {
      cancelSpeculativeVerify();
      await ctx.piRuntime?.submitUserInput(body);
    } else if (body.type === 'abort') {
      await ctx.piRuntime?.abort();
    } else if (body.type === 'continue_run') {
      cancelSpeculativeVerify();
      await ctx.piRuntime?.continueRun();
    }
    return c.json({ ok: true });
  });

  app.get('/internal/transcript', (c) => {
    const base = ctx.latestTranscript ?? {
      type: 'transcript_state',
      entries: [],
      live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 },
      usageUsd: 0,
    };
    return c.json({
      ...base,
      pageRequests: pageService.listPageRequests(),
    });
  });

  app.get('/internal/debug/trace', (c) => {
    if (!ctx.piRuntime) {
      return c.json({ error: 'Agent runtime is not ready yet' }, 503);
    }
    return c.json(ctx.piRuntime.getDebugTrace());
  });
}
