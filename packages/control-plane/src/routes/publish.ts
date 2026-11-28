import crypto from 'node:crypto';
import type { PublishProgressPayload, PublishState, UserDto } from '@halley/shared';
import { realClock, type Clock, type FetchFn, type IdGenerator } from '../clock.js';
import { mapWithConcurrency } from '../concurrency.js';
import { resolveLiveSiteUrl, type HalleyConfig } from '../config.js';
import type { ControlPlaneDb, PublishRunRecord, SessionRecord } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';
import { GitHubApiError, isTransientGitHubError, type GitHubService } from '../github/client.js';
import { ignore, logger } from '../log.js';
import { runWithContext } from '../request-context.js';
import {
  AnyJsonSchema,
  CheckpointResponseSchema,
  ExcludePathsResponseSchema,
  GitChangesHeadSchema,
  FullSyncResponseSchema,
  ProtectedDiffResponseSchema,
  RunnerError,
  SyncStartResponseSchema,
  VerifyResponseSchema,
  createRunnerClient,
  type RunnerClient,
} from '../runner-client.js';

const TRANSIENT_GITHUB_ERROR_MESSAGE =
  'GitHub had a temporary hiccup while publishing your changes. Your edits are safe — please try publishing again in a moment.';

export interface DeployPollOptions {
  initialDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  runRegistrationGraceMs?: number;
  maxConsecutiveErrors?: number;
  /** First CI poll interval; grows ×1.5 per poll up to `ciPollMaxIntervalMs`. */
  ciPollIntervalMs?: number;
  /**
   * While the CI wait is younger than this, the poll interval stays at or below
   * `ciFastPollMaxIntervalMs`: a typical CI run finishes well inside it, and the full backoff
   * would otherwise notice a ~20s run up to ~10s late.
   */
  ciFastPollWindowMs?: number;
  /** Poll interval cap during the fast window. */
  ciFastPollMaxIntervalMs?: number;
  /** Cap for the CI poll backoff (default: min(15s, 10 × ciPollIntervalMs)). */
  ciPollMaxIntervalMs?: number;
  ciRegistrationGraceMs?: number;
  /** How long to wait for PR checks before giving up (default 15 min). */
  ciTimeoutMs?: number;
}

const DEFAULT_DEPLOY_POLL_OPTIONS: Required<DeployPollOptions> = {
  initialDelayMs: 1000,
  pollIntervalMs: 2000,
  timeoutMs: 6 * 60_000,
  runRegistrationGraceMs: 45_000,
  maxConsecutiveErrors: 5,
  ciPollIntervalMs: 1500,
  ciFastPollWindowMs: 60_000,
  ciFastPollMaxIntervalMs: 3000,
  ciPollMaxIntervalMs: 15_000,
  ciRegistrationGraceMs: 15_000,
  ciTimeoutMs: 15 * 60_000,
};

const CI_POLL_BACKOFF_FACTOR = 1.5;

const PRE_PR_STEPS = new Set<PublishState>([
  'rebasing',
  'resolving_conflicts',
  'verifying',
  'pushing_pr',
]);

type CiWaitResult =
  | { kind: 'merged'; mergedSha: string }
  /** The service is shutting down: leave the run as-is so it resumes on restart. */
  | { kind: 'stopped' }
  | {
      kind: 'failed';
      reason: 'closed' | 'head_changed' | 'ci_failed' | 'timeout' | 'error';
      error: string;
      ciLogs?: string;
      prNodeId: string | null;
      /** A transient GitHub failure: the user can simply publish again. */
      retryable?: boolean;
    };

interface PrRunContext {
  runId: string;
  actorUserId: string;
  prNumber: number;
  prUrl: string;
  prNodeId: string | null;
  nativeAutoMerge: boolean;
}

export interface PublishServiceDeps {
  clock?: Clock;
  /** Run-id generator (default crypto.randomUUID). */
  randomUUID?: IdGenerator;
  /** Transport for workspace-runner calls (default: global fetch). */
  fetch?: FetchFn;
}

/** Thrown when the commit that would be pushed is not exactly the one the checks verified. */
export class UnverifiedHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedHeadError';
  }
}

export class PublishService {
  private activePublishes = new Set<string>();
  private activeDeployChecks = new Set<string>();
  private deployPollOptions: Required<DeployPollOptions>;
  private readonly clock: Clock;
  private readonly randomUUID: IdGenerator;
  private readonly runner: RunnerClient;

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private driver: WorkspaceDriver,
    private github: GitHubService,
    private broadcastPublish: (sessionId: string, payload: PublishProgressPayload) => void,
    private onSessionMetaUpdated?: (sessionId: string) => void,
    deployPollOptions?: DeployPollOptions,
    deps: PublishServiceDeps = {},
  ) {
    this.clock = deps.clock ?? realClock;
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.runner = createRunnerClient(deps.fetch, this.clock);
    const merged = { ...DEFAULT_DEPLOY_POLL_OPTIONS, ...deployPollOptions };
    if (deployPollOptions?.ciPollMaxIntervalMs === undefined) {
      merged.ciPollMaxIntervalMs = Math.max(
        merged.ciPollIntervalMs,
        Math.min(DEFAULT_DEPLOY_POLL_OPTIONS.ciPollMaxIntervalMs, merged.ciPollIntervalMs * 10),
      );
    }
    this.deployPollOptions = merged;
  }

  /** Aborted by shutdown(): CI/deploy poll loops exit at their next step without changing state. */
  private readonly stopping = new AbortController();

  /**
   * Graceful shutdown: CI-wait and deploy-check loops stop polling (their publish_runs rows stay,
   * so resumeIncompletePublishes continues them after restart) and no new reconcile work starts.
   */
  shutdown(): void {
    this.stopping.abort();
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

  /** Persists the run's current step (durable resume point) and logs it with the run id. */
  private recordStep(input: Parameters<ControlPlaneDb['upsertPublishRun']>[0]): PublishRunRecord {
    const run = this.db.upsertPublishRun(input);
    logger.info('publish step', {
      sessionId: input.sessionId,
      runId: input.runId,
      step: input.step,
      ...(input.prNumber ? { prNumber: input.prNumber } : {}),
    });
    return run;
  }

  private async rollbackExcludedPathsIfNeeded(
    runnerUrl: string | null,
    preExcludeSha: string | null,
    ctx: { sessionId: string; runId?: string },
  ): Promise<void> {
    if (!runnerUrl || !preExcludeSha) return;
    try {
      await this.runner.callRunner(runnerUrl, '/internal/git/restore-sha', AnyJsonSchema, {
        // workspace-runner reads `targetSha` (the old `sha` key was silently rejected with 400)
        body: { targetSha: preExcludeSha },
        timeoutMs: 15_000,
      });
      logger.info('publish: restored excluded paths', { ...ctx, preExcludeSha });
    } catch (err) {
      logger.error('publish: failed to restore excluded paths; draft may still be missing unchecked files', {
        ...ctx,
        preExcludeSha,
        err,
      });
    }
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
      try {
        this.resumeRun(run);
      } catch (err) {
        logger.error('publish resume: failed to resume run', { sessionId: run.session_id, runId: run.run_id, err });
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

  /**
   * Periodic, cheap reconciliation for runs that were kept because GitHub auto-merge may still be
   * armed after a failed or timed-out publish. One GitHub GET per kept run: when the PR has merged
   * (or closed), hand it to the normal CI-wait path, which records the merge and deploy. Runs that
   * are already being tracked in this process are skipped.
   */
  async reconcileArmedRuns(): Promise<void> {
    for (const run of this.db.listActivePublishRuns()) {
      if (this.stopping.signal.aborted) return;
      // Interrupted pre-PR run whose excluded-paths restore failed earlier: retry it
      if (PublishService.needsExcludeRestore(run) && PRE_PR_STEPS.has(run.step) && !this.isPublishActive(run.session_id)) {
        const session = this.db.getSession(run.session_id);
        if (session) await this.resetInterruptedPrePrRun(session, run);
        continue;
      }
      if (run.step !== 'waiting_ci' || !run.pr_number || !run.pr_url) continue;
      if (this.activePublishes.has(run.session_id) || this.activeDeployChecks.has(run.session_id)) continue;
      const session = this.db.getSession(run.session_id);
      if (!session) continue;
      try {
        const pr = await this.github.getPrState(run.pr_number);
        if (!pr.merged && pr.state === 'open') continue;
        logger.info('publish reconcile: kept PR changed state; resuming', {
          sessionId: run.session_id,
          runId: run.run_id,
          prNumber: run.pr_number,
          merged: pr.merged,
        });
        await this.resumeWaitingCiRun(session, run);
      } catch (err) {
        ignore(err, 'publish reconcile: could not check kept PR', {
          sessionId: run.session_id,
          runId: run.run_id,
        });
      }
    }
  }

  /** Last GitHub check per PR number (manual-merge reconciliation cache). */
  private manualMergeCheckedAt = new Map<number, number>();
  static readonly MANUAL_MERGE_RECHECK_MS = 5 * 60_000;
  static readonly MANUAL_MERGE_MAX_PER_PASS = 20;
  static readonly MANUAL_MERGE_CONCURRENCY = 3;

  /**
   * Maintenance pass: finds Halley PRs merged by hand on GitHub and finalizes them exactly like a
   * Halley publish (merged -> read-only -> deterministic archive -> published -> stop runner).
   * Every session with a PR is covered; GitHub calls are bounded (at most MANUAL_MERGE_MAX_PER_PASS
   * per pass, MANUAL_MERGE_CONCURRENCY in flight) and each PR is re-checked at most once per
   * MANUAL_MERGE_RECHECK_MS. Sessions owned by a live or kept publish run are left to that pipeline.
   */
  async reconcileManualMerges(): Promise<{ checked: number; finalized: number }> {
    if (this.stopping.signal.aborted) return { checked: 0, finalized: 0 };
    const now = this.clock.now();
    const candidates = this.db.listSessionsWithUnmergedPr().filter(
      (s) => !this.isPublishActive(s.id) && !this.db.getPublishRun(s.id),
    );
    const live = new Set(candidates.map((s) => s.pr_number!));
    for (const pr of this.manualMergeCheckedAt.keys()) if (!live.has(pr)) this.manualMergeCheckedAt.delete(pr);
    const due = candidates
      .filter((s) => now - (this.manualMergeCheckedAt.get(s.pr_number!) ?? -Infinity) >= PublishService.MANUAL_MERGE_RECHECK_MS)
      .sort((a, b) => (this.manualMergeCheckedAt.get(a.pr_number!) ?? 0) - (this.manualMergeCheckedAt.get(b.pr_number!) ?? 0))
      .slice(0, PublishService.MANUAL_MERGE_MAX_PER_PASS);
    let finalized = 0;
    await mapWithConcurrency(due, PublishService.MANUAL_MERGE_CONCURRENCY, async (s) => {
      this.manualMergeCheckedAt.set(s.pr_number!, now);
      try {
        const pr = await this.github.getPrState(s.pr_number!);
        if (!pr.merged || !pr.mergeCommitSha) return;
        if (await this.finalizeManualMerge(s, pr.mergeCommitSha)) finalized += 1;
      } catch (err) {
        ignore(err, 'publish reconcile: manual-merge check failed', { sessionId: s.id, prNumber: s.pr_number });
      }
    });
    return { checked: due.length, finalized };
  }

  private async finalizeManualMerge(session: SessionRecord, mergedSha: string): Promise<boolean> {
    if (this.isPublishActive(session.id)) return false;
    this.activeDeployChecks.add(session.id);
    try {
      const merged = this.db.setSessionStatus(session.id, 'merged', {
        merged_sha: mergedSha,
        merged_at: session.merged_at ?? new Date(this.clock.now()).toISOString(),
      });
      if (!merged) return false;
      logger.info('publish reconcile: PR was merged on GitHub; finalizing', {
        sessionId: session.id,
        prNumber: session.pr_number,
        mergedSha,
      });
      this.driver.notifyMirrorUpdated?.(session.base_branch);
      if (session.runner_url) {
        await this.runner
          .callRunner(session.runner_url, '/internal/read-only', AnyJsonSchema, { body: { readOnly: true }, timeoutMs: 10_000 })
          .catch((err) => ignore(err, 'publish reconcile: setting workspace read-only failed', { sessionId: session.id }));
      }
      await this.archiveSessionDeterministically(
        session.id,
        session.runner_url,
        session.base_branch,
        mergedSha,
        session.pr_url,
      );
      await this.markPublished(session.id, session.pr_number!, session.pr_url ?? '');
      return true;
    } finally {
      this.activeDeployChecks.delete(session.id);
    }
  }

  private resumeRun(run: PublishRunRecord): void {
    const session = this.db.getSession(run.session_id);
    if (!session) {
      this.db.deletePublishRun(run.session_id);
      return;
    }

    if (session.status === 'published') {
      this.db.deletePublishRun(run.session_id);
      return;
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
      logger.info('publish resume: deploy check', { sessionId: session.id, runId: run.run_id, prNumber });
      void this.waitForPagesDeploy(session.id, mergeSha, prNumber, prUrl, { initialDelayMs: 0 });
      return;
    }

    if (run.pr_number && run.pr_url && (run.step === 'waiting_ci' || run.step === 'pushing_pr')) {
      logger.info('publish resume: CI wait', { sessionId: session.id, runId: run.run_id, prNumber: run.pr_number });
      void this.resumeWaitingCiRun(session, run);
      return;
    }

    if (run.step === 'pushing_pr' && session.status !== 'merged') {
      // The process may have died after GitHub created the PR (and armed auto-merge) but before we
      // persisted its number: look it up instead of forgetting a PR that can merge on its own.
      void this.adoptOrphanedPrOrReset(session, run);
      return;
    }

    // Interrupted before a PR was created: restore excluded paths (if the exclude commit was made and
    // the branch never pushed), then drop the run record and reset publish_state to idle
    void this.resetInterruptedPrePrRun(session, run);
  }

  /** The run made an exclude-paths commit and was interrupted before the branch was pushed. */
  private static needsExcludeRestore(run: PublishRunRecord): boolean {
    return Boolean(run.pre_exclude_sha) && !run.local_head_sha && !run.pr_number;
  }

  /** Give up restoring excluded paths for a run this old (the workspace is likely gone for good). */
  static readonly EXCLUDE_RESTORE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

  /**
   * Resets a pre-PR run interrupted by a restart. When the run excluded paths, restore-sha runs
   * first (best effort); if the runner is unreachable the run is kept (session stays locked) and
   * `reconcileArmedRuns` retries on its next pass, so unchecked files are never silently dropped.
   */
  private async resetInterruptedPrePrRun(session: SessionRecord, run: PublishRunRecord): Promise<void> {
    if (this.activePublishes.has(session.id)) return;
    this.activePublishes.add(session.id);
    try {
      if (PublishService.needsExcludeRestore(run)) {
        const ctx = { sessionId: session.id, runId: run.run_id, preExcludeSha: run.pre_exclude_sha };
        try {
          const ep = await this.driver.ensureRunning(session);
          await this.runner.callRunner(ep.runnerUrl, '/internal/git/restore-sha', AnyJsonSchema, {
            body: { targetSha: run.pre_exclude_sha },
            timeoutMs: 15_000,
          });
          logger.info('publish resume: restored excluded paths of interrupted run', ctx);
        } catch (err) {
          const ageMs = this.clock.now() - new Date(run.updated_at).getTime();
          if (ageMs < PublishService.EXCLUDE_RESTORE_GIVE_UP_MS) {
            logger.warn('publish resume: restoring excluded paths failed; keeping run to retry', { ...ctx, err });
            return;
          }
          logger.error('publish resume: giving up restoring excluded paths; draft may be missing unchecked files', {
            ...ctx,
            ageMs,
            err,
          });
        }
      }
      // A new publish may have replaced the row meanwhile: only drop the run we were resetting
      if (this.db.getPublishRun(session.id)?.run_id !== run.run_id) return;
      this.db.deletePublishRun(session.id);
      const cur = this.db.getSession(session.id) ?? session;
      if (cur.status !== 'merged') {
        this.db.updateSession(session.id, { publish_state: 'idle', publish_error: null });
      }
    } finally {
      this.activePublishes.delete(session.id);
    }
  }

  private async adoptOrphanedPrOrReset(session: SessionRecord, run: PublishRunRecord): Promise<void> {
    if (this.activePublishes.has(session.id)) return;
    this.activePublishes.add(session.id);
    let adoptedRun: PublishRunRecord | null = null;
    try {
      const pr = await this.github.findOpenPrForBranch(session.working_branch);
      // Only adopt a PR this run touched (push/PATCH bump updated_at); an older PR from a previous
      // abandoned attempt may carry stale content.
      const touchedByThisRun =
        pr && (!pr.updatedAt || new Date(pr.updatedAt).getTime() >= new Date(run.updated_at).getTime() - 60_000);
      if (pr && touchedByThisRun) {
        logger.warn('publish resume: adopting PR opened before restart', {
          sessionId: session.id,
          runId: run.run_id,
          prNumber: pr.number,
        });
        adoptedRun = this.recordStep({
          sessionId: session.id,
          runId: run.run_id,
          actorUserId: run.actor_user_id,
          step: 'waiting_ci',
          localHeadSha: pr.headSha,
          prNumber: pr.number,
          prUrl: pr.url,
        });
        this.setState(session.id, 'waiting_ci', { prNumber: pr.number, prUrl: pr.url });
      } else if (pr) {
        logger.warn('publish resume: open PR predates interrupted run; not adopting', {
          sessionId: session.id,
          runId: run.run_id,
          prNumber: pr.number,
        });
      }
    } catch (err) {
      logger.error('publish resume: could not look up PR for interrupted run; resetting to idle', {
        sessionId: session.id,
        runId: run.run_id,
        err,
      });
    } finally {
      this.activePublishes.delete(session.id);
    }

    try {
      if (adoptedRun) {
        await this.resumeWaitingCiRun(this.db.getSession(session.id) ?? session, adoptedRun);
        return;
      }
      await this.resetInterruptedPrePrRun(this.db.getSession(session.id) ?? session, run);
    } catch (err) {
      logger.error('publish resume: reset failed', { sessionId: session.id, runId: run.run_id, err });
    }
  }

  private async resumeWaitingCiRun(session: SessionRecord, run: PublishRunRecord): Promise<void> {
    if (this.activePublishes.has(session.id)) return;
    this.activePublishes.add(session.id);
    const prCtx: PrRunContext = {
      runId: run.run_id,
      actorUserId: run.actor_user_id,
      prNumber: run.pr_number!,
      prUrl: run.pr_url!,
      prNodeId: null,
      nativeAutoMerge: run.native_auto_merge === 1,
    };
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

      if (session.publish_state !== 'waiting_ci') {
        this.setState(session.id, 'waiting_ci', { prNumber: prCtx.prNumber, prUrl: prCtx.prUrl });
      }
      const result = await this.waitForCiAndMerge({
        session,
        runId: run.run_id,
        prNumber: prCtx.prNumber,
        prUrl: prCtx.prUrl,
        headSha: run.local_head_sha || '',
        commitTitle: prTitle,
        commitMessage: commitMsg,
        nativeAutoMerge: prCtx.nativeAutoMerge,
      });
      if (result.kind === 'stopped') return;
      if (result.kind === 'failed') {
        await this.handleCiFailure(session.id, { ...prCtx, prNodeId: result.prNodeId }, result);
        return;
      }

      await this.finalizeMergeAndAwaitDeploy(
        session,
        session.runner_url,
        result.mergedSha,
        prCtx.prNumber,
        prCtx.prUrl,
        run.run_id,
        actor.id,
      );
    } catch (err) {
      const transient = isTransientGitHubError(err);
      await this.handleCiFailure(session.id, prCtx, {
        kind: 'failed',
        reason: 'error',
        error: transient
          ? TRANSIENT_GITHUB_ERROR_MESSAGE
          : err instanceof Error
            ? err.message
            : 'Failed resuming CI check after restart',
        prNodeId: null,
        ...(transient ? { retryable: true } : {}),
      });
    } finally {
      this.activePublishes.delete(session.id);
    }
  }

  /**
   * A publish failed while a PR exists. Never silently leave a PR that GitHub will merge on its
   * own with no record: on CI failure / unexpected head change, disarm native auto-merge; if
   * auto-merge may still be armed (timeout, errors, or disarm failed), keep the publish run row
   * (with pr_number on the session) so restart-resume reconciles a later merge.
   */
  private async handleCiFailure(
    sessionId: string,
    pr: PrRunContext,
    failure: Extract<CiWaitResult, { kind: 'failed' }>,
  ): Promise<void> {
    try {
      let autoMergeArmed = pr.nativeAutoMerge && failure.reason !== 'closed';
      let note = '';
      if (autoMergeArmed && (failure.reason === 'ci_failed' || failure.reason === 'head_changed')) {
        let nodeId = pr.prNodeId;
        if (!nodeId) {
          nodeId = await this.github
            .getPrState(pr.prNumber)
            .then((s) => s.nodeId)
            .catch((err) => {
              ignore(err, 'publish: could not read PR node id to disable auto-merge', { sessionId, runId: pr.runId });
              return null;
            });
        }
        if (nodeId && (await this.github.tryDisableNativeAutoMerge(nodeId))) {
          autoMergeArmed = false;
          note = ' Auto-merge was turned off for this pull request.';
          logger.info('publish: disabled native auto-merge after failure', {
            sessionId,
            runId: pr.runId,
            prNumber: pr.prNumber,
            reason: failure.reason,
          });
        }
      }

      if (autoMergeArmed) {
        // Keep tracking: resumeIncompletePublishes() picks this row up and reconciles the merge.
        this.db.upsertPublishRun({
          sessionId,
          runId: pr.runId,
          actorUserId: pr.actorUserId,
          step: 'waiting_ci',
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          nativeAutoMerge: true,
          error: failure.error,
        });
        logger.warn('publish failed with GitHub auto-merge still armed; keeping run for reconciliation', {
          sessionId,
          runId: pr.runId,
          prNumber: pr.prNumber,
          reason: failure.reason,
          error: failure.error,
        });
      } else {
        this.db.deletePublishRun(sessionId);
        logger.warn('publish failed after PR was opened', {
          sessionId,
          runId: pr.runId,
          prNumber: pr.prNumber,
          reason: failure.reason,
          error: failure.error,
        });
      }
      this.setState(sessionId, 'failed_ci', {
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        error: `${failure.error}${note}`,
        ...(failure.ciLogs ? { ciLogs: failure.ciLogs } : {}),
        ...(failure.retryable ? { retryable: true } : {}),
      });
    } catch (err) {
      logger.error('publish: recording CI failure failed', { sessionId, runId: pr.runId, err });
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
    const mergedAt = new Date(this.clock.now()).toISOString();
    const merged = this.db.setSessionStatus(session.id, 'merged', {
      merged_sha: mergedSha,
      merged_at: mergedAt,
    });
    if (!merged) {
      logger.warn('publish: session refused transition to merged (already published?)', {
        sessionId: session.id,
        runId,
      });
    }
    this.driver.notifyMirrorUpdated?.(session.base_branch);
    if (runnerUrl) {
      await this.runner.callRunner(runnerUrl, '/internal/read-only', AnyJsonSchema, {
        body: { readOnly: true },
        timeoutMs: 10_000,
      }).catch((err) => ignore(err, 'publish: setting workspace read-only after merge failed', { sessionId: session.id, runId }));
    }
    await this.archiveSessionDeterministically(
      session.id,
      runnerUrl,
      session.base_branch,
      mergedSha,
      prUrl,
    );

    this.recordStep({
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

  /** Fails the run before any PR exists: restore excluded paths, drop the run, surface the reason. */
  private async failBeforePr(
    sessionId: string,
    runId: string,
    runnerUrl: string | null,
    preExcludeSha: string | null,
    state: PublishState,
    extra: Partial<PublishProgressPayload>,
  ): Promise<void> {
    await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha, { sessionId, runId });
    this.db.deletePublishRun(sessionId);
    logger.warn('publish failed', { sessionId, runId, state, error: extra.error });
    this.setState(sessionId, state, extra);
  }

  /**
   * Reads the runner's current HEAD commit. Prefers an explicit `headSha` field (newer runners) and
   * falls back to the newest first-parent checkpoint listed by /internal/git/changes.
   */
  private async readRunnerHead(runnerUrl: string, baseBranch: string): Promise<string | null> {
    const data = await this.runner.callRunner(
      runnerUrl,
      `/internal/git/changes?baseRef=${encodeURIComponent(`origin/${baseBranch}`)}`,
      GitChangesHeadSchema,
      { method: 'GET', timeoutMs: 15_000 },
    );
    return data.headSha || data.checkpoints?.[0]?.sha || null;
  }

  /**
   * GitHub updates an existing PR's head asynchronously after a push: re-read it briefly before
   * concluding it does not point at the verified commit.
   */
  private async awaitPrHead(prNumber: number, expectedSha: string, lastSeen: string): Promise<string> {
    let head = lastSeen;
    for (let attempt = 1; attempt <= 5 && head !== expectedSha; attempt++) {
      await this.clock.sleep(500 * attempt);
      try {
        head = (await this.github.getPrState(prNumber)).headSha;
      } catch (err) {
        ignore(err, 'publish: re-reading PR head failed', { prNumber, attempt });
      }
    }
    return head;
  }

  /**
   * Squash-merges a freshly opened PR without waiting for its CI (HALLEY_PUBLISH_SKIP_CI). The
   * merge is pinned to the verified commit. Returns the merge commit, or null when GitHub refuses
   * so the caller can wait for CI instead. GitHub computes mergeability asynchronously after a PR
   * is opened, so a bare "not mergeable" 405 is retried briefly; a refusal that names a branch
   * rule is not.
   */
  private async tryMergeWithoutCi(
    prNumber: number,
    headSha: string,
    commitTitle: string,
    commitMessage: string,
    ctx: { sessionId: string; runId: string },
  ): Promise<string | null> {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.github.squashMergePr({ prNumber, commitTitle, commitMessage, headSha });
      } catch (err) {
        const settling =
          err instanceof GitHubApiError &&
          err.status === 405 &&
          !/required|protected|review|rule|status check/i.test(err.message);
        if (!settling || attempt === maxAttempts || this.stopping.signal.aborted) {
          logger.warn('publish: merging without waiting for CI was refused; waiting for CI instead', {
            ...ctx,
            prNumber,
            attempt,
            err,
          });
          return null;
        }
        await this.clock.sleep(400 * attempt, this.stopping.signal);
      }
    }
    return null;
  }

  /** Never rejects: callers fire-and-forget (`void publish(...)`). */
  async publish(
    sessionInput: SessionRecord,
    actor: UserDto,
    input: { title?: string; summary?: string; excludePaths?: string[] },
  ): Promise<void> {
    if (this.activePublishes.has(sessionInput.id)) {
      return;
    }
    this.activePublishes.add(sessionInput.id);
    const runId = this.randomUUID();
    // Every log line and supervisor/runner call made for this run carries its runId
    return runWithContext({ runId }, () => this.publishRun(sessionInput, actor, input, runId));
  }

  private async publishRun(
    sessionInput: SessionRecord,
    actor: UserDto,
    input: { title?: string; summary?: string; excludePaths?: string[] },
    runId: string,
  ): Promise<void> {
    let runnerUrl: string | null = null;
    let preExcludeSha: string | null = null;
    // Set once a PR exists: failures after this point go through handleCiFailure instead.
    let prCtx: PrRunContext | null = null;

    try {
      this.recordStep({
        sessionId: sessionInput.id,
        runId,
        actorUserId: actor.id,
        title: input.title ?? null,
        summary: input.summary ?? null,
        excludePathsJson: input.excludePaths?.length ? JSON.stringify(input.excludePaths) : null,
        step: 'rebasing',
      });

      let session = this.db.getSession(sessionInput.id) ?? sessionInput;
      const endpoint = await this.driver.ensureRunning(session);
      runnerUrl = endpoint.runnerUrl;

      // 0. Commit any pending inline/working-tree edits so HEAD has the exact draft state
      const ckptData = await this.runner.callRunner(runnerUrl, '/internal/git/checkpoint', CheckpointResponseSchema, {
        body: { summary: 'Ready to publish' },
        timeoutMs: 20_000,
      });
      if (session.kind === 'revert' && ckptData.checkpoint) {
        const converted = this.db.convertRevertSession(session.id);
        if (converted) {
          session = converted;
          this.onSessionMetaUpdated?.(session.id);
        }
      }

      // 0b. Transactionally exclude unchecked paths (restored automatically if pre-push checks fail)
      if (input.excludePaths && input.excludePaths.length > 0) {
        const exclData = await this.runner.callRunner(runnerUrl, '/internal/git/exclude-paths', ExcludePathsResponseSchema, {
          body: {
            paths: input.excludePaths,
            baseRef: `origin/${session.base_branch}`,
          },
          timeoutMs: 25_000,
        }).catch((err: unknown) => {
          throw new Error(
            err instanceof RunnerError && err.kind === 'http'
              ? err.message
              : `Failed to apply excluded file selection: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
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
        this.recordStep({
          sessionId: session.id,
          runId,
          actorUserId: actor.id,
          step: 'rebasing',
          preExcludeSha,
        });
      }

      // 1. Sync with latest base branch FIRST (fail closed if fetch fails!)
      this.setState(session.id, 'rebasing');
      const ghToken = await this.github.getAccessToken().catch((err) => {
        ignore(err, 'publish: no GitHub access token', { sessionId: session.id, runId });
        return '';
      });
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

      // A non-2xx (e.g. 409 "Pi is busy", 502 sync failure) throws RunnerError → fail closed below.
      const syncData = await this.runner.callRunner(runnerUrl, '/internal/sync/start', SyncStartResponseSchema, {
        body: {
          baseBranch: session.base_branch,
          kind: 'publish',
          autoSyncOnly: true,
          skipFetch: fetchedByDriver,
        },
        timeoutMs: 55_000,
      });

      if (syncData.heldForUser) {
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha, { sessionId: session.id, runId });
        preExcludeSha = null;
        const fullSyncData = await this.runner.callRunner(runnerUrl, '/internal/sync/start', FullSyncResponseSchema, {
          body: {
            baseBranch: session.base_branch,
            kind: 'publish',
            autoSyncOnly: false,
            skipFetch: true,
          },
          timeoutMs: 55_000,
        }).catch((err) => {
          ignore(err, 'publish: full sync for conflict review failed', { sessionId: session.id, runId });
          return null;
        });
        if (fullSyncData?.review?.newBaseSha && fullSyncData.review.status !== 'needs_choices') {
          this.db.updateSession(session.id, {
            prev_base_sha: fullSyncData.review.prevBaseSha ?? (session.base_sha || null),
            base_sha: fullSyncData.review.newBaseSha,
          });
        }
        await this.failBeforePr(session.id, runId, runnerUrl, null, 'failed_conflict', {
          error:
            'Someone else updated the same page while you were publishing. Please review the combined changes before publishing.',
        });
        return;
      }

      const review = syncData.review!;
      if (review.newBaseSha && review.status !== 'needs_choices') {
        this.db.updateSession(session.id, {
          prev_base_sha: review.prevBaseSha ?? (session.base_sha || null),
          base_sha: review.newBaseSha,
        });
      }

      if (review.status === 'ready_for_review' || review.status === 'needs_choices') {
        await this.failBeforePr(session.id, runId, runnerUrl, preExcludeSha, 'failed_conflict', {
          conflictedFiles: review.touchedUserFiles,
          error:
            'Someone just published an update to a page you edited. Please double-check Live vs Draft and click Publish again.',
        });
        preExcludeSha = null;
        return;
      }

      // 2. Hard-gate verification checks ONCE on the synced tree (hits verify-sandbox / tree-SHA cache)
      this.recordStep({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        step: 'verifying',
      });
      this.setState(session.id, 'verifying');
      // Pin the exact commit being verified: whatever is pushed later must be this commit.
      const headBeforeVerify = await this.readRunnerHead(runnerUrl, session.base_branch);
      const verifyData = await this.runner.callRunner(runnerUrl, '/internal/verify', VerifyResponseSchema, {
        body: { pausePreview: false },
        timeoutMs: 180_000,
      });
      if (!verifyData.allPassed) {
        const failed = verifyData.results.filter((r) => !r.passed);
        await this.failBeforePr(session.id, runId, runnerUrl, preExcludeSha, 'failed_checks', {
          checks: verifyData.results as PublishProgressPayload['checks'],
          error: `Checks failed: ${failed.map((f) => f.name).join(', ') || 'unknown'}`,
        });
        preExcludeSha = null;
        return;
      }

      // 3. Layer-3 .github/** hard gate before pushing
      const protData = await this.runner.callRunner(
        runnerUrl,
        `/internal/git/protected-diff?baseRef=${encodeURIComponent(`origin/${session.base_branch}`)}`,
        ProtectedDiffResponseSchema,
        { method: 'GET', timeoutMs: 15_000 },
      );
      if (!protData.clean) {
        await this.failBeforePr(session.id, runId, runnerUrl, preExcludeSha, 'failed_checks', {
          error: `Blocked: protected .github/** files were modified (${protData.protectedFiles.join(', ')}).`,
        });
        preExcludeSha = null;
        return;
      }

      // Edits made while checks ran must not ship unverified. Commit anything pending: if that
      // creates a checkpoint, or HEAD moved, the verified tree is no longer what would be pushed.
      const postVerifyCkpt = await this.runner.callRunner(runnerUrl, '/internal/git/checkpoint', CheckpointResponseSchema, {
        body: { summary: 'Edits made during publish checks' },
        timeoutMs: 20_000,
      });
      const headAfterVerify = await this.readRunnerHead(runnerUrl, session.base_branch);
      const verifiedSha = verifyData.headSha || headBeforeVerify;
      if (!verifiedSha) {
        throw new UnverifiedHeadError('Could not determine which draft commit the publish checks verified. Please try again.');
      }
      if (postVerifyCkpt.checkpoint || headAfterVerify !== verifiedSha) {
        logger.warn('publish: draft changed while checks were running; refusing to push unverified commit', {
          sessionId: session.id,
          runId,
          verifiedSha,
          headAfterVerify,
          newCheckpoint: Boolean(postVerifyCkpt.checkpoint),
        });
        await this.failBeforePr(session.id, runId, runnerUrl, preExcludeSha, 'failed_checks', {
          error: 'The draft changed while publish checks were running. Click Publish again to check and publish the latest version.',
        });
        preExcludeSha = null;
        return;
      }

      // 4. Push branch & open/update PR
      this.recordStep({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        step: 'pushing_pr',
      });
      this.setState(session.id, 'pushing_pr');
      if (!ghToken && !this.config.devLocalRepo) {
        throw new Error('GitHub credentials are not configured for pushing');
      }
      // The driver pushes exactly `verifiedSha` and refuses if the branch it received differs
      await this.driver.pushSessionBranch(session, ghToken, { sha: verifiedSha });
      preExcludeSha = null; // Branch pushed cleanly; do not roll back exclude commit anymore
      this.recordStep({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        step: 'pushing_pr',
        localHeadSha: verifiedSha,
      });

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

      // Persist the PR BEFORE arming auto-merge: if we die in between, resume finds the PR via
      // the run row / session instead of resetting to idle and orphaning a self-merging PR.
      this.recordStep({
        sessionId: session.id,
        runId,
        actorUserId: actor.id,
        title: prTitle,
        summary: input.summary ?? null,
        step: 'waiting_ci',
        localHeadSha: verifiedSha,
        prNumber: pr.number,
        prUrl: pr.url,
      });
      this.setState(session.id, 'waiting_ci', {
        prNumber: pr.number,
        prUrl: pr.url,
      });
      prCtx = {
        runId,
        actorUserId: actor.id,
        prNumber: pr.number,
        prUrl: pr.url,
        prNodeId: pr.nodeId,
        nativeAutoMerge: false,
      };
      const prHead = pr.headSha === verifiedSha ? pr.headSha : await this.awaitPrHead(pr.number, verifiedSha, pr.headSha);
      if (prHead !== verifiedSha) {
        // Fail closed before arming auto-merge: the PR does not point at the verified commit
        throw new UnverifiedHeadError(
          `The pull request head (${prHead.slice(0, 7)}) is not the verified commit (${verifiedSha.slice(0, 7)}). Please click Publish again.`,
        );
      }

      const commitMsg = `${prBody}\n\nCo-authored-by: ${actor.name} <${actor.email}>`;

      // Optional fast path: the exact commit already passed the local checks, so merge it now
      // instead of waiting for the PR's CI run to repeat them. A refusal (e.g. branch protection
      // requiring status checks) falls through to the normal wait-for-CI path below.
      if (this.config.publishSkipCi) {
        const mergedSha = await this.tryMergeWithoutCi(pr.number, verifiedSha, prTitle, commitMsg, {
          sessionId: session.id,
          runId,
        });
        if (mergedSha) {
          await this.finalizeMergeAndAwaitDeploy(session, runnerUrl, mergedSha, pr.number, pr.url, runId, actor.id);
          return;
        }
      }

      const nativeAutoMerge = await this.github.tryEnableNativeAutoMerge(
        pr.nodeId,
        prTitle,
        commitMsg,
      );
      prCtx.nativeAutoMerge = nativeAutoMerge;
      if (nativeAutoMerge) {
        this.db.upsertPublishRun({
          sessionId: session.id,
          runId,
          actorUserId: actor.id,
          step: 'waiting_ci',
          nativeAutoMerge: true,
        });
      }

      // 5. Watch CI & auto-merge (squash) when checks pass
      const result = await this.waitForCiAndMerge({
        session,
        runId,
        prNumber: pr.number,
        prUrl: pr.url,
        headSha: verifiedSha,
        commitTitle: prTitle,
        commitMessage: commitMsg,
        nativeAutoMerge,
      });
      if (result.kind === 'stopped') return;
      if (result.kind === 'failed') {
        await this.handleCiFailure(session.id, { ...prCtx, prNodeId: result.prNodeId ?? pr.nodeId }, result);
        return;
      }

      // 6. Freeze editing immediately in 'merged' state and watch GitHub Pages deploy
      await this.finalizeMergeAndAwaitDeploy(
        session,
        runnerUrl,
        result.mergedSha,
        pr.number,
        pr.url,
        runId,
        actor.id,
      );
    } catch (err) {
      try {
        const rawMsg = err instanceof Error ? err.message : 'Publish failed unexpectedly';
        if (prCtx) {
          // A PR exists (maybe with auto-merge armed): track it rather than forgetting it.
          const transientGitHub = !(err instanceof RunnerError) && isTransientGitHubError(err);
          await this.handleCiFailure(sessionInput.id, prCtx, {
            kind: 'failed',
            reason: 'error',
            error: transientGitHub ? TRANSIENT_GITHUB_ERROR_MESSAGE : rawMsg,
            prNodeId: prCtx.prNodeId,
            ...(transientGitHub ? { retryable: true } : {}),
          });
          return;
        }
        logger.error('publish failed', { sessionId: sessionInput.id, runId, err });
        await this.rollbackExcludedPathsIfNeeded(runnerUrl, preExcludeSha, { sessionId: sessionInput.id, runId });
        this.db.deletePublishRun(sessionInput.id);
        const crashInfo = this.driver.getCrashInfo?.(sessionInput.id);
        const isTransientGitHubApi = err instanceof GitHubApiError && isTransientGitHubError(err);
        const isRunnerDisconnect =
          !isTransientGitHubApi &&
          ((err instanceof RunnerError && (err.kind === 'network' || err.kind === 'timeout')) ||
            /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(rawMsg));
        // Any other network-level failure outside the runner client came from GitHub
        const isTransientGitHub =
          isTransientGitHubApi || (!isRunnerDisconnect && !(err instanceof RunnerError) && isTransientGitHubError(err));
        const friendlyError =
          crashInfo?.oom
            ? 'The workspace ran out of memory while running publish checks. Restart the workspace and try publishing again.'
            : isTransientGitHub
              ? TRANSIENT_GITHUB_ERROR_MESSAGE
              : isRunnerDisconnect
                ? 'Lost connection to the workspace while running publish checks (it may have restarted or run out of memory). Please try again.'
                : rawMsg;
        this.setState(sessionInput.id, 'failed_checks', {
          error: friendlyError,
          ...(isTransientGitHub || isRunnerDisconnect ? { retryable: true } : {}),
        });
      } catch (handlerErr) {
        // e.g. the DB was closed during shutdown: never let publish() reject (callers void it)
        logger.error('publish: failure handling itself failed', {
          sessionId: sessionInput.id,
          runId,
          err: handlerErr,
          originalError: err instanceof Error ? err.message : String(err),
        });
      }
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
        const tRes = await this.runner.runnerFetch(`${runnerUrl}/internal/transcript`, {
          signal: this.clock.timeoutSignal(15_000),
        });
        if (tRes.ok) {
          transcriptJson = await tRes.text();
          fetchedAny = true;
        }
      } catch (err) {
        ignore(err, 'publish: fetching transcript for archive failed', { sessionId });
      }
      try {
        const cRes = await this.runner.runnerFetch(
          `${runnerUrl}/internal/git/changes?baseRef=${encodeURIComponent(`origin/${baseBranch}`)}`,
          { signal: this.clock.timeoutSignal(15_000) },
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
      } catch (err) {
        ignore(err, 'publish: fetching diff summary for archive failed', { sessionId });
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
      runId: this.randomUUID(),
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

  /**
   * Polls PR + checks until merged/failed. Polling stays quick (≤ ciFastPollMaxIntervalMs) for the
   * first ciFastPollWindowMs, then backs off (×1.5 up to ciPollMaxIntervalMs) so a 15-minute wait
   * costs ~80 polls instead of ~600, and transient GitHub errors are tolerated up
   * to `maxConsecutiveErrors` (auth/404 errors fail immediately). Never throws.
   */
  private async waitForCiAndMerge(opts: {
    session: SessionRecord;
    runId: string;
    prNumber: number;
    prUrl: string;
    headSha: string;
    commitTitle: string;
    commitMessage: string;
    nativeAutoMerge: boolean;
  }): Promise<CiWaitResult> {
    const startedAt = this.clock.now();
    const deadline = startedAt + this.deployPollOptions.ciTimeoutMs;
    const ciRegDeadline = startedAt + this.deployPollOptions.ciRegistrationGraceMs;
    const maxInterval = this.deployPollOptions.ciPollMaxIntervalMs;
    const fastUntil = startedAt + this.deployPollOptions.ciFastPollWindowMs;
    const fastMaxInterval = Math.min(
      maxInterval,
      Math.max(this.deployPollOptions.ciPollIntervalMs, this.deployPollOptions.ciFastPollMaxIntervalMs),
    );
    let interval = this.deployPollOptions.ciPollIntervalMs;
    let checkedCiPresence = false;
    let hasCiWorkflow = false;
    let consecutiveErrors = 0;
    let prNodeId: string | null = null;
    const ctx = { sessionId: opts.session.id, runId: opts.runId, prNumber: opts.prNumber };
    const fail = (
      reason: Extract<CiWaitResult, { kind: 'failed' }>['reason'],
      error: string,
      ciLogs?: string,
      retryable?: boolean,
    ): CiWaitResult => ({ kind: 'failed', reason, error, ciLogs, prNodeId, ...(retryable ? { retryable } : {}) });

    while (this.clock.now() < deadline) {
      if (this.stopping.signal.aborted) return { kind: 'stopped' };
      try {
        const prState = await this.github.getPrState(opts.prNumber);
        prNodeId = prState.nodeId ?? prNodeId;
        if (prState.merged && prState.mergeCommitSha) {
          return { kind: 'merged', mergedSha: prState.mergeCommitSha };
        }
        if (prState.state === 'closed') {
          return fail('closed', 'Pull Request was closed before merging.');
        }

        if (opts.headSha && prState.headSha && prState.headSha !== opts.headSha) {
          return fail(
            'head_changed',
            `Pull Request branch head changed unexpectedly (${prState.headSha.slice(0, 7)} vs verified ${opts.headSha.slice(0, 7)}). Please click Publish again.`,
          );
        }

        const targetSha = opts.headSha || prState.headSha;
        const ci = await this.github.checkCommitStatus(targetSha);
        consecutiveErrors = 0;
        if (ci.state === 'failed') {
          return fail('ci_failed', ci.failedSummary || 'GitHub CI checks failed', ci.failedLogs);
        }

        let effectiveState = ci.state;
        if (ci.state === 'passed' && ci.totalCount === 0 && this.clock.now() < ciRegDeadline) {
          if (!checkedCiPresence) {
            checkedCiPresence = true;
            hasCiWorkflow = await this.github.hasActiveCiWorkflow().catch((err) => {
              ignore(err, 'publish: could not list CI workflows', ctx);
              return false;
            });
          }
          if (hasCiWorkflow) {
            effectiveState = 'pending';
          }
        }

        if (effectiveState === 'passed' && !opts.nativeAutoMerge) {
          try {
            return {
              kind: 'merged',
              mergedSha: await this.github.squashMergePr({
                prNumber: opts.prNumber,
                commitTitle: opts.commitTitle,
                commitMessage: opts.commitMessage,
                headSha: targetSha || undefined,
              }),
            };
          } catch (err) {
            // GitHub may still be settling branch protection; retry next poll
            logger.warn('publish: squash merge attempt failed; retrying next poll', { ...ctx, err });
          }
        }
      } catch (err) {
        if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
          return fail('error', `Could not check the pull request on GitHub: ${err.message}`);
        }
        consecutiveErrors += 1;
        logger.warn('publish: transient error while waiting for CI', { ...ctx, consecutiveErrors, err });
        if (consecutiveErrors >= this.deployPollOptions.maxConsecutiveErrors) {
          if (isTransientGitHubError(err)) {
            // GitHub outage / rate limiting outlasted the poll tolerance: nothing is wrong with the edit
            return fail('error', TRANSIENT_GITHUB_ERROR_MESSAGE, undefined, true);
          }
          return fail(
            'error',
            `Checking GitHub CI failed repeatedly (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
      }

      const remaining = deadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(Math.min(interval, remaining), this.stopping.signal);
      interval = Math.min(
        this.clock.now() < fastUntil ? fastMaxInterval : maxInterval,
        Math.round(interval * CI_POLL_BACKOFF_FACTOR),
      );
    }

    if (this.stopping.signal.aborted) return { kind: 'stopped' };
    return fail('timeout', 'Timed out waiting for GitHub checks to finish.');
  }

  private async markPublished(
    sessionId: string,
    prNumber: number,
    prUrl: string,
    deployUrl?: string,
  ): Promise<void> {
    const session = this.db.getSession(sessionId);
    this.db.transaction(() => {
      this.db.deletePublishRun(sessionId);
      this.db.setSessionStatus(sessionId, 'published', {
        publish_state: 'published',
        archived_at: new Date(this.clock.now()).toISOString(),
      });
    });
    logger.info('publish: published', { sessionId, prNumber });
    if (session?.runner_url) {
      await this.runner.callRunner(session.runner_url, '/internal/read-only', AnyJsonSchema, {
        body: { readOnly: true },
        timeoutMs: 10_000,
      }).catch((err) => ignore(err, 'publish: setting workspace read-only failed', { sessionId }));
    }
    const updated = this.db.getSession(sessionId);
    if (updated) {
      await this.driver
        .stop(updated)
        .catch((err) => ignore(err, 'publish: stopping published workspace failed', { sessionId }));
    }
    const liveSiteUrl = resolveLiveSiteUrl(this.config);
    this.setState(sessionId, 'published', {
      prNumber,
      prUrl,
      ...(deployUrl ? { deployUrl } : {}),
      ...(liveSiteUrl ? { liveSiteUrl } : {}),
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
    this.db.transaction(() => {
      this.db.deletePublishRun(sessionId);
      this.db.setSessionStatus(sessionId, 'merged');
    });
    logger.warn('publish: deploy check failed', { sessionId, prNumber, error });
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
        await this.clock.sleep(opts.initialDelayMs, this.stopping.signal);
      }

      const startedAt = this.clock.now();
      const deadline = startedAt + opts.timeoutMs;
      const registrationDeadline = startedAt + opts.runRegistrationGraceMs;
      let consecutiveErrors = 0;
      let checkedWorkflowPresence = false;
      let hasDeployWorkflow: boolean | null = null;

      while (this.clock.now() < deadline) {
        // Shutting down: stop polling without touching state; resumeIncompletePublishes picks it up
        if (this.stopping.signal.aborted) return;
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
          await this.clock.sleep(opts.pollIntervalMs, this.stopping.signal);
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
            hasDeployWorkflow = await this.github.hasActiveDeployWorkflow().catch((err) => {
              ignore(err, 'publish: could not list deploy workflows', { sessionId });
              return null;
            });
            if (hasDeployWorkflow === false) {
              await this.markPublished(sessionId, prNumber, prUrl);
              return;
            }
          }
          if (this.clock.now() >= registrationDeadline) {
            this.failDeploy(
              sessionId,
              prNumber,
              prUrl,
              'Changes merged to GitHub, but no live site deploy workflow run appeared for this commit. Click Retry deploy check or inspect GitHub Actions.',
            );
            return;
          }
        }

        await this.clock.sleep(opts.pollIntervalMs, this.stopping.signal);
      }
      if (this.stopping.signal.aborted) return;

      // Polling timed out after merge: keep session frozen in 'merged' state so user can retry deploy check
      this.failDeploy(
        sessionId,
        prNumber,
        prUrl,
        'Changes merged to GitHub, but the live site deploy is still taking longer than expected. Click Retry deploy check in a moment.',
      );
    } catch (err) {
      // Never allow post-merge polling errors to escape into failed_checks (or reject: callers void us)
      const detail = err instanceof Error ? err.message : 'unexpected error';
      logger.error('publish: deploy check crashed', { sessionId, prNumber, err });
      try {
        this.failDeploy(
          sessionId,
          prNumber,
          prUrl,
          `Changes merged to GitHub, but verifying the live site deploy encountered an error (${detail}). Click Retry deploy check in a moment.`,
        );
      } catch (failErr) {
        logger.error('publish: recording deploy failure failed', { sessionId, prNumber, err: failErr });
      }
    } finally {
      this.activeDeployChecks.delete(sessionId);
    }
  }
}
