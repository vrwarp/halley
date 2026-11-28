import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(path.resolve('packages/control-plane/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
    srv.on('error', reject);
  });
}

async function createFixtureAstroRepo(repoDir: string): Promise<void> {
  await fs.mkdir(path.join(repoDir, 'src/pages/events'), { recursive: true });
  await fs.mkdir(path.join(repoDir, 'src/lib'), { recursive: true });

  await fs.writeFile(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-astro-site',
        version: '0.0.1',
        private: true,
        type: 'module',
        scripts: {
          check: 'node -e "console.log(\'astro check ok\')"',
          build: 'astro build',
        },
      },
      null,
      2,
    ),
  );

  await fs.writeFile(
    path.join(repoDir, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://example.org',
  base: '/test-site',
});
`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/lib/url.ts'),
    `export function url(path) {
  const base = '/test-site';
  if (path === '/') return base + '/';
  return base + (path.startsWith('/') ? path : '/' + path);
}
`,
  );

  await fs.mkdir(path.join(repoDir, 'src/styles'), { recursive: true });
  await fs.mkdir(path.join(repoDir, 'src/content/announcements'), { recursive: true });

  await fs.writeFile(
    path.join(repoDir, 'src/styles/site.css'),
    `body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; color: #1c1917; }\nh1 { letter-spacing: -0.02em; }\n`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const announcements = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/announcements' }),
  schema: z.object({
    title: z.string(),
    date: z.string(),
  }),
});

export const collections = { announcements };
`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/content/announcements/welcome.json'),
    JSON.stringify({ title: 'Fall Fellowship Kickoff', date: '2026-09-13' }, null, 2) + '\n',
  );

  await fs.writeFile(
    path.join(repoDir, 'src/pages/index.astro'),
    `---
import { getCollection } from 'astro:content';
import { url } from '../lib/url';
import '../styles/site.css';

const items = await getCollection('announcements');
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Home | Fixture</title></head>
  <body>
    <main>
      <h1>Welcome to <span class="serif-accent">our community</span></h1>
      <p>Join us every Sunday morning at 10am.</p>
      <section data-collection="announcements">
        {items.map((item) => <small>{item.data.title}</small>)}
      </section>
      <a href={url('/im-new')}>I'm New</a>
      <a href={url('/events')}>Events</a>
    </main>
  </body>
</html>
`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/pages/im-new.astro'),
    `---
import { url } from '../lib/url';
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>I'm New | Fixture</title></head>
  <body>
    <main>
      <h1>I'm New Here</h1>
      <p>We would love to welcome you this Sunday.</p>
      <a href={url('/')}>Back Home</a>
    </main>
  </body>
</html>
`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/pages/events/index.astro'),
    `---
import { url } from '../../lib/url';
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Events | Fixture</title></head>
  <body>
    <main>
      <h1>Upcoming Events</h1>
      <ul>
        <li>Community Coffee — Every Sunday</li>
      </ul>
      <a href={url('/events/summer-picnic')}>Summer Picnic</a>
    </main>
  </body>
</html>
`,
  );

  await fs.writeFile(
    path.join(repoDir, 'src/pages/events/summer-picnic.astro'),
    `---
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Summer Picnic | Fixture</title></head>
  <body>
    <main>
      <h1>Summer Picnic</h1>
      <p>Past summer gathering.</p>
    </main>
  </body>
</html>
`,
  );

  // Symlink pre-installed node_modules containing astro so no network install is needed
  const astroNodeModules = path.resolve('packages/astro-dev-edit/node_modules');
  await fs.symlink(astroNodeModules, path.join(repoDir, 'node_modules'));

  await fs.writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\ndist/\n.astro/\n');

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Fixture Bot'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.org'], { cwd: repoDir });
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'Initial fixture site'], { cwd: repoDir });
}

function sendAnthropicSse(
  res: http.ServerResponse,
  blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  emit('message_start', {
    type: 'message_start',
    message: {
      id: `msg_fake_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-haiku-5-5',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 150,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });

  let hasToolUse = false;
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      const mid = Math.max(1, Math.floor(block.text.length / 2));
      for (const chunk of [block.text.slice(0, mid), block.text.slice(mid)].filter(Boolean)) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: chunk },
        });
      }
      emit('content_block_stop', { type: 'content_block_stop', index });
    } else {
      hasToolUse = true;
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const fullJson = JSON.stringify(block.input);
      const mid = Math.max(1, Math.floor(fullJson.length / 2));
      for (const part of [fullJson.slice(0, mid), fullJson.slice(mid)].filter(Boolean)) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: part },
        });
      }
      emit('content_block_stop', { type: 'content_block_stop', index });
    }
  });

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 40 },
  });
  emit('message_stop', { type: 'message_stop' });
  res.end();
}

function startFakeAnthropicServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const msgs = body.messages ?? [];
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system');
      const lastContent = lastMsg?.content;

      // Check if this is a follow-up after tool_result
      const isToolResult =
        Array.isArray(lastContent) &&
        lastContent.some((b: { type?: string }) => b.type === 'tool_result');

      // Find the latest user prompt text
      let lastUserPrompt = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role === 'user') {
          if (typeof m.content === 'string') {
            lastUserPrompt = m.content;
            break;
          }
          if (Array.isArray(m.content)) {
            const textPart = m.content.find((b: { type?: string; text?: string }) => b.type === 'text');
            if (textPart?.text) {
              lastUserPrompt = textPart.text;
              break;
            }
          }
        }
      }

      const lower = lastUserPrompt.replace(/^\[Current Preview\][^\n]*\n*/i, '').toLowerCase();

      if (lower.includes('womens-gathering') || lower.includes('unlisted')) {
        if (!isToolResult) {
          sendAnthropicSse(res, [
            {
              type: 'tool_use',
              id: 'toolu_unlisted_1',
              name: 'write',
              input: {
                path: 'src/pages/womens-gathering.astro',
                content: `---
import { url } from '../lib/url';
const indexable = false;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Women's Gathering | Fixture</title>
  </head>
  <body>
    <main>
      <h1>Women's Gathering</h1>
      <p>Join us for coffee, prayer, and encouragement.</p>
      <a href={url('/')}>Back Home</a>
    </main>
  </body>
</html>
`,
              },
            },
          ]);
          return;
        }
        sendAnthropicSse(res, [
          {
            type: 'text',
            text: "Done! I've created the unlisted Women's Gathering page so only people with the direct link can find it.",
          },
        ]);
        return;
      }

      if (lower.includes('thanksgiving') || lower.includes('summer-picnic')) {
        if (!isToolResult) {
          sendAnthropicSse(res, [
            {
              type: 'tool_use',
              id: 'toolu_events_1',
              name: 'write',
              input: {
                path: 'src/pages/events/index.astro',
                content: `---
import { url } from '../../lib/url';
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Events | Fixture</title></head>
  <body>
    <main>
      <h1>Upcoming Events</h1>
      <ul>
        <li>Thanksgiving Potluck — November 21 at 5pm</li>
        <li>Community Coffee — Every Sunday</li>
      </ul>
    </main>
  </body>
</html>
`,
              },
            },
            {
              type: 'tool_use',
              id: 'toolu_imnew_1',
              name: 'write',
              input: {
                path: 'src/pages/im-new.astro',
                content: `---
import { url } from '../lib/url';
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>I'm New | Fixture</title></head>
  <body>
    <main>
      <h1>I'm New Here</h1>
      <p>We would love to welcome you this Sunday — kids check-in opens at 9:45am.</p>
      <a href={url('/')}>Back Home</a>
    </main>
  </body>
</html>
`,
              },
            },
            {
              type: 'tool_use',
              id: 'toolu_del_1',
              name: 'bash',
              input: {
                command: 'rm -f src/pages/events/summer-picnic.astro',
              },
            },
          ]);
          return;
        }
        sendAnthropicSse(res, [
          {
            type: 'text',
            text: "All set! I added the Thanksgiving Potluck event, updated the I'm New page with kids check-in details, and removed the old Summer Picnic page.",
          },
        ]);
        return;
      }

      if (lower.includes('screenshot')) {
        if (!isToolResult) {
          sendAnthropicSse(res, [
            {
              type: 'tool_use',
              id: 'toolu_shot_desktop',
              name: 'screenshot_page',
              input: { route: '/im-new', viewport: 'desktop' },
            },
            {
              type: 'tool_use',
              id: 'toolu_shot_mobile',
              name: 'screenshot_page',
              input: { route: '/im-new', viewport: 'mobile' },
            },
          ]);
          return;
        }
        const hadError =
          Array.isArray(lastContent) &&
          lastContent.some((b: { is_error?: boolean }) => Boolean(b.is_error));
        sendAnthropicSse(res, [
          {
            type: 'text',
            text: hadError
              ? 'Screenshot tool returned an error!'
              : 'Captured both desktop and mobile screenshots cleanly via shared browser!',
          },
        ]);
        return;
      }

      if (lower.includes('check')) {
        if (!isToolResult) {
          sendAnthropicSse(res, [
            {
              type: 'tool_use',
              id: 'toolu_checks_1',
              name: 'run_checks',
              input: {},
            },
          ]);
          return;
        }
        sendAnthropicSse(res, [
          {
            type: 'text',
            text: 'Everything passed all site checks cleanly and is ready to publish!',
          },
        ]);
        return;
      }

      sendAnthropicSse(res, [{ type: 'text', text: 'Updated!' }]);
    });
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

function startFakeGitHubServer(repoDir: string): Promise<{
  url: string;
  getPrCount: () => number;
  isMerged: () => boolean;
  close: () => Promise<void>;
}> {
  interface FakePr {
    number: number;
    title: string;
    body: string;
    headBranch: string;
    headSha: string;
    merged: boolean;
    mergeSha: string | null;
  }
  let prCounter = 0;
  let anyMerged = false;
  const prs = new Map<number, FakePr>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const urlPath = (req.url || '').split('?')[0]!;

    res.setHeader('Content-Type', 'application/json');

    // GraphQL auto-merge (return errors so publishService uses clean REST squash merge fallback)
    if (req.method === 'POST' && urlPath === '/graphql') {
      res.writeHead(200);
      res.end(JSON.stringify({ errors: [{ message: 'Auto-merge disabled in fake' }] }));
      return;
    }

    // List open PRs
    if (req.method === 'GET' && urlPath.endsWith('/pulls')) {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const headParam = reqUrl.searchParams.get('head') || '';
      const headBranchFilter = headParam.includes(':') ? headParam.split(':')[1] : headParam;
      const openPrs = [...prs.values()].filter(
        (p) => !p.merged && (!headBranchFilter || p.headBranch === headBranchFilter),
      );
      res.writeHead(200);
      res.end(
        JSON.stringify(
          openPrs.map((p) => ({
            number: p.number,
            html_url: `https://github.com/test/site/pull/${p.number}`,
            node_id: `PR_fake_${p.number}`,
            head: { sha: p.headSha },
          })),
        ),
      );
      return;
    }

    // Create PR
    if (req.method === 'POST' && urlPath.endsWith('/pulls')) {
      const body = JSON.parse(rawBody) as { title: string; body: string; head: string };
      prCounter += 1;
      let headSha = 'abc1234';
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', `refs/heads/${body.head}`], {
          cwd: repoDir,
        });
        headSha = stdout.trim();
      } catch {
        // fallback
      }
      const created: FakePr = {
        number: prCounter,
        title: body.title,
        body: body.body,
        headBranch: body.head,
        headSha,
        merged: false,
        mergeSha: null,
      };
      prs.set(created.number, created);
      res.writeHead(201);
      res.end(
        JSON.stringify({
          number: created.number,
          html_url: `https://github.com/test/site/pull/${created.number}`,
          node_id: `PR_fake_${created.number}`,
          head: { sha: created.headSha },
        }),
      );
      return;
    }

    // Get PR state
    const prMatch = urlPath.match(/\/pulls\/(\d+)$/);
    if (req.method === 'GET' && prMatch) {
      const pr = prs.get(Number(prMatch[1]));
      res.writeHead(200);
      res.end(
        JSON.stringify({
          merged: Boolean(pr?.merged),
          merge_commit_sha: pr?.mergeSha ?? null,
          state: pr?.merged ? 'closed' : 'open',
          head: { sha: pr?.headSha || 'abc1234' },
        }),
      );
      return;
    }

    // Check runs & combined commit status
    if (req.method === 'GET' && urlPath.endsWith('/check-runs')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ id: 1, name: 'CI / verify', status: 'completed', conclusion: 'success' }],
        }),
      );
      return;
    }
    if (req.method === 'GET' && urlPath.endsWith('/status')) {
      res.writeHead(200);
      res.end(JSON.stringify({ state: 'success', statuses: [] }));
      return;
    }

    // Workflows list
    if (req.method === 'GET' && urlPath.endsWith('/actions/workflows')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          workflows: [
            { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
            { id: 2, name: 'Deploy Pages', path: '.github/workflows/deploy.yml', state: 'active' },
          ],
        }),
      );
      return;
    }

    // Squash merge -> advance `main` in upstream repoDir so other open drafts detect real upstream updates!
    const mergeMatch = urlPath.match(/\/pulls\/(\d+)\/merge$/);
    if (req.method === 'PUT' && mergeMatch) {
      const pr = prs.get(Number(mergeMatch[1]));
      let newMergeSha = `deadbeef0000000000000000000000000000000${pr?.number ?? 1}`;
      if (pr) {
        try {
          await execFileAsync('git', ['checkout', '-B', 'main', `refs/heads/${pr.headBranch}`], {
            cwd: repoDir,
          });
          const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
          newMergeSha = stdout.trim();
        } catch {
          // fallback if branch ref wasn't pushed to repoDir
        }
        pr.merged = true;
        pr.mergeSha = newMergeSha;
      }
      anyMerged = true;
      res.writeHead(200);
      res.end(JSON.stringify({ sha: newMergeSha, merged: true }));
      return;
    }

    // Actions runs (Pages deploy)
    if (req.method === 'GET' && urlPath.endsWith('/actions/runs')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 1,
              name: 'Deploy Pages',
              path: '.github/workflows/deploy.yml',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: `Unhandled fake GitHub route: ${req.method} ${urlPath}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getPrCount: () => prCounter,
        isMerged: () => anyMerged,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

type Browser = import('playwright').Browser;
type Page = import('playwright').Page;
type Frame = import('playwright').Frame;

/**
 * One fully isolated Halley stack per scenario: its own fixture repo, data dir (SQLite +
 * workspaces + git mirror), fake Anthropic, fake GitHub and control-plane process. A failure (or
 * leftover state such as a merged PR advancing `main`) in one scenario cannot leak into another.
 */
interface HalleyStack {
  baseUrl: string;
  fakeGitHub: Awaited<ReturnType<typeof startFakeGitHubServer>>;
  logs: string[];
  close: () => Promise<void>;
}

const CP_START_ATTEMPTS = 5;
const CP_HEALTH_TIMEOUT_MS = 30_000;

/**
 * Resolves 'healthy' once /api/health answers OK, 'exited' if the process dies first. Throws if
 * neither happens in time.
 */
async function waitForControlPlane(proc: ChildProcess, port: number): Promise<'healthy' | 'exited'> {
  let exited = proc.exitCode !== null || proc.signalCode !== null;
  const onExit = () => {
    exited = true;
  };
  proc.once('exit', onExit);
  try {
    const deadline = Date.now() + CP_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) return 'exited';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return 'healthy';
      } catch (err) {
        // Not listening yet: keep polling until the deadline or the process exits.
        void err;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`control plane did not become healthy on port ${port} within ${CP_HEALTH_TIMEOUT_MS}ms`);
  } finally {
    proc.off('exit', onExit);
  }
}

function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal); // the whole process group (spawned detached)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Kills every process whose environment mentions `marker` (this stack's private tmp dir). Runners and
 * `astro dev` run in their own process groups, so a group kill of the control plane cannot reach them
 * if something upstream died abruptly; without this sweep a leaked child can keep running after the
 * suite and hold the runner's event loop / ports open.
 */
async function sweepProcessesMentioning(marker: string): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const killed: number[] = [];
  for (const entry of await fs.readdir('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let environ: string;
    try {
      environ = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue; // exited meanwhile, or not ours to read
    }
    if (!environ.includes(marker)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  return killed;
}

async function stopProcess(proc: ChildProcess, marker?: string): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    signalGroup(proc, 'SIGTERM');
    const timer = setTimeout(() => signalGroup(proc, 'SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  }
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  if (marker) {
    const leaked = await sweepProcessesMentioning(marker);
    if (leaked.length > 0) console.warn(`[e2e] killed ${leaked.length} leaked process(es) after stop: ${leaked.join(', ')}`);
  }
}

/**
 * The control plane derives its public/internal URLs from PORT, so PORT=0 cannot work. Instead
 * pick a free port and, if another process grabs it between our probe and the child's bind
 * (EADDRINUSE), retry with a fresh port.
 */
async function startControlPlane(
  env: NodeJS.ProcessEnv,
  logs: string[],
): Promise<{ proc: ChildProcess; port: number }> {
  for (let attempt = 1; ; attempt++) {
    const port = await getFreePort();
    const attemptLogs: string[] = [];
    const proc = spawn(process.execPath, ['packages/control-plane/dist/index.js'], {
      cwd: process.cwd(),
      env: { ...env, PORT: String(port), HALLEY_PUBLIC_URL: `http://127.0.0.1:${port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so teardown can kill the whole tree
    });
    const onData = (d: Buffer) => {
      const text = d.toString();
      logs.push(text);
      attemptLogs.push(text);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    let outcome: 'healthy' | 'exited';
    try {
      outcome = await waitForControlPlane(proc, port);
    } catch (err) {
      await stopProcess(proc, env.DATA_DIR);
      throw new Error(`${(err as Error).message}\n${attemptLogs.join('')}`);
    }
    if (outcome === 'healthy') return { proc, port };
    const output = attemptLogs.join('');
    if (/EADDRINUSE/.test(output) && attempt < CP_START_ATTEMPTS) {
      logs.push(`[e2e] port ${port} was taken before the control plane bound it; retrying\n`);
      continue;
    }
    throw new Error(`control plane exited during startup (code ${proc.exitCode})\n${output}`);
  }
}

async function startStack(label: string): Promise<HalleyStack> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `halley-e2e-${label}-`));
  const repoDir = path.join(tmpDir, 'fixture-repo');
  const dataDir = path.join(tmpDir, 'data');
  const logs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [() => fs.rm(tmpDir, { recursive: true, force: true })];
  const close = async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch((err: unknown) => console.warn(`[e2e:${label}] cleanup step failed`, err));
    }
  };
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const [, fakeAnthropic] = await Promise.all([createFixtureAstroRepo(repoDir), startFakeAnthropicServer()]);
    cleanups.push(fakeAnthropic.close);
    const fakeGitHub = await startFakeGitHubServer(repoDir);
    cleanups.push(fakeGitHub.close);
    const { proc, port } = await startControlPlane(
      {
        ...process.env,
        DATA_DIR: dataDir,
        HALLEY_REPO: 'test/fixture-site',
        HALLEY_BASE_BRANCH: 'main',
        HALLEY_DEV_LOCAL_REPO: repoDir,
        GITHUB_TOKEN: 'fake-github-token',
        GITHUB_API_URL: fakeGitHub.url,
        ANTHROPIC_API_KEY: 'fake-anthropic-key',
        ANTHROPIC_BASE_URL: fakeAnthropic.url,
        HALLEY_MODEL_ID: 'haiku-latest',
        HALLEY_THINKING_LEVEL: 'high',
        HALLEY_ADMIN_EMAILS: 'admin@thecrossing.website',
        HALLEY_ALLOWED_DOMAINS: 'thecrossing.website',
        HALLEY_WEB_DIST: path.resolve('packages/web/dist'),
        HALLEY_DEV_LOGIN: 'true',
        // if this test worker dies abruptly, the control plane (and through it the supervisor,
        // runners and astro dev servers) exits instead of leaking into the next run
        HALLEY_EXIT_WITH_PARENT: '1',
      },
      logs,
    );
    cleanups.push(() => stopProcess(proc, tmpDir));
    return { baseUrl: `http://127.0.0.1:${port}`, fakeGitHub, logs, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function signIn(page: Page, baseUrl: string, email: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="admin@example.com (optional)"]', email);
  await page.click('button:has-text("Dev Sign In")');
  await page.waitForSelector('input[placeholder*="Easter service times"]');
}

/** The preview iframe's Frame (re-resolved each call: the iframe navigates between routes). */
async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('iframe');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('preview iframe has no content frame');
  return frame;
}

/** Waits until the preview bridge has actually switched into Edit mode (it styles the cursor then). */
async function waitForPreviewEditMode(page: Page): Promise<void> {
  const frame = await previewFrame(page);
  await frame.waitForFunction(
    () => Boolean(document.getElementById('__halley-edit-cursor')?.textContent?.includes('cursor: pointer')),
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * Arms a listener for the preview's `halley:patch-saved` message (posted to the editor page once
 * the inline edit's POST /__editor/patch succeeded). Call before triggering the save, await after.
 */
async function armPatchSaved(page: Page): Promise<() => Promise<void>> {
  const key = `__e2ePatch_${Math.random().toString(36).slice(2)}`;
  await page.evaluate((k) => {
    const w = window as unknown as Record<string, unknown>;
    w[k] = 'pending';
    const onMsg = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === 'halley:patch-saved') w[k] = 'saved';
      else if (type === 'halley:edit-error') w[k] = `error: ${(e.data as { message?: string }).message ?? ''}`;
      else return;
      window.removeEventListener('message', onMsg);
    };
    window.addEventListener('message', onMsg);
  }, key);
  return async () => {
    const handle = await page.waitForFunction(
      (k) => (window as unknown as Record<string, string>)[k] !== 'pending' && (window as unknown as Record<string, string>)[k],
      key,
      { timeout: 15_000 },
    );
    const state = await handle.jsonValue();
    if (state !== 'saved') throw new Error(`inline edit was not saved (${String(state)})`);
  };
}

describe.concurrent('Halley E2E (with fake Anthropic SSE + fake GitHub + real Astro & Playwright)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('signs in, creates unlisted page, edits inline, runs multi-page Pi turns, checks, and publishes via fake GitHub', async () => {
    const stack = await startStack('main-flow');
    const { baseUrl, fakeGitHub } = stack;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    let page: Page | null = null;
    try {
      page = await context.newPage();

      // 1. Sign in via dev-login UI
      await signIn(page, baseUrl, 'editor-main@thecrossing.website');

      // 2. Create session
      await page.fill('input[placeholder*="Easter service times"]', 'E2E Fake Flow');
      await page.click('button:has-text("New edit")');

      // Wait for editor & iframe preview to boot
      await page.waitForSelector('iframe', { timeout: 60_000 });
      const frameLocator = page.frameLocator('iframe');
      await frameLocator.locator('h1:has-text("Welcome to our community")').waitFor({ timeout: 60_000 });

      // 3. Switch to Edit mode (Browse is default) and verify clicking a nested <span> inside <h1> promotes cleanly to the whole <h1>
      await page.click('button:has-text("Edit")');
      await waitForPreviewEditMode(page);
      const h1El = frameLocator.locator('h1').first();
      const h1Span = frameLocator.locator('h1 span.serif-accent');
      await h1Span.click();
      await expect.poll(() => h1El.getAttribute('contenteditable'), { timeout: 10_000 }).toBe('true');
      expect(await h1Span.getAttribute('contenteditable')).toBeNull();

      const pEl = frameLocator.locator('p').first();
      await pEl.click();
      // Desktop click begins editing once the bridge's inspect round-trip returns
      await expect.poll(() => pEl.getAttribute('contenteditable'), { timeout: 10_000 }).toBe('true');
      // Exiting <h1> must remove contenteditable completely (never leaving contenteditable="false")
      expect(await h1El.getAttribute('contenteditable')).toBeNull();
      const patchSaved = await armPatchSaved(page);
      await pEl.evaluate((el) => {
        el.textContent = 'Join us every Sunday morning at 10am — coffee at 9:30am!';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pEl.evaluate((el) => el.blur());
      await patchSaved();

      // 3b. Test redesigned Unified Dark Bar: T Format stationary morph, Style preset, More -> Add block drill-down, Duplicate, and Undo
      const initialPCount = await frameLocator.locator('p').count();
      await frameLocator.locator('button[data-act="format"]').click();
      await frameLocator.locator('button[data-cmd="bold"]').waitFor({ state: 'visible', timeout: 5_000 });
      await frameLocator.locator('button[data-act="format-back"]').click();
      await frameLocator.locator('button[data-act="style"]').waitFor({ state: 'visible', timeout: 5_000 });

      await frameLocator.locator('button[data-act="style"]').click();
      await frameLocator.locator('button[data-align="center"]').click();
      await page.waitForTimeout(400);
      expect(await pEl.getAttribute('class')).toContain('text-center');

      await frameLocator.locator('button[data-act="more"]').click();
      await frameLocator.locator('button[data-more="add-drill"]').click();
      await frameLocator.locator('button[data-add="paragraph"]').waitFor({ state: 'visible', timeout: 5_000 });
      await frameLocator.locator('button[data-more="add-back"]').click();
      await frameLocator.locator('button[data-more="duplicate"]').click();
      await page.waitForTimeout(400);
      expect(await frameLocator.locator('p').count()).toBe(initialPCount + 1);

      await frameLocator.locator('button[data-act="undo"]').click();
      await page.waitForTimeout(400);
      expect(await frameLocator.locator('p').count()).toBe(initialPCount);

      // 4. Open New Page wizard via toolbar "+ New page" button and create an unlisted page
      await page.click('button[title="Create a new page"]');
      await page.fill('#new-page-title', "Women's Gathering");
      await page.fill('#new-page-purpose', 'Monthly coffee, prayer, and encouragement for women.');
      await page.click('button:has-text("More options")');
      await page.click('label:has-text("Keep unlisted")');
      await page.click('button:has-text("Create page")');

      // Preview auto-navigates immediately to /womens-gathering and Pi fills real content
      await page.waitForSelector('text=Page ready', { timeout: 30_000 });
      await frameLocator.locator('h1:has-text("Women\'s Gathering")').waitFor({ timeout: 15_000 });

      // Verify Page Switcher lists the new unlisted page with Unlisted badge
      await page.click('button[title="Switch or create page"]');
      await page.waitForSelector('button:has-text("/womens-gathering")');
      await page.click('button:has-text("/womens-gathering")');

      // 4b. Test toolbar visibility toggle (Unlisted -> Public -> Unlisted)
      await page.click('button[title*="Page is unlisted"]');
      await page.click('button:has-text("Make public")');
      await page.waitForSelector('button[title*="Page is public"]', { timeout: 10_000 });
      await page.click('button[title*="Page is public"]');
      await page.click('button:has-text("Make unlisted")');
      await page.waitForSelector('button[title*="Page is unlisted"]', { timeout: 10_000 });

      // 4c. Test toolbar URL rename (/womens-gathering -> /womens-fellowship)
      await page.click('button[title="Change page URL"]');
      await page.fill('#rename-slug', 'womens-fellowship');
      await page.click('button:has-text("Update URL")');
      await page.waitForSelector('button[title="Switch or create page"]:has-text("/womens-fellowship")', {
        timeout: 15_000,
      });
      await frameLocator.locator('h1:has-text("Women\'s Gathering")').waitFor({ timeout: 15_000 });

      // 5. Pi Turn 2: Add Thanksgiving Potluck event, update /im-new, delete /events/summer-picnic
      const chatInput = page.locator('textarea');
      await chatInput.fill(
        'Add Thanksgiving Potluck event, update /im-new with kids check-in, and delete /events/summer-picnic',
      );
      await chatInput.press('Enter');
      await page.waitForSelector('text=Thanksgiving Potluck event', { timeout: 30_000 });

      // 5b. Pi Turn: Capture parallel desktop & mobile screenshots via shared control-plane Chromium
      await chatInput.fill('Take a screenshot of /im-new');
      await chatInput.press('Enter');
      await page.waitForSelector('text=shared browser!', { timeout: 30_000 });

      // 6. Pi Turn 3: Run checks
      await chatInput.fill('Run checks on the site');
      await chatInput.press('Enter');
      await page.waitForSelector('text=passed all site checks', { timeout: 30_000 });

      // 6b. Verify Debug Trace panel loads full prompts, injected context, and tool calls
      await page.click('button[aria-label="Open agent debug trace"]');
      await page.waitForSelector('text=Agent Debug Trace', { timeout: 10_000 });
      await page.waitForSelector('text=[Current Preview]', { timeout: 10_000 });
      await page.click('button[title="Close debug panel"]');

      // 7. Publish via Modal -> fake GitHub PR + squash merge
      await page.click('button:has-text("Publish")');
      await page.click('button:has-text("Publish to Live Site")');
      await page.waitForSelector('button:has-text("Start new edit")', { timeout: 30_000 });

      expect(fakeGitHub.getPrCount()).toBe(1);
      expect(fakeGitHub.isMerged()).toBe(true);
    } catch (err) {
      const iframeSrc = page ? await page.locator('iframe').getAttribute('src').catch(() => null) : null;
      const iframeText = page ? await page.frameLocator('iframe').locator('body').innerText({ timeout: 2000 }).catch(() => null) : null;
      const chatText = page ? await page.locator('aside').innerText({ timeout: 2000 }).catch(() => null) : null;
      console.error('=== IFRAME STATE ===', { iframeSrc, iframeText, chatText });
      console.error('=== CONTROL PLANE LOGS ===\n' + stack.logs.join(''));
      throw err;
    } finally {
      await context.close();
      await stack.close();
    }
  });

  it('supports phone-sized (390x844, touch) editor: 2-step tap-to-edit, Ask Halley compact card, and auto-loaded mobile publish screenshots', async () => {
    const stack = await startStack('mobile');
    const { baseUrl } = stack;
    const shotsDir = process.env.HALLEY_CAPTURE_MOBILE_SHOTS_DIR;
    if (shotsDir) {
      await fs.mkdir(shotsDir, { recursive: true });
    }
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    try {
      const page = await context.newPage();

      // 1. Sign in on mobile and create a new draft
      await signIn(page, baseUrl, 'editor-mobile@thecrossing.website');

      await page.fill('input[placeholder*="Easter service times"]', 'Mobile E2E Edit');
      await page.click('button:has-text("New edit")');

      // Wait for preview iframe to boot
      await page.waitForSelector('iframe', { timeout: 60_000 });
      const frameLocator = page.frameLocator('iframe');
      await frameLocator.locator('h1:has-text("Welcome to our community")').waitFor({ timeout: 60_000 });

      // Verify phone layout: full-bleed preview, floating chat bubble visible, no desktop sidebar
      const bubbleBtn = page.locator('button[aria-label="Open Halley chat"]');
      await bubbleBtn.waitFor({ state: 'visible', timeout: 10_000 });
      const asideVisible = await page.locator('aside').isVisible();
      expect(asideVisible).toBe(false);
      if (shotsDir) {
        await page.screenshot({ path: path.join(shotsDir, '01-mobile-editor-bubble.png') });
      }

      // 2. Switch to Edit mode -> Tap 1 selects paragraph without opening contentEditable
      await page.click('button:has-text("Edit")');
      await waitForPreviewEditMode(page);
      const pEl = frameLocator.locator('p').first();
      await pEl.click();

      // Fixed bottom touch toolbar appears inside shadow DOM with "Edit text", and bubble hides
      const editTextBtn = frameLocator.locator('button[data-act="edit"]');
      await editTextBtn.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await pEl.getAttribute('contenteditable')).not.toBe('true');
      await bubbleBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      if (shotsDir) {
        await page.screenshot({ path: path.join(shotsDir, '02-mobile-touch-select-bar.png') });
      }

      // 3. Tap 2 ("Edit text") enters contentEditable, edits text, taps Done -> saves
      await editTextBtn.click();
      await expect.poll(() => pEl.getAttribute('contenteditable'), { timeout: 5_000 }).toBe('true');
      const patchSaved = await armPatchSaved(page);
      await pEl.evaluate((el) => {
        el.textContent = 'Join us every Sunday morning at 10am — mobile edit saved!';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await frameLocator.locator('button[data-act="done"]').click();
      await patchSaved();
      await bubbleBtn.waitFor({ state: 'visible', timeout: 5_000 });
      // The saved edit is reflected in the compact top bar ("Publish · 1") before the overflow check
      await page.locator('header button:has-text("Publish · 1")').waitFor({ timeout: 10_000 });

      // Ensure compact mobile top bar (now showing "Publish · 1") never overflows viewport width
      const overflowCheck = await page.evaluate(() => {
        const header = document.querySelector('header');
        return {
          docOverflow: document.documentElement.scrollWidth > window.innerWidth,
          headerOverflow: header ? header.scrollWidth > header.clientWidth : false,
        };
      });
      expect(overflowCheck).toEqual({ docOverflow: false, headerOverflow: false });

      // 4. Select heading -> tap "Ask Halley…" -> compact floating chat card opens with attached chip
      await frameLocator.locator('h1').first().click();
      await frameLocator.locator('button[data-act="ask"]').click();

      const chatDialog = page.locator('[role="dialog"][aria-label="Halley chat"]');
      await chatDialog.waitFor({ state: 'visible', timeout: 10_000 });
      await chatDialog.locator('[data-chip-key]').first().waitFor({ state: 'visible', timeout: 5_000 });
      if (shotsDir) {
        await page.screenshot({ path: path.join(shotsDir, '03-mobile-compact-chat-card.png') });
      }

      // Send a prompt from the compact card and wait for Halley's reply
      const mobileTextarea = chatDialog.locator('textarea');
      await mobileTextarea.fill('Run checks on the site');
      await chatDialog.locator('button[aria-label="Send message"]').click();
      await chatDialog.locator('text=passed all site checks').waitFor({ timeout: 30_000 });

      // Tapping inside the preview closes the compact card
      await frameLocator.locator('h1').first().click();
      await chatDialog.waitFor({ state: 'hidden', timeout: 5_000 });

      // Close any element selection before opening Publish
      const closeSelBtn = frameLocator.locator('button[data-act="close"]');
      if (await closeSelBtn.isVisible().catch(() => false)) {
        await closeSelBtn.click();
      }

      // 5. Open Publish -> change cards render immediately & mobile screenshots auto-load
      await page.click('button:has-text("Publish")');
      await page.waitForSelector('text=Review & Publish Changes', { timeout: 10_000 });
      // Auto-loaded mobile Draft screenshot appears with Mobile | Desktop toggle
      await page.locator('img[alt^="Draft "]').first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForSelector('button:has-text("Desktop")', { timeout: 5_000 });
      if (shotsDir) {
        await page.screenshot({ path: path.join(shotsDir, '04-mobile-publish-review.png') });
      }
    } catch (err) {
      console.error('=== MOBILE E2E CONTROL PLANE LOGS ===\n' + stack.logs.join(''));
      throw err;
    } finally {
      await context.close();
      await stack.close();
    }
  });

  it('shows confirmation dialog explaining Branch off and navigates to the new instance from Editor and Dashboard', async () => {
    const stack = await startStack('branch-off');
    const { baseUrl } = stack;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    try {
      const page = await context.newPage();

      await signIn(page, baseUrl, 'editor-branch@thecrossing.website');

      // Create source draft
      await page.fill('input[placeholder*="Easter service times"]', 'Branch Source Draft');
      await page.click('button:has-text("New edit")');

      await page.waitForSelector('iframe', { timeout: 60_000 });
      const frameLocator = page.frameLocator('iframe');
      await frameLocator.locator('h1').first().waitFor({ timeout: 60_000 });

      // 1. Click Branch off in Editor -> confirmation popup appears explaining what it'll do
      await page.click('button[title="Branch off a copy of this draft"]');
      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.locator('text=Branch off “Branch Source Draft”?').waitFor({ timeout: 5_000 });
      await dialog.locator('text=Copies your current progress').waitFor({ timeout: 5_000 });
      await dialog.locator('text=Leaves this draft untouched').waitFor({ timeout: 5_000 });

      // Cancel keeps us in the original instance without creating a copy
      await dialog.locator('button:has-text("Cancel")').click();
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.locator('header span:text-is("Branch Source Draft")').waitFor({ timeout: 5_000 });

      // Confirm Branch off -> brings us to the new instance ("Branch Source Draft (Copy)")
      const firstIframeSrc = await page.locator('iframe').getAttribute('src');
      await page.click('button[title="Branch off a copy of this draft"]');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.locator('button:has-text("Branch off")').click();

      await page.locator('header span:text-is("Branch Source Draft (Copy)")').waitFor({ timeout: 30_000 });
      await page.waitForSelector('iframe', { timeout: 60_000 });
      const secondIframeSrc = await page.locator('iframe').getAttribute('src');
      expect(secondIframeSrc).not.toBe(firstIframeSrc);

      // 2. Return to Dashboard -> both drafts exist; clicking Branch off on Dashboard also confirms & opens new instance
      await page.click('button[title="Back to edits"]');
      await page.locator('h3:text-is("Branch Source Draft")').waitFor({ timeout: 10_000 });
      await page.locator('h3:text-is("Branch Source Draft (Copy)")').waitFor({ timeout: 10_000 });

      const sourceCard = page
        .locator('div.group')
        .filter({ has: page.locator('h3:text-is("Branch Source Draft")') })
        .first();
      await sourceCard.locator('button:has-text("Branch off")').click();

      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.locator('text=Branch off “Branch Source Draft”?').waitFor({ timeout: 5_000 });
      await dialog.locator('button:has-text("Branch off")').click();

      await page.locator('header span:text-is("Branch Source Draft (Copy)")').waitFor({ timeout: 30_000 });
      await page.waitForSelector('iframe', { timeout: 60_000 });
      const thirdIframeSrc = await page.locator('iframe').getAttribute('src');
      expect(thirdIframeSrc).not.toBe(firstIframeSrc);
      expect(thirdIframeSrc).not.toBe(secondIframeSrc);
    } catch (err) {
      console.error('=== BRANCH OFF E2E CONTROL PLANE LOGS ===\n' + stack.logs.join(''));
      throw err;
    } finally {
      await context.close();
      await stack.close();
    }
  });

  it('isolates two concurrent preview tabs via Service Worker, completes durable background publish, and syncs second session from advanced main', async () => {
    const stack = await startStack('two-tabs');
    const { baseUrl } = stack;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();

      // Sign in on pageA (shares auth cookie across context)
      await signIn(pageA, baseUrl, 'editor-tabs@thecrossing.website');

      // Create Session B first so it starts at the current main SHA
      await pageB.goto(baseUrl, { waitUntil: 'networkidle' });
      await pageB.waitForSelector('input[placeholder*="Easter service times"]');
      await pageB.fill('input[placeholder*="Easter service times"]', 'Concurrent Tab B');
      await pageB.click('button:has-text("New edit")');

      // Create Session A in parallel tab
      await pageA.fill('input[placeholder*="Easter service times"]', 'Concurrent Tab A');
      await pageA.click('button:has-text("New edit")');

      const frameA = pageA.frameLocator('iframe');
      const frameB = pageB.frameLocator('iframe');
      await frameA.locator('h1').first().waitFor({ timeout: 60_000 });
      await frameB.locator('h1').first().waitFor({ timeout: 60_000 });

      // Verify Content Collection rendered on both tabs AND zero halley_preview_session cookie exists!
      await frameA.locator('small:has-text("Fall Fellowship Kickoff")').waitFor({ timeout: 10_000 });
      await frameB.locator('small:has-text("Fall Fellowship Kickoff")').waitFor({ timeout: 10_000 });
      const cookies = await context.cookies();
      expect(cookies.some((c) => c.name === 'halley_preview_session')).toBe(false);

      // Edit h1 inline on Tab A ONLY
      await pageA.click('button:has-text("Edit")');
      await waitForPreviewEditMode(pageA);
      const h1A = frameA.locator('h1').first();
      await h1A.click();
      await expect.poll(() => h1A.getAttribute('contenteditable'), { timeout: 10_000 }).toBe('true');
      const patchSaved = await armPatchSaved(pageA);
      await h1A.evaluate((el) => {
        el.textContent = 'Welcome to Crossing — Live From Tab A';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await h1A.evaluate((el) => el.blur());
      await patchSaved();

      // Tab B must remain completely isolated with original h1!
      await pageB.reload({ waitUntil: 'networkidle' });
      await frameB.locator('h1:has-text("Welcome to our community")').waitFor({ timeout: 30_000 });

      // Publish Tab A. Depending on timing the modal either offers "Continue in background" (still
      // running) or completes outright ("Start new edit"): wait for whichever appears first.
      await pageA.click('button:has-text("Publish")');
      await pageA.click('button:has-text("Publish to Live Site")');
      const bgBtn = pageA.locator('button:has-text("Continue in background")');
      const doneBtn = pageA.locator('button:has-text("Start new edit")');
      await bgBtn.or(doneBtn).first().waitFor({ timeout: 30_000 });
      if (await bgBtn.isVisible()) {
        await bgBtn.click();
        await pageA.waitForSelector('header:has-text("Published"), button:has-text("Undo publication")', {
          timeout: 30_000,
        });
      } else {
        await doneBtn.waitFor({ timeout: 30_000 });
      }

      // Now Tab B pulls latest from advanced `main` via "Get latest" and receives Tab A's published h1!
      await pageB.click('button[title="Pull latest updates from the live site"]');
      await frameB.locator('h1:has-text("Welcome to Crossing — Live From Tab A")').waitFor({
        timeout: 30_000,
      });
    } catch (err) {
      console.error('=== 2-TAB ISOLATION & BG PUBLISH LOGS ===\n' + stack.logs.join(''));
      throw err;
    } finally {
      await context.close();
      await stack.close();
    }
  });
});
