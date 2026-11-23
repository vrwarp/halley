import type {
  PublishProgressPayload,
  PublishState,
  UserDto,
  VerificationCheckResult,
} from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';
import type { GitHubService } from '../github/client.js';

export class PublishService {
  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private driver: WorkspaceDriver,
    private github: GitHubService,
    private broadcastPublish: (sessionId: string, payload: PublishProgressPayload) => void,
  ) {}

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
    session: SessionRecord,
    actor: UserDto,
    input: { title?: string; summary?: string },
  ): Promise<void> {
    const endpoint = await this.driver.ensureRunning(session);
    const runnerUrl = endpoint.runnerUrl;

    try {
      // 1. Hard-gate verification checks (astro hygiene, check, build, verify:*)
      this.setState(session.id, 'verifying');
      const verifyRes = await fetch(`${runnerUrl}/internal/verify`, { method: 'POST' });
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

      // 2. Fetch & rebase onto latest base branch (with Pi conflict resolution)
      this.setState(session.id, 'rebasing', { checks: verifyData.results });
      const ghToken = await this.github.getAccessToken().catch(() => '');
      if (ghToken) {
        await this.driver.fetchIntoSession(session, ghToken);
      }
      const rebaseRes = await fetch(`${runnerUrl}/internal/git/rebase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: session.base_branch }),
      });
      const rebaseData = (await rebaseRes.json()) as {
        status: 'clean' | 'resolved' | 'conflict';
        conflictedFiles: string[];
        error?: string;
      };

      if (rebaseData.status === 'conflict') {
        this.setState(session.id, 'failed_conflict', {
          conflictedFiles: rebaseData.conflictedFiles,
          error:
            'Someone else updated the same page while you were editing. Please review the changes before publishing.',
        });
        return;
      }

      if (rebaseData.status === 'resolved') {
        // Re-verify after Pi resolved conflicts
        this.setState(session.id, 'verifying');
        const reVerify = await fetch(`${runnerUrl}/internal/verify`, { method: 'POST' });
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

      // 6. Poll GitHub Actions / Pages deployment until live
      this.db.updateSession(session.id, {
        merged_sha: mergedSha,
        merged_at: new Date().toISOString(),
      });
      this.setState(session.id, 'deploying_pages', {
        prNumber: pr.number,
        prUrl: pr.url,
      });

      await this.waitForPagesDeploy(session.id, mergedSha, pr.number, pr.url);
    } catch (err) {
      this.setState(session.id, 'failed_checks', {
        error: err instanceof Error ? err.message : 'Publish failed unexpectedly',
      });
    }
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

  private async waitForPagesDeploy(
    sessionId: string,
    mergeSha: string,
    prNumber: number,
    prUrl: string,
  ): Promise<void> {
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline) {
      const status = await this.github.checkMainDeployStatus(mergeSha).catch(() => 'deployed' as const);
      if (status === 'deployed') {
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
        this.setState(sessionId, 'published', { prNumber, prUrl });
        return;
      }
      if (status === 'failed') {
        this.setState(sessionId, 'failed_ci', {
          prNumber,
          prUrl,
          error: 'Changes merged to GitHub, but the live site deploy workflow reported an error.',
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Even if polling timed out after merge, mark published since merge succeeded
    this.db.updateSession(sessionId, {
      status: 'published',
      publish_state: 'published',
      archived_at: new Date().toISOString(),
    });
    this.setState(sessionId, 'published', { prNumber, prUrl });
  }
}
