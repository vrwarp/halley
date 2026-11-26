import type {
  PublishProgressPayload,
  PublishState,
  UserDto,
  VerificationCheckResult,
} from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';
import { GitHubApiError, type GitHubService } from '../github/client.js';

export interface DeployPollOptions {
  initialDelayMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  runRegistrationGraceMs?: number;
  maxConsecutiveErrors?: number;
}

const DEFAULT_DEPLOY_POLL_OPTIONS: Required<DeployPollOptions> = {
  initialDelayMs: 2500,
  pollIntervalMs: 5000,
  timeoutMs: 6 * 60_000,
  runRegistrationGraceMs: 45_000,
  maxConsecutiveErrors: 5,
};

export class PublishService {
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

  async publish(
    sessionInput: SessionRecord,
    actor: UserDto,
    input: { title?: string; summary?: string },
  ): Promise<void> {
    let session = this.db.getSession(sessionInput.id) ?? sessionInput;
    const endpoint = await this.driver.ensureRunning(session);
    const runnerUrl = endpoint.runnerUrl;

    try {
      // 0. Commit any pending inline/working-tree edits so HEAD has the exact draft state
      const ckptRes = await fetch(`${runnerUrl}/internal/git/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Ready to publish' }),
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

      // 1. Hard-gate verification checks (keep Astro dev preview running under pooled 6 GB ceiling + max-1 build queue)
      this.setState(session.id, 'verifying');
      const verifyRes = await fetch(`${runnerUrl}/internal/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pausePreview: false }),
      });
      const verifyData = (await verifyRes.json()) as {
        allPassed: boolean;
        results: VerificationCheckResult[];
      };
      if (!verifyData.allPassed) {
        const failed = verifyData.results.filter((r) => !r.passed);
        this.setState(session.id, 'failed_checks', {
          checks: verifyData.results,
          error: `Checks failed: ${failed.map((f) => f.name).join(', ')}`,
        });
        return;
      }

      // 2. Q21: Sync with latest base branch; if main moved mid-publish on overlapping/conflicting
      // files, pause and return to the modal so no unreviewed resolution ever ships.
      this.setState(session.id, 'rebasing', { checks: verifyData.results });
      const ghToken = await this.github.getAccessToken().catch(() => '');
      let fetchedByDriver = false;
      if (ghToken) {
        fetchedByDriver = await this.driver
          .fetchIntoSession(session, ghToken)
          .then(() => true)
          .catch(() => false);
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
        // Prepare full conflict resolution / decision cards for the Publish modal
        await fetch(`${runnerUrl}/internal/sync/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseBranch: session.base_branch,
            kind: 'publish',
            autoSyncOnly: false,
            skipFetch: true,
          }),
        }).catch(() => {});
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
        this.setState(session.id, 'failed_conflict', {
          conflictedFiles: syncData.review.touchedUserFiles,
          error:
            'Someone just published an update to a page you edited. Please double-check Live vs Draft and click Publish again.',
        });
        return;
      }

      if (syncData.review && !syncData.review.alreadyUpToDate) {
        // Non-overlapping mid-publish update merged cleanly: re-verify before pushing
        this.setState(session.id, 'verifying');
        const reVerify = await fetch(`${runnerUrl}/internal/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pausePreview: false }),
        });
        const reData = (await reVerify.json()) as {
          allPassed: boolean;
          results: VerificationCheckResult[];
        };
        if (!reData.allPassed) {
          this.setState(session.id, 'failed_checks', {
            checks: reData.results,
            error: 'Checks failed after merging updates from the live site.',
          });
          return;
        }
      }

      // 3. Layer-3 .github/** hard gate before pushing
      const protRes = await fetch(
        `${runnerUrl}/internal/git/protected-diff?baseRef=${encodeURIComponent(`origin/${session.base_branch}`)}`,
      );
      const protData = (await protRes.json()) as { clean: boolean; protectedFiles: string[] };
      if (!protData.clean) {
        this.setState(session.id, 'failed_checks', {
          error: `Blocked: protected .github/** files were modified (${protData.protectedFiles.join(', ')}).`,
        });
        return;
      }

      // 4. Push branch & open/update PR
      this.setState(session.id, 'pushing_pr');
      if (!ghToken) {
        throw new Error('GitHub credentials are not configured for pushing');
      }
      await this.driver.pushSessionBranch(session, ghToken);

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

      this.setState(session.id, 'waiting_ci', {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      const commitMsg = `${prBody}\n\nCo-authored-by: ${actor.name} <${actor.email}>`;
      const nativeAutoMerge = await this.github.tryEnableNativeAutoMerge(pr.nodeId, prTitle);

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
      if (!mergedSha) return;

      // 6. Freeze editing immediately in 'merged' state and archive transcript deterministically ($0 AI)
      const mergedAt = new Date().toISOString();
      this.db.updateSession(session.id, {
        status: 'merged',
        merged_sha: mergedSha,
        merged_at: mergedAt,
      });
      await fetch(`${runnerUrl}/internal/read-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readOnly: true }),
      }).catch(() => {});
      await this.archiveSessionDeterministically(session.id, runnerUrl, session.base_branch, mergedSha, pr.url);

      this.setState(session.id, 'deploying_pages', {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      await this.waitForPagesDeploy(session.id, mergedSha, pr.number, pr.url);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Publish failed unexpectedly';
      const crashInfo = this.driver.getCrashInfo?.(session.id);
      const isRunnerDisconnect =
        /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(rawMsg);
      const friendlyError =
        crashInfo?.oom
          ? 'The workspace ran out of memory while running publish checks. Restart the workspace and try publishing again.'
          : isRunnerDisconnect
            ? 'Lost connection to the workspace while running publish checks (it may have restarted or run out of memory). Please try again.'
            : rawMsg;
      this.setState(session.id, 'failed_checks', {
        error: friendlyError,
      });
    }
  }

  async archiveSessionDeterministically(
    sessionId: string,
    runnerUrl: string | null,
    baseBranch: string,
    mergedSha: string | null,
    prUrl: string | null,
  ): Promise<void> {
    let transcriptJson = JSON.stringify({ entries: [], usageUsd: 0 });
    let diffSummary = '[]';
    if (runnerUrl) {
      try {
        const tRes = await fetch(`${runnerUrl}/internal/transcript`);
        if (tRes.ok) {
          transcriptJson = await tRes.text();
        }
      } catch {
        // best-effort
      }
      try {
        const cRes = await fetch(
          `${runnerUrl}/internal/git/changes?baseRef=${encodeURIComponent(`origin/${baseBranch}`)}`,
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
        }
      } catch {
        // best-effort
      }
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
    const deadline = Date.now() + 15 * 60_000;
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

      const ci = await this.github.checkCommitStatus(prState.headSha);
      if (ci.state === 'failed') {
        this.setState(opts.session.id, 'failed_ci', {
          prNumber: opts.prNumber,
          prUrl: opts.prUrl,
          error: ci.failedSummary || 'GitHub CI checks failed',
          ciLogs: ci.failedLogs,
        });
        return null;
      }

      if (ci.state === 'passed' && !opts.nativeAutoMerge) {
        try {
          return await this.github.squashMergePr({
            prNumber: opts.prNumber,
            commitTitle: opts.commitTitle,
            commitMessage: opts.commitMessage,
          });
        } catch {
          // GitHub may still be settling branch protection; retry next poll
        }
      }

      await new Promise((r) => setTimeout(r, 4000));
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
  }

  private failDeploy(
    sessionId: string,
    prNumber: number,
    prUrl: string,
    error: string,
    deployUrl?: string,
  ): void {
    this.db.updateSession(sessionId, { status: 'merged' });
    this.setState(sessionId, 'failed_deploy', {
      prNumber,
      prUrl,
      error,
      ...(deployUrl ? { deployUrl } : {}),
    });
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
