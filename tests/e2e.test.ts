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

  await fs.writeFile(
    path.join(repoDir, 'src/pages/index.astro'),
    `---
import { url } from '../lib/url';
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Home | Fixture</title></head>
  <body>
    <main>
      <h1>Welcome to our community</h1>
      <p>Join us every Sunday morning at 10am.</p>
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
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      emit('content_block_stop', { type: 'content_block_stop', index });
    } else {
      hasToolUse = true;
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
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
  let prCounter = 0;
  let merged = false;
  let mergeSha = 'deadbeef00000000000000000000000000000001';
  let currentPr: {
    number: number;
    title: string;
    body: string;
    headBranch: string;
    headSha: string;
  } | null = null;

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
      if (currentPr && !merged) {
        res.writeHead(200);
        res.end(
          JSON.stringify([
            {
              number: currentPr.number,
              html_url: `https://github.com/test/site/pull/${currentPr.number}`,
              node_id: `PR_fake_${currentPr.number}`,
              head: { sha: currentPr.headSha },
            },
          ]),
        );
      } else {
        res.writeHead(200);
        res.end('[]');
      }
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
      currentPr = {
        number: prCounter,
        title: body.title,
        body: body.body,
        headBranch: body.head,
        headSha,
      };
      res.writeHead(201);
      res.end(
        JSON.stringify({
          number: currentPr.number,
          html_url: `https://github.com/test/site/pull/${currentPr.number}`,
          node_id: `PR_fake_${currentPr.number}`,
          head: { sha: currentPr.headSha },
        }),
      );
      return;
    }

    // Get PR state
    if (req.method === 'GET' && /\/pulls\/\d+$/.test(urlPath)) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          merged,
          merge_commit_sha: merged ? mergeSha : null,
          state: merged ? 'closed' : 'open',
          head: { sha: currentPr?.headSha || 'abc1234' },
        }),
      );
      return;
    }

    // Check runs
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

    // Squash merge
    if (req.method === 'PUT' && /\/pulls\/\d+\/merge$/.test(urlPath)) {
      merged = true;
      res.writeHead(200);
      res.end(JSON.stringify({ sha: mergeSha, merged: true }));
      return;
    }

    // Actions runs (Pages deploy)
    if (req.method === 'GET' && urlPath.endsWith('/actions/runs')) {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          workflow_runs: [{ id: 1, name: 'Deploy Pages', status: 'completed', conclusion: 'success' }],
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
        isMerged: () => merged,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('Halley E2E (with fake Anthropic SSE + fake GitHub + real Astro & Playwright)', () => {
  let tmpDir = '';
  let cpProc: ChildProcess | null = null;
  let fakeAnthropic: Awaited<ReturnType<typeof startFakeAnthropicServer>>;
  let fakeGitHub: Awaited<ReturnType<typeof startFakeGitHubServer>>;
  let cpPort = 0;

  let cpLogs: string[] = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-e2e-'));
    const repoDir = path.join(tmpDir, 'fixture-repo');
    const dataDir = path.join(tmpDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await createFixtureAstroRepo(repoDir);

    fakeAnthropic = await startFakeAnthropicServer();
    fakeGitHub = await startFakeGitHubServer(repoDir);
    cpPort = await getFreePort();

    cpProc = spawn(process.execPath, ['packages/control-plane/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(cpPort),
        HALLEY_PUBLIC_URL: `http://127.0.0.1:${cpPort}`,
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
        WORKSPACE_DRIVER: 'local',
        HALLEY_DEV_LOGIN: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cpProc.stdout?.on('data', (d) => cpLogs.push(d.toString()));
    cpProc.stderr?.on('data', (d) => cpLogs.push(d.toString()));

    // Wait for control-plane /api/health
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${cpPort}/api/health`);
        if (res.ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  afterAll(async () => {
    if (cpProc && cpProc.exitCode === null) {
      cpProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (cpProc.exitCode === null) cpProc.kill('SIGKILL');
    }
    await fakeAnthropic?.close();
    await fakeGitHub?.close();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('signs in, creates unlisted page, edits inline, runs multi-page Pi turns, checks, and publishes via fake GitHub', async () => {
    const baseUrl = `http://127.0.0.1:${cpPort}`;
    const browser = await chromium.launch({ headless: true });

    let page: import('playwright').Page | null = null;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await context.newPage();

      // 1. Sign in via dev-login UI
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.fill('input[placeholder="admin@example.com (optional)"]', 'editor@thecrossing.website');
      await page.click('button:has-text("Dev Sign In")');
      await page.waitForSelector('input[placeholder*="Easter service times"]');

      // 2. Create session
      await page.fill('input[placeholder*="Easter service times"]', 'E2E Fake Flow');
      await page.click('button:has-text("New edit")');

      // Wait for editor & iframe preview to boot
      await page.waitForSelector('iframe', { timeout: 60_000 });
      const frameLocator = page.frameLocator('iframe');
      await frameLocator.locator('h1:has-text("Welcome to our community")').waitFor({ timeout: 60_000 });

      // 3. Switch to Edit mode (Browse is default) and apply inline fine-tuning edit
      await page.click('button:has-text("Edit")');
      const pEl = frameLocator.locator('p').first();
      await pEl.click();
      await pEl.evaluate((el) => {
        el.textContent = 'Join us every Sunday morning at 10am — coffee at 9:30am!';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pEl.evaluate((el) => el.blur());
      await page.waitForTimeout(800);

      // 4. Open Page Switcher and create an unlisted page
      await page.click('button[title="Switch or create page"]');
      await page.click('button:has-text("New page (or unlisted page)")');
      await page.fill('input[placeholder="e.g., spring-retreat"]', 'womens-gathering');
      await page.click('label:has-text("Keep unlisted")');
      await page.click('button:has-text("Create with Halley")');

      // Wait for Turn 1 Pi reply
      await page.waitForSelector('text=unlisted Women', { timeout: 30_000 });

      // Verify Page Switcher lists the new unlisted page
      await page.click('button[title="Switch or create page"]');
      await page.waitForSelector('text=Unlisted');
      await page.click('button:has-text("/womens-gathering")');
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
      console.error('=== CONTROL PLANE LOGS ===\n' + cpLogs.join(''));
      throw err;
    } finally {
      await browser.close();
    }
  });
});
