import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  GitHubApiError,
  GitHubService,
  isTransientGitHubError,
  parseRetryAfterMs,
} from '../src/github/client.js';

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, url);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('GitHubService exponential backoff & retry', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  function makeConfig(githubApiBaseUrl: string) {
    return {
      ...loadConfig(),
      repo: 'vrwarp/thecrossing.website',
      githubApiBaseUrl,
      githubToken: 'test-token',
      githubAppId: '',
      githubAppPrivateKey: '',
      githubAppInstallationId: '',
    };
  }

  it('retries 5xx errors with exponential backoff (1s -> 2s -> 4s) and succeeds on the 4th attempt', async () => {
    let attempts = 0;
    const mock = await startMockServer((_req, res, url) => {
      if (url.pathname.endsWith('/check-runs')) {
        attempts += 1;
        if (attempts <= 3) {
          res.writeHead(500);
          res.end('');
          return;
        }
        res.end(
          JSON.stringify({
            total_count: 1,
            check_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }],
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/status')) {
        res.end(JSON.stringify({ state: 'success', statuses: [] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    cleanups.push(() => mock.close());

    const sleeps: number[] = [];
    const gh = new GitHubService(makeConfig(mock.url), {
      maxRetries: 3,
      baseDelayMs: 1000,
      jitterRatio: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await gh.checkCommitStatus('abc123');
    expect(result.state).toBe('passed');
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('throws GitHubApiError after exhausting all 3 retries on persistent 500s', async () => {
    let attempts = 0;
    const mock = await startMockServer((_req, res) => {
      attempts += 1;
      res.writeHead(500);
      res.end('internal error');
    });
    cleanups.push(() => mock.close());

    const sleeps: number[] = [];
    const gh = new GitHubService(makeConfig(mock.url), {
      maxRetries: 3,
      baseDelayMs: 1000,
      jitterRatio: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(gh.getPrState(42)).rejects.toThrow(GitHubApiError);
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('honors Retry-After header on 429 responses (clamped to maxDelayMs)', async () => {
    let attempts = 0;
    const mock = await startMockServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.setHeader('Retry-After', '3');
        res.writeHead(429);
        res.end('rate limited');
        return;
      }
      if (attempts === 2) {
        res.setHeader('Retry-After', '120');
        res.writeHead(429);
        res.end('rate limited');
        return;
      }
      res.end(JSON.stringify({ merged: false, merge_commit_sha: null, state: 'open', head: { sha: 'abc' } }));
    });
    cleanups.push(() => mock.close());

    const sleeps: number[] = [];
    const gh = new GitHubService(makeConfig(mock.url), {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 15_000,
      jitterRatio: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const state = await gh.getPrState(7);
    expect(state.headSha).toBe('abc');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([3000, 15_000]);
  });

  it('does NOT retry non-transient 4xx errors (401, 403, 404, 422)', async () => {
    for (const status of [401, 403, 404, 422]) {
      let attempts = 0;
      const mock = await startMockServer((_req, res) => {
        attempts += 1;
        res.writeHead(status);
        res.end(JSON.stringify({ message: `err ${status}` }));
      });
      cleanups.push(() => mock.close());

      const sleeps: number[] = [];
      const gh = new GitHubService(makeConfig(mock.url), {
        maxRetries: 3,
        baseDelayMs: 1000,
        jitterRatio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      await expect(gh.getPrState(10)).rejects.toThrow(GitHubApiError);
      expect(attempts).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('retries createOrUpdatePr idempotently if POST /pulls returns 502 after creating the PR', async () => {
    let getCalls = 0;
    let postCalls = 0;
    let patchCalls = 0;
    const mock = await startMockServer((req, res, url) => {
      if (url.pathname.endsWith('/pulls') && req.method === 'GET') {
        getCalls += 1;
        // On second attempt, GitHub already has the PR created during the timed-out/502 POST
        if (getCalls === 1) {
          res.end(JSON.stringify([]));
        } else {
          res.end(
            JSON.stringify([
              {
                number: 55,
                html_url: 'https://github.com/vrwarp/thecrossing.website/pull/55',
                node_id: 'PR_55',
                head: { sha: 'sha55' },
              },
            ]),
          );
        }
        return;
      }
      if (url.pathname.endsWith('/pulls') && req.method === 'POST') {
        postCalls += 1;
        res.writeHead(502);
        res.end('Bad Gateway');
        return;
      }
      if (url.pathname.endsWith('/pulls/55') && req.method === 'PATCH') {
        patchCalls += 1;
        res.end(
          JSON.stringify({
            number: 55,
            html_url: 'https://github.com/vrwarp/thecrossing.website/pull/55',
            node_id: 'PR_55',
            head: { sha: 'sha55' },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    cleanups.push(() => mock.close());

    const sleeps: number[] = [];
    const gh = new GitHubService(makeConfig(mock.url), {
      maxRetries: 3,
      baseDelayMs: 1000,
      jitterRatio: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const pr = await gh.createOrUpdatePr({
      headBranch: 'halley/test',
      baseBranch: 'main',
      title: 'Sync events',
      body: 'Updated events.',
    });

    expect(pr.number).toBe(55);
    expect(getCalls).toBe(2);
    expect(postCalls).toBe(1);
    expect(patchCalls).toBe(1);
    expect(sleeps).toEqual([1000]);
  });

  it('classifies transient GitHub errors and parses Retry-After headers', () => {
    expect(isTransientGitHubError(new GitHubApiError(500, '/check-runs', '500'))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError(502, '/check-runs', '502'))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError(429, '/check-runs', '429'))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError(404, '/check-runs', '404'))).toBe(false);
    expect(isTransientGitHubError(new GitHubApiError(422, '/pulls', '422'))).toBe(false);
    expect(isTransientGitHubError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientGitHubError(new Error('Validation failed'))).toBe(false);

    expect(parseRetryAfterMs('5', 15_000)).toBe(5000);
    expect(parseRetryAfterMs('99', 15_000)).toBe(15_000);
    expect(parseRetryAfterMs(null, 15_000)).toBeNull();
    expect(parseRetryAfterMs('not-a-date', 15_000)).toBeNull();
  });
});
