import path from 'node:path';
import { SyncStartRequestSchema, type ConflictResolutionRecordDto, type MergeReviewStateDto } from '@halley/shared';
import type { Hono } from 'hono';
import { detectAstroSiteUrl } from '../astro-manager.js';
import {
  commitVirtualMergeResolution,
  createCheckpoint,
  getGitChanges,
  resetToRef,
  runLockedGit,
  startRevertCommits,
  virtualMergeWithBase,
} from '../checkpoints-and-git.js';
import {
  applyResolvedFile,
  buildConflictEvidencePack,
  buildContradictionRecord,
  estimateEscalationCost,
  getUpstreamCommits,
  resolvePackWithLlm,
  tryDeterministicResolve,
  type ConflictEvidencePack,
} from '../conflict-protocol.js';
import { ignore, logger, readJsonBodyOrEmpty } from '../log.js';
import { buildChangeCards, resolveVisualReviewRoutes } from '../visual-diff.js';
import type { RunnerContext } from '../runner-context.js';

/**
 * Live-site sync / merge review / revert endpoints. Registered by createRunner (see
 * RunnerContext).
 */
export function registerSyncRoutes(app: Hono, ctx: RunnerContext): void {
  const {
    config,
    randomUUID,
    REPO_ROOT,
    STATE_DIR,
    BASE_BRANCH,
    CONTROL_PLANE_INTERNAL_URL,
    MODEL_ID,
    THINKING_LEVEL,
    gitIdentity,
    saveMetaLogged,
    changesOrEmpty,
    syncPageRequestsLogged,
    broadcast,
    reportCheckpointFailure,
    notifySessionDiverged,
    cancelSpeculativeVerify,
    scheduleIdleSpeculativeVerify,
    cancelInlineEditTimer,
    astroManager,
    persistMergeReviewState,
    runnerNmCache,
  } = ctx;
  const runPostSyncTasks = async (upstreamSummary: string, newSha: string, prevSha: string) => {
    ctx.prevBaseSha = prevSha;
    ctx.baseSha = newSha;
    await saveMetaLogged('state change');
    await ctx.piRuntime?.reloadAgentsMd().catch((e) => ignore(e, 'runner: reload AGENTS.md'));
    if (upstreamSummary) {
      ctx.piRuntime?.addSystemContextNote(`Live site updates merged into this draft: ${upstreamSummary}`);
    }
    if (prevSha && newSha && prevSha !== newSha) {
      const diffFiles = (
        await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${prevSha}..${newSha}`])
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
      const changedDeps = diffFiles.some(
        (f) => f === 'package.json' || f === 'package-lock.json' || f === 'pnpm-lock.yaml',
      );
      const changedConfig = diffFiles.some((f) => f.startsWith('astro.config.'));
      if (changedDeps) {
        await astroManager.pause().catch((e) => ignore(e, 'runner: pause astro dev before dependency change'));
        await runnerNmCache
          .ensureSessionNodeModules({
            workspaceDir: REPO_ROOT,
            stateDir: STATE_DIR,
            devLocalRepo: config.devLocalRepo,
          })
          .catch((err) =>
            // astro dev restarts on whatever node_modules is left; surface why it may now fail
            logger.error('post-sync dependency reinstall failed', { err, prevSha, newSha }),
          );
        await astroManager.restart().catch((e) => ignore(e, 'post-sync astro restart'));
      } else if (changedConfig) {
        await astroManager.restart().catch((e) => ignore(e, 'post-sync astro restart (config)'));
      }
    }
  };

  app.post('/internal/sync/start', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    // Pi-busy refusal + serialization with the other tree mutations: see TREE_MUTATING_ROUTES in index.ts
    cancelInlineEditTimer();
    ctx.activeSyncOps += 1;
    try {
      const rawBody = await readJsonBodyOrEmpty(c);
      const parsedBody = SyncStartRequestSchema.safeParse(rawBody);
      const body = (parsedBody.success ? parsedBody.data : rawBody) as {
        baseBranch?: string;
        kind?: 'sync' | 'publish' | 'revert';
        autoSyncOnly?: boolean;
        autoApplyCleanOnly?: boolean;
        skipFetch?: boolean;
      };
      const baseBranch = body.baseBranch || BASE_BRANCH;
      const kind = body.kind ?? 'sync';
      const baseRef = `origin/${baseBranch}`;

      // If we already deferred an LLM conflict pass from PublishModal open (`autoApplyCleanOnly: true`)
      // and now the user clicked Publish/Resolve (`!autoApplyCleanOnly && !autoSyncOnly`), run the LLM pass on those virtual packs!
      const vres = await virtualMergeWithBase(REPO_ROOT, {
        baseBranch,
        identity: gitIdentity,
        skipFetch: body.skipFetch,
        fetchAuthBearer: ctx.activeHostSecret || ctx.workspaceToken || undefined,
      });

      if (vres.status === 'error') {
        return c.json({ error: vres.error || 'Failed to sync with live site' }, 502);
      }

      if (vres.status === 'clean' && vres.alreadyUpToDate) {
        if (ctx.activeMergeState && ctx.activeMergeState.newBaseSha === vres.newBaseSha) {
          return c.json({
            review: {
              ...ctx.activeMergeState,
              alreadyUpToDate: true,
            },
          });
        }
        const review: MergeReviewStateDto = {
          mergeId: randomUUID(),
          kind,
          status: 'clean',
          preSyncSha: vres.preSyncSha,
          prevBaseSha: ctx.prevBaseSha || vres.prevBaseSha,
          newBaseSha: vres.newBaseSha,
          alreadyUpToDate: true,
          summary: 'Your draft is already up to date with the live site.',
          records: [],
          upstreamCommits: [],
          touchedUserFiles: [],
        };
        return c.json({ review });
      }

      cancelSpeculativeVerify();

      const upstreamCommits = await getUpstreamCommits(REPO_ROOT, vres.prevBaseSha, baseRef);

      if (vres.status === 'clean') {
        const userChanged = (await getGitChanges(REPO_ROOT, vres.prevBaseSha)).map((ch) => ch.path);
        const upstreamChanged = (
          await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${vres.prevBaseSha}..${baseRef}`])
        ).stdout
          .split(/\r?\n/)
          .filter(Boolean);
        const overlap = userChanged.filter((f) => upstreamChanged.includes(f));

        const summary =
          overlap.length > 0
            ? `Merged ${upstreamCommits.length} live update${upstreamCommits.length === 1 ? '' : 's'} into ${overlap.length} file${overlap.length === 1 ? '' : 's'} you edited — please review.`
            : `Updated with ${upstreamCommits.length} change${upstreamCommits.length === 1 ? '' : 's'} from the live site.`;
        await runPostSyncTasks(
          upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
          vres.newBaseSha,
          vres.prevBaseSha,
        );
        const review: MergeReviewStateDto = {
          mergeId: randomUUID(),
          kind,
          status: overlap.length > 0 ? 'ready_for_review' : 'applied',
          preSyncSha: vres.preSyncSha,
          prevBaseSha: vres.prevBaseSha,
          newBaseSha: vres.newBaseSha,
          summary,
          records: [],
          upstreamCommits,
          touchedUserFiles: overlap,
        };
        ctx.activeMergeState = review;
        ctx.activeConflictPacks.clear();
        ctx.activeVirtualTreeSha = undefined;
        ctx.activeMergeNeedsLlmPass = false;
        await persistMergeReviewState();
        return c.json({ review });
      }

      // Virtual merge hit conflicts — `/workspace` is completely untouched and free of `<<<<<<<` markers!
      ctx.activeConflictPacks = new Map();
      ctx.activeVirtualTreeSha = vres.virtualTreeSha;
      const records: ConflictResolutionRecordDto[] = [];
      let firstPassUsageUsd = 0;
      let needsAi = false;

      for (const relPath of vres.conflictedFiles) {
        const pack = await buildConflictEvidencePack(
          REPO_ROOT,
          relPath,
          vres.prevBaseSha,
          baseBranch,
          kind,
          {
            baseSha: vres.prevBaseSha,
            oursSha: vres.preSyncSha,
            theirsSha: vres.newBaseSha,
            virtualTreeSha: vres.virtualTreeSha,
          },
        );
        ctx.activeConflictPacks.set(relPath, pack);

        const det = tryDeterministicResolve(pack);
        if (det) {
          records.push(det);
        } else if (body.autoSyncOnly) {
          needsAi = true;
        } else if (body.autoApplyCleanOnly) {
          // PublishModal open preflight: $0 cost, zero disk mutation, build clear choice card until Publish/Resolve
          needsAi = true;
          records.push(
            buildContradictionRecord(pack, {
              explanation:
                'Both your draft and the live site changed this section. Click Publish to combine automatically, or pick a version below.',
              modelUsed: 'deferred',
            }),
          );
        } else {
          const res = await resolvePackWithLlm(REPO_ROOT, pack, {
            controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
            workspaceToken: ctx.workspaceToken,
            modelId: ctx.piRuntime?.getResolvedModelId() || MODEL_ID,
            thinkingLevel: THINKING_LEVEL,
            purpose: 'conflict',
          });
          firstPassUsageUsd += res.usageUsd;
          records.push(res.record);
        }
      }

      if (body.autoSyncOnly && (needsAi || records.some((r) => r.status === 'needs_choice'))) {
        ctx.activeConflictPacks.clear();
        ctx.activeVirtualTreeSha = undefined;
        return c.json({
          heldForUser: true,
          overlapCount: vres.conflictedFiles.length,
          upstreamCommits,
        });
      }

      const needsChoices = records.some((r) => r.status === 'needs_choice');
      if (!needsChoices) {
        const committed = await commitVirtualMergeResolution(REPO_ROOT, {
          virtualTreeSha: vres.virtualTreeSha,
          preSyncSha: vres.preSyncSha,
          newBaseSha: vres.newBaseSha,
          resolvedFiles: records.map((rec) => ({
            path: rec.path,
            content: rec.resolvedContent ?? '',
          })),
          identity: gitIdentity,
        });
        if (committed.ok) {
          await runPostSyncTasks(
            upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
            vres.newBaseSha,
            vres.prevBaseSha,
          );
          const review: MergeReviewStateDto = {
            mergeId: randomUUID(),
            kind,
            status: 'ready_for_review',
            preSyncSha: vres.preSyncSha,
            prevBaseSha: vres.prevBaseSha,
            newBaseSha: vres.newBaseSha,
            summary: `Combined ${records.length} overlapping change${records.length === 1 ? '' : 's'} automatically — please review.`,
            records,
            upstreamCommits,
            touchedUserFiles: vres.conflictedFiles,
            firstPassUsageUsd,
          };
          ctx.activeMergeState = review;
          ctx.activeVirtualTreeSha = undefined;
          ctx.activeMergeNeedsLlmPass = false;
          await persistMergeReviewState();
          return c.json({ review });
        }
      }

      const review: MergeReviewStateDto = {
        mergeId: randomUUID(),
        kind,
        status: 'needs_choices',
        preSyncSha: vres.preSyncSha,
        prevBaseSha: vres.prevBaseSha,
        newBaseSha: vres.newBaseSha,
        summary: `${records.filter((r) => r.status === 'needs_choice').length} conflict${records.filter((r) => r.status === 'needs_choice').length === 1 ? '' : 's'} need your choice.`,
        records,
        upstreamCommits,
        touchedUserFiles: vres.conflictedFiles,
        firstPassUsageUsd,
      };
      ctx.activeMergeState = review;
      ctx.activeMergeNeedsLlmPass = Boolean(body.autoApplyCleanOnly && needsAi);
      await persistMergeReviewState();
      return c.json({ review });
    } finally {
      ctx.activeSyncOps = Math.max(0, ctx.activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/choose', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!ctx.activeMergeState) return c.json({ error: 'No active merge review' }, 404);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    ctx.activeSyncOps += 1;
    try {
      const body = (await c.req.json()) as {
        choices: Array<{ recordId: string; optionId: string; customInstruction?: string }>;
      };

      for (const choice of body.choices) {
        const rec = ctx.activeMergeState.records.find((r) => r.id === choice.recordId);
        const pack = rec ? ctx.activeConflictPacks.get(rec.path) : undefined;
        if (!rec || !pack) continue;

        if (choice.optionId === 'custom') {
          if (!choice.customInstruction?.trim()) {
            return c.json(
              { error: 'Please enter instructions for what you want Halley to do.' },
              400,
            );
          }
          const res = await resolvePackWithLlm(
            REPO_ROOT,
            pack,
            {
              controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
              workspaceToken: ctx.workspaceToken,
              modelId: ctx.piRuntime?.getResolvedModelId() || MODEL_ID,
              thinkingLevel: THINKING_LEVEL,
              purpose: 'conflict',
            },
            { customInstruction: choice.customInstruction.trim() },
          );
          rec.resolvedContent = res.record.resolvedContent ?? pack.oursContent ?? '';
          rec.resolvedPreview = res.record.resolvedPreview;
          rec.customInstruction = choice.customInstruction.trim();
          rec.chosenOptionId = 'custom';
          rec.status = 'chosen';
        } else if (choice.optionId === 'theirs') {
          rec.resolvedContent = pack.theirsContent ?? undefined;
          rec.chosenOptionId = 'theirs';
          rec.status = 'chosen';
        } else if (choice.optionId === 'ours') {
          rec.resolvedContent = pack.oursContent ?? undefined;
          rec.chosenOptionId = 'ours';
          rec.status = 'chosen';
        } else if (choice.optionId === 'combined') {
          rec.chosenOptionId = 'combined';
          rec.status = 'chosen';
        }
      }

      const stillPending = ctx.activeMergeState.records.some((r) => r.status === 'needs_choice');
      if (!stillPending) {
        const resolvedList = ctx.activeMergeState.records.map((rec) => {
          const pack = ctx.activeConflictPacks.get(rec.path);
          const content =
            rec.chosenOptionId === 'theirs'
              ? (pack?.theirsContent ?? null)
              : rec.chosenOptionId === 'ours'
                ? (pack?.oursContent ?? null)
                : (rec.resolvedContent ?? pack?.oursContent ?? '');
          return { path: rec.path, content };
        });

        if (ctx.activeMergeState.kind !== 'revert' || ctx.activeVirtualTreeSha) {
          const committed = await commitVirtualMergeResolution(REPO_ROOT, {
            virtualTreeSha: ctx.activeVirtualTreeSha,
            preSyncSha: ctx.activeMergeState.preSyncSha,
            newBaseSha: ctx.activeMergeState.newBaseSha,
            resolvedFiles: resolvedList,
            identity: gitIdentity,
            commitMessage:
              ctx.activeMergeState.kind === 'revert'
                ? 'halley-checkpoint: Undo published edit (resolved conflicts)'
                : undefined,
            intentKind: ctx.activeMergeState.kind === 'revert' ? 'revert' : 'sync',
          });
          if (!committed.ok) {
            return c.json({ error: committed.error }, 400);
          }
        } else {
          for (const item of resolvedList) {
            const applied = await applyResolvedFile(REPO_ROOT, item.path, item.content);
            if (!applied.ok) {
              return c.json({ error: applied.error || `Failed to apply ${item.path}` }, 400);
            }
          }
          await runLockedGit(
            REPO_ROOT,
            [
              '-c',
              `user.name=${gitIdentity.botName}`,
              '-c',
              `user.email=${gitIdentity.botEmail}`,
              'commit',
              '--no-edit',
            ],
            { GIT_EDITOR: 'true' },
          );
        }

        if (ctx.activeMergeState.kind !== 'revert') {
          await runPostSyncTasks(
            ctx.activeMergeState.upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
            ctx.activeMergeState.newBaseSha,
            ctx.activeMergeState.prevBaseSha,
          );
        }
        ctx.activeMergeState.status = 'ready_for_review';
        ctx.activeMergeState.summary = 'All conflicts resolved — review the result below.';
        ctx.activeVirtualTreeSha = undefined;
        ctx.activeMergeNeedsLlmPass = false;
      }

      await persistMergeReviewState();
      return c.json({ review: ctx.activeMergeState });
    } finally {
      ctx.activeSyncOps = Math.max(0, ctx.activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/undo', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await readJsonBodyOrEmpty(c)) as { targetSha?: string };
    const targetSha = body.targetSha || ctx.activeMergeState?.preSyncSha;
    if (!targetSha) return c.json({ error: 'No pre-sync snapshot to restore' }, 400);
    // If the conflict was purely virtual (`needs_choices`), HEAD wasn't even moved unless the user edited later!
    if (ctx.activeMergeState?.status !== 'needs_choices' || body.targetSha) {
      const ok = await resetToRef(REPO_ROOT, targetSha, gitIdentity);
      if (!ok) return c.json({ error: 'Failed to undo update' }, 500);
      if (ctx.activeMergeState?.prevBaseSha) {
        ctx.baseSha = ctx.activeMergeState.prevBaseSha;
        await saveMetaLogged('state change');
      }
    }
    ctx.activeMergeState = null;
    ctx.activeConflictPacks.clear();
    ctx.activeVirtualTreeSha = undefined;
    ctx.activeMergeNeedsLlmPass = false;
    await persistMergeReviewState();
    await syncPageRequestsLogged('after git operation');
    const changes = await changesOrEmpty();
    return c.json({ ok: true, changedFilesCount: changes.length });
  });

  app.post('/internal/sync/estimate-escalation', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      recordIds?: string[];
      userNote?: string;
      remainingBudgetUsd?: number;
      escalationModelId?: string;
      hardCeilingUsd?: number;
    };
    const selectedPacks: ConflictEvidencePack[] = [];
    for (const rec of ctx.activeMergeState?.records ?? []) {
      if (!body.recordIds || body.recordIds.length === 0 || body.recordIds.includes(rec.id)) {
        const pack = ctx.activeConflictPacks.get(rec.path);
        if (pack) selectedPacks.push(pack);
      }
    }
    const resolvedEscModel =
      ctx.piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
    const estimate = await estimateEscalationCost({
      packs: selectedPacks,
      controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
      workspaceToken: ctx.workspaceToken,
      escalationModelId: resolvedEscModel,
      hardCeilingUsd: body.hardCeilingUsd ?? 2,
      remainingBudgetUsd: body.remainingBudgetUsd ?? 10,
      firstPassUsageUsd: ctx.activeMergeState?.firstPassUsageUsd,
      userNote: body.userNote,
    });
    return c.json({ estimate });
  });

  app.post('/internal/sync/escalate', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!ctx.activeMergeState) return c.json({ error: 'No active merge review to improve' }, 404);
    ctx.activeSyncOps += 1;
    try {
      const body = (await readJsonBodyOrEmpty(c)) as {
        recordIds?: string[];
        userNote?: string;
        escalationModelId?: string;
        escalationThinking?: 'off' | 'low' | 'medium' | 'high';
        ceilingUsd?: number;
      };
      const resolvedEscModel =
        ctx.piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
      const runId = randomUUID();
      const ceilingUsd = Math.min(body.ceilingUsd ?? 2, 2);

      const advRecords: ConflictResolutionRecordDto[] = [];
      let totalUsage = 0;
      let stoppedAtCeiling = false;

      for (const rec of ctx.activeMergeState.records) {
        if (body.recordIds && body.recordIds.length > 0 && !body.recordIds.includes(rec.id)) {
          continue;
        }
        const pack = ctx.activeConflictPacks.get(rec.path);
        if (!pack) continue;
        const res = await resolvePackWithLlm(
          REPO_ROOT,
          pack,
          {
            controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
            workspaceToken: ctx.workspaceToken,
            modelId: resolvedEscModel,
            thinkingLevel: body.escalationThinking ?? 'medium',
            purpose: 'conflict-escalation',
            runId,
            runCeilingUsd: ceilingUsd,
          },
          {
            rejectedAttempt: rec.resolvedContent,
            userNote: body.userNote,
          },
        );
        totalUsage += res.usageUsd;
        advRecords.push(res.record);
        if (res.stoppedAtCeiling) {
          stoppedAtCeiling = true;
          break;
        }
      }

      const identicalToFirst =
        advRecords.length > 0 &&
        advRecords.every((adv) => {
          const orig = ctx.activeMergeState!.records.find((r) => r.path === adv.path);
          return orig && orig.resolvedContent === adv.resolvedContent;
        });

      ctx.activeMergeState.advancedAttempt = {
        records: advRecords,
        usageUsd: Number(totalUsage.toFixed(4)),
        identicalToFirst,
        stoppedAtCeiling,
        message: stoppedAtCeiling
          ? `Stopped at $${totalUsage.toFixed(2)} to stay within the $${ceilingUsd.toFixed(2)} ceiling. First attempt kept.`
          : identicalToFirst
            ? 'The Advanced model reached the same result.'
            : 'Compare First vs Advanced below and choose which to keep.',
      };
      await persistMergeReviewState();
      return c.json({ review: ctx.activeMergeState });
    } finally {
      ctx.activeSyncOps = Math.max(0, ctx.activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/apply-advanced', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!ctx.activeMergeState?.advancedAttempt) {
      return c.json({ error: 'No advanced attempt available' }, 404);
    }
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as {
      picks: Array<{ path: string; use: 'advanced' | 'first' }>;
    };
    for (const pick of body.picks) {
      if (pick.use !== 'advanced') continue;
      const adv = ctx.activeMergeState.advancedAttempt.records.find((r) => r.path === pick.path);
      if (!adv?.resolvedContent) continue;
      const applied = await applyResolvedFile(REPO_ROOT, adv.path, adv.resolvedContent);
      if (!applied.ok) return c.json({ error: applied.error }, 400);
      const orig = ctx.activeMergeState.records.find((r) => r.path === adv.path);
      if (orig) {
        orig.resolvedContent = adv.resolvedContent;
        orig.resolvedPreview = adv.resolvedPreview;
        orig.explanation = adv.explanation;
        orig.modelUsed = adv.modelUsed;
        orig.status = 'chosen';
      }
    }
    const ckpt = await createCheckpoint(
      REPO_ROOT,
      'Applied Advanced merge improvements',
      gitIdentity,
    ).catch((err) => {
      reportCheckpointFailure('advanced merge improvements', err);
      return null;
    });
    const changes = await changesOrEmpty();
    if (ckpt) {
      broadcast({
        type: 'checkpoint_created',
        checkpoint: ckpt,
        changedFilesCount: changes.length,
      });
    }
    notifySessionDiverged(changes.length);
    await persistMergeReviewState();
    scheduleIdleSpeculativeVerify();
    return c.json({ review: ctx.activeMergeState });
  });

  app.post('/internal/git/revert-start', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    ctx.activeSyncOps += 1;
    try {
      const body = (await c.req.json()) as { shas: string[] };
      const targetShas = body.shas ?? [];
      const result = await startRevertCommits(REPO_ROOT, targetShas, gitIdentity);
      if (result.status === 'conflict' && result.conflictedFiles.length > 0) {
        ctx.activeConflictPacks = new Map();
        ctx.activeVirtualTreeSha = result.virtualTreeSha;
        const records: ConflictResolutionRecordDto[] = [];
        for (const relPath of result.conflictedFiles) {
          const virtualRefs =
            result.virtualTreeSha && result.preRevertSha && result.targetParentSha && targetShas[0]
              ? {
                  baseSha: targetShas[0],
                  oursSha: result.preRevertSha,
                  theirsSha: result.targetParentSha,
                  virtualTreeSha: result.virtualTreeSha,
                }
              : undefined;
          const pack = await buildConflictEvidencePack(
            REPO_ROOT,
            relPath,
            ctx.baseSha,
            BASE_BRANCH,
            'revert',
            virtualRefs,
          );
          ctx.activeConflictPacks.set(relPath, pack);
          const det = tryDeterministicResolve(pack);
          if (det) {
            records.push(det);
          } else {
            const res = await resolvePackWithLlm(REPO_ROOT, pack, {
              controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
              workspaceToken: ctx.workspaceToken,
              modelId: ctx.piRuntime?.getResolvedModelId() || MODEL_ID,
              thinkingLevel: THINKING_LEVEL,
              purpose: 'conflict',
            });
            records.push(res.record);
          }
        }
        const headSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        const needsChoices = records.some((r) => r.status === 'needs_choice');
        let resolvedAndCommitted = false;
        if (!needsChoices) {
          if (result.virtualTreeSha && result.targetParentSha) {
            const committed = await commitVirtualMergeResolution(REPO_ROOT, {
              virtualTreeSha: result.virtualTreeSha,
              preSyncSha: headSha,
              newBaseSha: result.targetParentSha,
              resolvedFiles: records.map((rec) => ({
                path: rec.path,
                content: rec.resolvedContent ?? '',
              })),
              identity: gitIdentity,
              commitMessage: `halley-checkpoint: Undo published edit (${targetShas.map((s) => s.slice(0, 7)).join(', ')})\n\nCo-authored-by: ${gitIdentity.editorName} <${gitIdentity.editorEmail}>`,
              intentKind: 'revert',
            });
            if (committed.ok) {
              // Convert commit to single-parent checkpoint on HEAD so history stays linear
              const treeSha = (
                await runLockedGit(REPO_ROOT, ['rev-parse', `${committed.mergeCommitSha}^{tree}`])
              ).stdout.trim();
              const linearRes = await runLockedGit(
                REPO_ROOT,
                [
                  'commit-tree',
                  treeSha,
                  '-p',
                  headSha,
                  '-m',
                  `halley-checkpoint: Undo published edit (${targetShas.map((s) => s.slice(0, 7)).join(', ')})\n\nCo-authored-by: ${gitIdentity.editorName} <${gitIdentity.editorEmail}>`,
                ],
                {
                  GIT_AUTHOR_NAME: gitIdentity.botName,
                  GIT_AUTHOR_EMAIL: gitIdentity.botEmail,
                  GIT_COMMITTER_NAME: gitIdentity.botName,
                  GIT_COMMITTER_EMAIL: gitIdentity.botEmail,
                },
              );
              const linearSha = linearRes.stdout.trim();
              if (linearRes.code === 0 && /^[0-9a-f]{40}$/i.test(linearSha)) {
                await runLockedGit(REPO_ROOT, ['update-ref', 'HEAD', linearSha]);
                result.revertCheckpointSha = linearSha;
              } else {
                result.revertCheckpointSha = committed.mergeCommitSha;
              }
              resolvedAndCommitted = true;
              ctx.activeVirtualTreeSha = undefined;
            }
          } else {
            let allApplied = true;
            for (const rec of records) {
              const applied = await applyResolvedFile(
                REPO_ROOT,
                rec.path,
                rec.resolvedContent ?? '',
              );
              if (!applied.ok) allApplied = false;
            }
            if (allApplied) {
              await runLockedGit(
                REPO_ROOT,
                [
                  '-c',
                  `user.name=${gitIdentity.botName}`,
                  '-c',
                  `user.email=${gitIdentity.botEmail}`,
                  'commit',
                  '--no-edit',
                ],
                { GIT_EDITOR: 'true' },
              );
              const newHead = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
              if (newHead && newHead !== headSha) {
                result.revertCheckpointSha = newHead;
                resolvedAndCommitted = true;
              }
            }
          }
        }
        await syncPageRequestsLogged('after git operation');
        const changes = await changesOrEmpty();
        ctx.activeMergeState = {
          mergeId: randomUUID(),
          kind: 'revert',
          status: !needsChoices && resolvedAndCommitted ? 'ready_for_review' : 'needs_choices',
          preSyncSha: headSha,
          prevBaseSha: ctx.baseSha,
          newBaseSha: result.targetParentSha || ctx.baseSha,
          summary:
            !needsChoices && resolvedAndCommitted
              ? 'Combined your undo with newer live-site updates — please review.'
              : 'Someone updated these pages after your publication — choose what to keep.',
          records,
          upstreamCommits: [],
          touchedUserFiles: result.conflictedFiles,
        };
        await persistMergeReviewState();
        return c.json({ ...result, changedFilesCount: changes.length, review: ctx.activeMergeState });
      }
      await syncPageRequestsLogged('after git operation');
      const changes = await changesOrEmpty();
      return c.json({ ...result, changedFilesCount: changes.length });
    } finally {
      ctx.activeSyncOps = Math.max(0, ctx.activeSyncOps - 1);
    }
  });

  app.get('/internal/review', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const activeRoute = c.req.query('activeRoute') || null;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const cards = await buildChangeCards(REPO_ROOT, changes, {
      baseRef,
      prevBaseSha: ctx.prevBaseSha || null,
      editorName: gitIdentity.editorName,
      conflictRecords: ctx.activeMergeState?.records,
    });
    const targetRoutes = resolveVisualReviewRoutes(cards, activeRoute);
    const mergedFromLiveFiles =
      ctx.prevBaseSha && ctx.baseSha && ctx.prevBaseSha !== ctx.baseSha
        ? (await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${ctx.prevBaseSha}..${ctx.baseSha}`]))
            .stdout
            .split(/\r?\n/)
            .filter(Boolean)
        : [];

    const liveSiteUrl = await detectAstroSiteUrl(REPO_ROOT);

    return c.json({
      cards,
      pages: [],
      targetRoutes,
      draftFiles: changes.map((ch) => ch.path),
      mergedFromLiveFiles,
      astroReady: astroManager.getStatus().ready,
      previewBase: ctx.previewBase,
      liveSiteUrl,
      mergeReview: ctx.activeMergeState,
      baseSha: ctx.baseSha,
      prevBaseSha: ctx.prevBaseSha || null,
    });
  });
}
