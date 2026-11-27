import crypto from 'node:crypto';
import type {
  PublishProgressPayload,
  PublishState,
  UserDto,
  VerificationCheckResult,
} from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, PublishRunRecord, SessionRecord } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';
import { GitHubApiError, type GitHubService } from '../github/client.js';

export interface DeployPollOptions {
  initialDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  runRegistrationGraceMs?: number;
  maxConsecutiveErrors?: number;
  ciPollIntervalMs?: number;
  ciRegistrationGraceMs?: number;
}

const DEFAULT_DEPLOY_POLL_OPTIONS: Required<DeployPollOptions> = {
  initialDelayMs: 1000,
  pollIntervalMs: 2000,
  timeoutMs: 6 * 60_000,
  runRegistrationGraceMs: 45_000,
  maxConsecutiveErrors: 5,
  ciPollIntervalMs: 1500,
  ciRegistrationGraceMs: 15_000,
};

const PRE_PR_STEPS = new Set<PublishState>([
  'rebasing',
  'resolving_conflicts',
  'verifying',
  'pushing_pr',
]);

export class PublishService {
  private activePublishes = new Set<string>();
  private activeDeployChecks = new Set<string>();
  private deployPollOptions: Required<DeployPollOptions>;

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private driver: WorkspaceDriver,
    private github: GitHubService,
    private broadcastPublish: (sessionId: string, payload: PublishProgressPayload) => void,
    private onSessionMetaUpdated?: (sessionId: string) => void,
    deployPollOptions?: DeployPollOptions,
  ) {
    this.deployPollOptions = { ...DEFAULT_DEPLOY_POLL_OPTIONS, ...deployPollOptions };
  }

  isPublishActive(sessionId: string): boolean {
    return this.activePublishes.has(sessionId) || this.activeDeployChecks.has(sessionId);
  }

  private setState(
    sessionId: string,
    state: PublishState,
    extra: Partial<PublishProgressPayload> = {},
  ): void {
    this.db.updateSession(sessionId, {
      publish_state: state,
      publish_error: extra.error ?? null,
      ...(extra.prNumber !== undefined ? { pr_number: extra.prNumber } : {}),
      ...(extra.prUrl !== undefined ? { pr_url: extra.prUrl } : {}),
    });
    this.broadcastPublish(sessionId, { state, ...extra });
  }

  private async rollbackExcludedPathsIfNeeded(
    runnerUrl: string | null,
    preExcludeSha: string | null,
  ): Promise<void> {
    if (!runnerUrl || !preExcludeSha) return;
    await fetch(`${runnerUrl}/internal/git/restore-sha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: preExcludeSha }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }

  /**
   * Resumes in-flight `waiting_ci` and `deploying_pages` runs after a `control-plane` restart
   * instead of wiping active PR/deploy pipelines back to `idle`.
   */
  resumeIncompletePublishes(): void {
    const activeRuns = this.db.listActivePublishRuns();
    const handledIds = new Set<string>();

    for (const run of activeRuns) {
      handledIds.add(run.session_id);
      const session = this.db.getSession(run.session_id);
      if (!session) {
        this.db.deletePublishRun(run.session_id);
        continue;
      }

      if (session.status === 'published') {
        this.db.deletePublishRun(run.session_id);
        continue;
      }

      if (
        (run.step === 'deploying_pages' || session.status === 'merged') &&
        (run.merged_sha || session.merged_sha) &&
        (run.pr_number || session.pr_number) &&
        (run.pr_url || session.pr_url)
      ) {
        const mergeSha = (run.merged_sha || session.merged_sha)!;
        const prNumber = (run.pr_number || session.pr_number)!;
        const prUrl = (run.pr_url || session.pr_url)!;
        void this.waitForPagesDeploy(session.id, mergeSha, prNumber, prUrl, { initialDelayMs: 0 });
        continue;
      }

      if (run.step === 'waiting_ci' && run.pr_number && run.pr_url) {
        void this.resumeWaitingCiRun(session, run);
        continue;
      }

      // Interrupted before a PR was created: clean up run record and reset publish_state to idle
      this.db.deletePublishRun(session.id);
      if (session.status !== 'merged') {
        this.db.updateSession(session.id, { publish_state: 'idle', publish_error: null });
      }
    }

    // Reconcile any legacy sessions without a publish_runs row
    for (const s of this.db.listSessions()) {
      if (handledIds.has(s.id)) continue;
      if (
        s.status === 'merged' &&
        s.publish_state === 'deploying_pages' &&
        s.merged_sha &&
        s.pr_number &&
        s.pr_url
      ) {
        void this.waitForPagesDeploy(s.id, s.merged_sha, s.pr_number, s.pr_url, {
          initialDelayMs: 0,
        });
      } else if (
        PRE_PR_STEPS.has(s.publish_state) &&
        s.status !== 'merged' &&
        s.status !== 'published'
      ) {
        this.db.updateSession(s.id, { publish_state: 'idle', publish_error: null });
      }
    }
  }

  private async resumeWaitingCiRun(session: SessionRecord, run: PublishRunRecord): Promise<void> {
    if (this.activePublishes.has(session.id)) return;
    this.activePublishes.add(session.id);
    try {
      const actor = this.db.getUserById(run.actor_user_id) ?? {
        id: session.owner_user_id,
        email: session.owner_email || 'editor@example.com',
        name: session.owner_name || 'Editor',
        picture: null,
        isAdmin: false,
        persona: 'non-technical' as const,
      };
      const prTitle = (run.title || session.title || 'Website update').trim();
      const prBody = [
        run.summary?.trim() || `Updates from Halley editing session **${session.title}**.`,
        '',
        `Edited by ${actor.name} (${actor.email}) via Halley.`,
      ].join('\n');
      const commitMsg = `${prBody}\n\nCo-authored-by: ${actor.name} <${actor.email}>`;

      const mergedSha = await this.waitForCiAndMerge({
        session,
        prNumber: run.pr_number!,
        prUrl: run.pr_url!,
        headSha: run.local_head_sha || '',
        commitTitle: prTitle,
        commitMessage: commitMsg,
        nativeAutoMerge: run.native_auto_merge === 1,
      });
      if (!mergedSha) return;

      await this.finalizeMergeAndAwaitDeploy(
        session,
        session.runner_url,
        mergedSha,
        run.pr_number!,
        run.pr_url!,
        run.run_id,
        actor.id,
      );
    } catch (err) {
      this.db.deletePublishRun(session.id);
      this.setState(session.id, 'failed_ci', {
        prNumber: run.pr_number,
        prUrl: run.pr_url,
        error: err instanceof Error ? err.message : 'Failed resuming CI check after restart',
      });
    } finally {
      this.activePublishes.delete(session.id);
    }
  }

  private async finalizeMergeAndAwaitDeploy(
    session: SessionRecord,
    runnerUrl: string | null,
    mergedSha: string,
    prNumber: number,
    prUrl: string,
    runId: string,
    actorUserId: string,
  ): Promise<void> {
    const mergedAt = new Date().toISOString();
    this.db.updateSession(session.id, {
      status: 'merged',
      merged_sha: mergedSha,
      merged_at: mergedAt,
    });
    this.driver.notifyMirrorUpdated?.(session.base_branch);
    if (runnerUrl) {
      await fetch(`${runnerUrl}/internal/read-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readOnly: true }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    await this.archiveSessionDeterministically(
      session.id,
      runnerUrl,
      session.base_branch,
      mergedSha,
      prUrl,
    );

    this.db.upsertPublishRun({
      sessionId: session.id,
      runId,
      actorUserId,
      step: 'deploying_pages',
      prNumber,
      prUrl,
      mergedSha,
    });
    this.setState(session.id, 'deploying_pages', { prNumber, prUrl });
    this.onSessionMetaUpdated?.(session.id);

    await this.waitForPagesDeploy(session.id, mergedSha, prNumber, prUrl);
  }

  async publish(
    sessionInput: SessionRecord,
    actor: UserDto,
    input: { title?: string; summary?: string; excludePaths?: string[] },
  ): Promise<void> {
    if (this.activePublishes.has(sessionInput.id)) {
      return;
    }
    this.activePublishes.add(sessionInput.id);

    const runId = crypto.randomUUID();
    let runnerUrl: string | null = null;
    let preExcludeSha: string | null = null;

    this.db.upsertPublishRun({
      sessionId: sessionInput.id,
      runId,
      actorUserId: actor.id,
      title: input.title ?? null,
      summary: input.summary ?? null,
      excludePathsJson: input.excludePaths?.length ? JSON.stringify(input.excludePaths) : null,
      step: 'rebasing',
    });

    try {
      let session = this.db.getSession(sessionInput.id) ?? sessionInput;
      const endpoint = await this.driver.ensureRunning(session);
      runnerUrl = endpoint.runnerUrl;

      // 0. Commit any pending inline/working-tree edits so HEAD has the exact draft state
      const ckptRes = await fetch(`${runnerUrl}/internal/git/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Ready to publish' }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (ckptRes?.ok && session.kind === 'revert') {
        const ckptData = (await ckptRes.json().catch(() => null)) as { checkpoint?: unknown } | null;
        if (ckptData?.checkpoint) {
          const converted = this.db.convertRevertSession(session.id);
          if (converted) {
            session = converted;
            this.onSessionMetaUpdated?.(session.id);
          }
        }
      }

      // 0b. Transactionally exclude unchecked paths (restored automatically if pre-push checks fail)
      if (input.excludePaths && input.excludePaths.length > 0) {
        const exclRes = await fetch(`${runnerUrl}/internal/git/exclude-paths`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paths: input.excludePaths,
            baseRef: `origin/${session.base_branch}`,
          }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!exclRes.ok) {
          const errBody = (await exclRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error || 'Failed to apply excluded file selection');
        }
        const exclData = (await exclRes.json()) as {
          preExcludeSha?: string | null;
          changedFilesCount?: number;
        };
        preExcludeSha = exclData.preExcludeSha ?? null;
        if (typeof exclData.changedFilesCount === 'number') {
          this.db.updateSession(session.id, { changed_files_count: exclData.changedFilesCount });
        }
        if (session.kind === 'revert') {
          const converted = this.db.convertRevertSession(session.id);
          if (converted) {
            session = converted;
            this.onSessionMetaUpdated?.(session.id);
          }
        }
        this.db.upsertPublishRun({
          sessionId: session.id,
          runId,
          actorUserId: actor.id,
          step: 'rebasing',
          preExcludeSha,
        });
      }

      // 1. Sync with latest base branch FIRST (fail closed if fetch fails!)
      this.setState(session.id, 'rebasing');
      const ghToken = await this.github.getAccessToken().catch(() => '');
      let fetchedByDriver = false;
      if (ghToken || this.config.devLocalRepo) {
        try {
          await this.driver.fetchIntoSession(session, ghToken);
          fetchedByDriver = true;
        } catch (fetchErr) {
          throw new Error(
            `Could not sync latest changes from GitHub before publishing: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          );
        }
      }

      const syncRes = await fetch(`${runnerUrl}/internal/sync/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseBranch: session.base_branch,
          kind: 'publish',
          autoSyncOnly: true,
          skipFetch: fetchedByDriver,
        }),
        signal: AbortSignal.timeout(55_000),
      });
      const syncData = (await syncRes.json()) as {
        heldForUser?: boolean;
        overlapCount?: number;
        review?: {
          status: 'clean' | 'applied' | 'ready_for_review' | 'needs_choices';
          alreadyUpToDate?: boolean;
          newBaseSha?: string;
          prevBaseSha?: string;
          touchedUserFiles?: string[];
        };
      };

      if (syncData.heldForUser) {
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha);
        preExcludeSha = null;
        const fullSyncRes = await fetch(`${runnerUrl}/internal/sync/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseBranch: session.base_branch,
            kind: 'publish',
            autoSyncOnly: false,
            skipFetch: true,
          }),
          signal: AbortSignal.timeout(55_000),
        }).catch(() => null);
        if (fullSyncRes?.ok) {
          const fullSyncData = (await fullSyncRes.json().catch(() => null)) as {
            review?: {
              status?: string;
              newBaseSha?: string;
              prevBaseSha?: string;
            };
          } | null;
          if (
            fullSyncData?.review?.newBaseSha &&
            fullSyncData.review.status !== 'needs_choices'
          ) {
            this.db.updateSession(session.id, {
              prev_base_sha: fullSyncData.review.prevBaseSha ?? (session.base_sha || null),
              base_sha: fullSyncData.review.newBaseSha,
            });
          }
        }
        this.db.deletePublishRun(session.id);
        this.setState(session.id, 'failed_conflict', {
          error:
            'Someone else updated the same page while you were publishing. Please review the combined changes before publishing.',
        });
        return;
      }

      if (syncData.review?.newBaseSha && syncData.review.status !== 'needs_choices') {
        this.db.updateSession(session.id, {
          prev_base_sha: syncData.review.prevBaseSha ?? (session.base_sha || null),
          base_sha: syncData.review.newBaseSha,
        });
      }

      if (
        syncData.review &&
        (syncData.review.status === 'ready_for_review' || syncData.review.status === 'needs_choices')
      ) {
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha);
        preExcludeSha = null;
        this.db.deletePublishRun(session.id);
        this.setState(session.id, 'failed_conflict', {
          conflictedFiles: syncData.review.touchedUserFiles,
          error:
            'Someone just published an update to a page you edited. Please double-check Live vs Draft and click Publish again.',
        });
        return;
      }

      // 2. Hard-gate verification checks ONCE on the synced tree (hits verify-sandbox / tree-SHA cache)
      this.db.upsertPublishRun({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        step: 'verifying',
      });
      this.setState(session.id, 'verifying');
      const verifyRes = await fetch(`${runnerUrl}/internal/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pausePreview: false }),
        signal: AbortSignal.timeout(180_000),
      });
      const verifyData = (await verifyRes.json()) as {
        allPassed: boolean;
        results: VerificationCheckResult[];
      };
      if (!verifyData.allPassed) {
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha);
        preExcludeSha = null;
        const failed = verifyData.results.filter((r) => !r.passed);
        this.db.deletePublishRun(session.id);
        this.setState(session.id, 'failed_checks', {
          checks: verifyData.results,
          error: `Checks failed: ${failed.map((f) => f.name).join(', ')}`,
        });
        return;
      }

      // 3. Layer-3 .github/** hard gate before pushing
      const protRes = await fetch(
        `${runnerUrl}/internal/git/protected-diff?baseRef=${encodeURIComponent(`origin/${session.base_branch}`)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const protData = (await protRes.json()) as { clean: boolean; protectedFiles: string[] };
      if (!protData.clean) {
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha);
        preExcludeSha = null;
        this.db.deletePublishRun(session.id);
        this.setState(session.id, 'failed_checks', {
          error: `Blocked: protected .github/** files were modified (${protData.protectedFiles.join(', ')}).`,
        });
        return;
      }

      // 4. Push branch & open/update PR
      this.db.upsertPublishRun({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        step: 'pushing_pr',
      });
      this.setState(session.id, 'pushing_pr');
      if (!ghToken && !this.config.devLocalRepo) {
        throw new Error('GitHub credentials are not configured for pushing');
      }
      await this.driver.pushSessionBranch(session, ghToken);
      preExcludeSha = null; // Branch pushed cleanly; do not roll back exclude commit anymore

      const prTitle = (input.title || session.title || 'Website update').trim();
      if (prTitle && prTitle !== session.title) {
        this.db.updateSession(session.id, { title: prTitle });
        session = { ...session, title: prTitle };
      }
      const prBody = [
        input.summary?.trim() || `Updates from Halley editing session **${session.title}**.`,
        '',
        `Edited by ${actor.name} (${actor.email}) via Halley.`,
      ].join('\n');

      const pr = await this.github.createOrUpdatePr({
        headBranch: session.working_branch,
        baseBranch: session.base_branch,
        title: prTitle,
        body: prBody,
      });

      const commitMsg = `${prBody}\n\nCo-authored-by: ${actor.name} <${actor.email}>`;
      const nativeAutoMerge = await this.github.tryEnableNativeAutoMerge(
        pr.nodeId,
        prTitle,
        commitMsg,
      );

      this.db.upsertPublishRun({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        title: prTitle,
        summary: input.summary ?? null,
        step: 'waiting_ci',
        localHeadSha: pr.headSha,
        prNumber: pr.number,
        prUrl: pr.url,
        nativeAutoMerge,
      });
      this.setState(session.id, 'waiting_ci', {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      // 5. Watch CI & auto-merge (squash) when checks pass
      const mergedSha = await this.waitForCiAndMerge({
        session,
        prNumber: pr.number,
        prUrl: pr.url,
        headSha: pr.headSha,
        commitTitle: prTitle,
        commitMessage: commitMsg,
        nativeAutoMerge,
      });
      if (!mergedSha) {
        this.db.deletePublishRun(session.id);
        return;
      }

      // 6. Freeze editing immediately in 'merged' state and watch GitHub Pages deploy
      await this.finalizeMergeAndAwaitDeploy(
        session,
        runnerUrl,
        mergedSha,
        pr.number,
        pr.url,
        runId,
        actor.id,
      );
    } catch (err) {
      await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha);
      this.db.deletePublishRun(sessionInput.id);
      const rawMsg = err instanceof Error ? err.message : 'Publish failed unexpectedly';
      const crashInfo = this.driver.getCrashInfo?.(sessionInput.id);
      const isRunnerDisconnect =
        /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(rawMsg);
      const friendlyError =
        crashInfo?.oom
          ? 'The workspace ran out of memory while running publish checks. Restart the workspace and try publishing again.'
          : isRunnerDisconnect
            ? 'Lost connection to the workspace while running publish checks (it may have restarted or run out of memory). Please try again.'
            : rawMsg;
      this.setState(sessionInput.id, 'failed_checks', {
        error: friendlyError,
      });
    } finally {
      this.activePublishes.delete(sessionInput.id);
    }
  }

  async archiveSessionDeterministically(
    sessionId: string,
    runnerUrl: string | null,
    baseBranch: string,
    mergedSha: string | null,
    prUrl: string | null,
  ): Promise<void> {
    const existingArchive = this.db.getSessionArchive(sessionId);
    let transcriptJson = existingArchive?.transcriptJson ?? JSON.stringify({ entries: [], usageUsd: 0 });
    let diffSummary = existingArchive?.diffSummary ?? '[]';
    let fetchedAny = false;
    if (runnerUrl) {
      try {
        const tRes = await fetch(`${runnerUrl}/internal/transcript`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (tRes.ok) {
          transcriptJson = await tRes.text();
          fetchedAny = true;
        }
      } catch {
        // best-effort
      }
      try {
        const cRes = await fetch(
          `${runnerUrl}/internal/git/changes?baseRef=${encodeURIComponent(`origin/${baseBranch}`)}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (cRes.ok) {
          const data = (await cRes.json()) as {
            changes?: Array<{ path: string; status: string; additions: number; deletions: number }>;
          };
          diffSummary = JSON.stringify(
            (data.changes ?? []).map((ch) => ({
              path: ch.path,
              status: ch.status,
              additions: ch.additions,
              deletions: ch.deletions,
            })),
          );
          fetchedAny = true;
        }
      } catch {
        // best-effort
      }
    }
    if (runnerUrl && !fetchedAny && (existingArchive || !mergedSha)) {
      // Do not clobber an existing archive or insert an empty draft archive when the runner was unreachable
      return;
    }
    this.db.upsertSessionArchive({
      sessionId,
      transcriptJson,
      diffSummary,
      mergedSha,
      prUrl,
    });
  }

  async retryDeployCheck(session: SessionRecord): Promise<void> {
    if (!session.merged_sha || !session.pr_number || !session.pr_url) {
      throw new Error('Session does not have a merged commit to verify');
    }
    if (this.activeDeployChecks.has(session.id)) {
      return;
    }
    this.db.upsertPublishRun({
      sessionId: session.id,
      runId: crypto.randomUUID(),
      actorUserId: session.owner_user_id,
      step: 'deploying_pages',
      prNumber: session.pr_number,
      prUrl: session.pr_url,
      mergedSha: session.merged_sha,
    });
    this.setState(session.id, 'deploying_pages', {
      prNumber: session.pr_number,
      prUrl: session.pr_url,
    });
    await this.waitForPagesDeploy(session.id, session.merged_sha, session.pr_number, session.pr_url, {
      initialDelayMs: 0,
    });
  }

  private async waitForCiAndMerge(opts: {
    session: SessionRecord;
    prNumber: number;
    prUrl: string;
    headSha: string;
    commitTitle: string;
    commitMessage: string;
    nativeAutoMerge: boolean;
  }): Promise<string | null> {
    const startedAt = Date.now();
    const deadline = startedAt + 15 * 60_000;
    const ciRegDeadline = startedAt + this.deployPollOptions.ciRegistrationGraceMs;
    let checkedCiPresence = false;
    let hasCiWorkflow = false;

    while (Date.now() < deadline) {
      const prState = await this.github.getPrState(opts.prNumber);
      if (prState.merged && prState.mergeCommitSha) {
        return prState.mergeCommitSha;
      }
      if (prState.state === 'closed') {
        this.setState(opts.session.id, 'failed_ci', {
          prNumber: opts.prNumber,
          prUrl: opts.prUrl,
          error: 'Pull Request was closed before merging.',
        });
        return null;
      }

      if (opts.headSha && prState.headSha && prState.headSha !== opts.headSha) {
        this.setState(opts.session.id, 'failed_ci', {
          prNumber: opts.prNumber,
          prUrl: opts.prUrl,
          error: `Pull Request branch head changed unexpectedly (${prState.headSha.slice(0, 7)} vs verified ${opts.headSha.slice(0, 7)}). Please click Publish again.`,
        });
        return null;
      }

      const targetSha = opts.headSha || prState.headSha;
      const ci = await this.github.checkCommitStatus(targetSha);
      if (ci.state === 'failed') {
        this.setState(opts.session.id, 'failed_ci', {
          prNumber: opts.prNumber,
          prUrl: opts.prUrl,
          error: ci.failedSummary || 'GitHub CI checks failed',
          ciLogs: ci.failedLogs,
        });
        return null;
      }

      let effectiveState = ci.state;
      if (ci.state === 'passed' && ci.totalCount === 0 && Date.now() < ciRegDeadline) {
        if (!checkedCiPresence) {
          checkedCiPresence = true;
          hasCiWorkflow = await this.github.hasActiveCiWorkflow().catch(() => false);
        }
        if (hasCiWorkflow) {
          effectiveState = 'pending';
        }
      }

      if (effectiveState === 'passed' && !opts.nativeAutoMerge) {
        try {
          return await this.github.squashMergePr({
            prNumber: opts.prNumber,
            commitTitle: opts.commitTitle,
            commitMessage: opts.commitMessage,
            headSha: targetSha || undefined,
          });
        } catch {
          // GitHub may still be settling branch protection; retry next poll
        }
      }

      await new Promise((r) => setTimeout(r, this.deployPollOptions.ciPollIntervalMs));
    }

    this.setState(opts.session.id, 'failed_ci', {
      prNumber: opts.prNumber,
      prUrl: opts.prUrl,
      error: 'Timed out waiting for GitHub checks to finish.',
    });
    return null;
  }

  private async markPublished(
    sessionId: string,
    prNumber: number,
    prUrl: string,
    deployUrl?: string,
  ): Promise<void> {
    this.db.deletePublishRun(sessionId);
    const session = this.db.getSession(sessionId);
    this.db.updateSession(sessionId, {
      status: 'published',
      publish_state: 'published',
      archived_at: new Date().toISOString(),
    });
    if (session?.runner_url) {
      await fetch(`${session.runner_url}/internal/read-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readOnly: true }),
      }).catch(() => {});
    }
    const updated = this.db.getSession(sessionId);
    if (updated) {
      await this.driver.stop(updated).catch(() => {});
    }
    this.setState(sessionId, 'published', {
      prNumber,
      prUrl,
      ...(deployUrl ? { deployUrl } : {}),
    });
    this.onSessionMetaUpdated?.(sessionId);
  }

  private failDeploy(
    sessionId: string,
    prNumber: number,
    prUrl: string,
    error: string,
    deployUrl?: string,
  ): void {
    this.db.deletePublishRun(sessionId);
    this.db.updateSession(sessionId, { status: 'merged' });
    this.setState(sessionId, 'failed_deploy', {
      prNumber,
      prUrl,
      error,
      ...(deployUrl ? { deployUrl } : {}),
    });
    this.onSessionMetaUpdated?.(sessionId);
  }

  private async waitForPagesDeploy(
    sessionId: string,
    mergeSha: string,
    prNumber: number,
    prUrl: string,
    overrides?: DeployPollOptions,
  ): Promise<void> {
    if (this.activeDeployChecks.has(sessionId)) {
      return;
    }
    this.activeDeployChecks.add(sessionId);

    const opts = { ...this.deployPollOptions, ...overrides };
    try {
      if (opts.initialDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.initialDelayMs));
      }

      const startedAt = Date.now();
      const deadline = startedAt + opts.timeoutMs;
      const registrationDeadline = startedAt + opts.runRegistrationGraceMs;
      let consecutiveErrors = 0;
      let checkedWorkflowPresence = false;
      let hasDeployWorkflow: boolean | null = null;

      while (Date.now() < deadline) {
        let result;
        try {
          result = await this.github.checkMainDeployStatus(mergeSha);
          consecutiveErrors = 0;
        } catch (err) {
          if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
            const detail =
              err.status === 401 || err.status === 403
                ? 'Changes merged to GitHub, but Halley lacks permission to read GitHub Actions deploy status (check Actions: Read permission).'
                : 'Changes merged to GitHub, but Halley could not find GitHub Actions runs for this repository.';
            this.failDeploy(sessionId, prNumber, prUrl, detail);
            return;
          }
          consecutiveErrors += 1;
          if (consecutiveErrors >= opts.maxConsecutiveErrors) {
            const detail = err instanceof Error ? err.message : 'network error';
            this.failDeploy(
              sessionId,
              prNumber,
              prUrl,
              `Changes merged to GitHub, but checking the live site deploy failed repeatedly (${detail}). Click Retry deploy check in a moment.`,
            );
            return;
          }
          await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
          continue;
        }

        if (result.state === 'deployed') {
          await this.markPublished(sessionId, prNumber, prUrl, result.runUrl);
          return;
        }

        if (result.state === 'failed') {
          const wf = result.workflowName ? ` (${result.workflowName})` : '';
          const conc = result.conclusion ? `: ${result.conclusion}` : '';
          this.failDeploy(
            sessionId,
            prNumber,
            prUrl,
            `Changes merged to GitHub, but the live site deploy workflow${wf} did not succeed${conc}. Editing is locked; you can retry checking deploy status once fixed.`,
            result.runUrl,
          );
          return;
        }

        if (result.state === 'waiting_for_run') {
          if (!checkedWorkflowPresence) {
            checkedWorkflowPresence = true;
            hasDeployWorkflow = await this.github.hasActiveDeployWorkflow().catch(() => null);
            if (hasDeployWorkflow === false) {
              await this.markPublished(sessionId, prNumber, prUrl);
              return;
            }
          }
          if (Date.now() >= registrationDeadline) {
            this.failDeploy(
              sessionId,
              prNumber,
              prUrl,
              'Changes merged to GitHub, but no live site deploy workflow run appeared for this commit. Click Retry deploy check or inspect GitHub Actions.',
            );
            return;
          }
        }

        await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
      }

      // Polling timed out after merge: keep session frozen in 'merged' state so user can retry deploy check
      this.failDeploy(
        sessionId,
        prNumber,
        prUrl,
        'Changes merged to GitHub, but the live site deploy is still taking longer than expected. Click Retry deploy check in a moment.',
      );
    } catch (err) {
      // Never allow post-merge polling errors to escape into failed_checks
      const detail = err instanceof Error ? err.message : 'unexpected error';
      this.failDeploy(
        sessionId,
        prNumber,
        prUrl,
        `Changes merged to GitHub, but verifying the live site deploy encountered an error (${detail}). Click Retry deploy check in a moment.`,
      );
    } finally {
      this.activeDeployChecks.delete(sessionId);
    }
  }
}
