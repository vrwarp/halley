// Serves the REAL built web bundle against a fake backend and observes the UI in Chromium.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('packages/control-plane/package.json'));
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const dist = path.resolve('packages/web/dist');
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };

function serve(api) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) return api(req, res, u);
    let f = path.join(dist, u.pathname);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
const failures = [];
function check(label, cond, detail = '') {
  console.log(`   ${cond ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures.push(label);
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

// --- Scenario A: backend answers 500 to everything (e.g. control-plane mid-restart behind a proxy)
{
  const meTimes = [];
  let healthy = false;
  const srv = await serve((req, res, u) => {
    if (u.pathname === '/api/auth/me') meTimes.push(Date.now());
    if (healthy && u.pathname === '/api/auth/me') return json(res, 200, { authenticated: false, repo: 'o/r', devLoginEnabled: true });
    return json(res, 500, { error: 'boom' });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForTimeout(8000);
  const text = (await page.innerText('body')).trim().replace(/\s+/g, ' ').slice(0, 120);
  console.log('A) /api/* => 500, after 8s body text:', JSON.stringify(text), '| uncaught page errors:', errors.length, errors[0] ?? '');
  const gaps = meTimes.slice(1).map((t, i) => t - meTimes[i]);
  check('A: error message visible', text.includes('boom'));
  check('A: Retry button visible', (await page.getByRole('button', { name: 'Retry' }).count()) > 0);
  check('A: not stuck on "Loading Halley…"', !text.includes('Loading Halley'));
  check('A: auto-retried with backoff', meTimes.length >= 3 && gaps.every((g, i) => i === 0 || g >= gaps[i - 1] * 1.5), `me hits=${meTimes.length} gaps=${gaps.join(',')}`);
  // Recovery via the Retry button once the backend is healthy again
  healthy = true;
  await page.getByRole('button', { name: 'Retry' }).first().click();
  await page.waitForTimeout(1000);
  const after = (await page.innerText('body')).trim().replace(/\s+/g, ' ');
  check('A: Retry recovers once backend is healthy', !after.includes('boom') && !after.includes('Loading Halley'), after.slice(0, 80));
  check('A: no uncaught page errors', errors.length === 0, errors[0] ?? '');
  await page.close(); srv.close();
}

// --- Scenario B: signed in, editor open, session fetch fails; and a malformed / error WS frame
{
  const hits = {};
  const sessionTimes = [];
  const user = { id: 'u1', email: 'a@x.test', name: 'A', picture: null, isAdmin: false, persona: 'editor' };
  const srv = await serve((req, res, u) => {
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    if (u.pathname === '/api/sessions/s1') sessionTimes.push(Date.now());
    const spend = { capped: false, spentUsd: 0, capUsd: 10, remainingUsd: 10 };
    if (u.pathname === '/api/auth/me') return json(res, 200, { authenticated: true, user, repo: 'o/r', spend });
    if (u.pathname === '/api/sessions') return json(res, 200, { sessions: [], spend });
    return json(res, 500, { error: 'boom' });
  });
  const wss = new WebSocketServer({ server: srv });
  let wsConnections = 0;
  wss.on('connection', (ws) => {
    wsConnections++;
    ws.send(JSON.stringify({ type: 'error', message: 'Session is read-only' }));
    ws.send('this is not json');
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/?session=s1`);
  await page.waitForTimeout(8000);
  const text = (await page.innerText('body')).trim().replace(/\s+/g, ' ').slice(0, 160);
  console.log('B) session fetch => 500, after 8s body text:', JSON.stringify(text));
  console.log('   ws connections:', wsConnections, '| uncaught page errors:', errors.length, JSON.stringify(errors.slice(0, 3)));
  console.log('   api hits:', JSON.stringify(hits));
  console.log('   "read-only" error message visible to user:', text.includes('read-only'));
  const gaps = sessionTimes.slice(1).map((t, i) => t - sessionTimes[i]);
  check('B: not stuck on "Loading workspace…"', !text.includes('Loading workspace'));
  check('B: load error visible with Retry', text.includes('boom') && (await page.getByRole('button', { name: 'Retry' }).count()) > 0);
  check('B: session fetch retried with backoff', sessionTimes.length >= 3 && gaps.every((g, i) => i === 0 || g >= gaps[i - 1] * 1.5), `hits=${sessionTimes.length} gaps=${gaps.join(',')}`);
  check('B: server error frame shown to user', text.includes('read-only'));
  const dismiss = page.getByTestId('editor-error-notice').getByRole('button', { name: 'Dismiss' });
  check('B: error notice dismissible', (await dismiss.count()) === 1);
  if ((await dismiss.count()) === 1) {
    await dismiss.click();
    check('B: notice gone after dismiss', !(await page.innerText('body')).includes('read-only'));
  }
  check('B: no uncaught page errors (malformed frame ignored)', errors.length === 0, errors[0] ?? '');
  await page.close(); srv.close();
}
// --- Scenario C: editor loaded, WS server drops every connection, HTTP prompt fallback fails
{
  const user = { id: 'u1', email: 'a@x.test', name: 'A', picture: null, isAdmin: false, persona: 'editor' };
  const spend = { spentTodayUsd: 0, dailyCapUsd: 10, extraGrantedUsd: 0, capped: false };
  const now = new Date().toISOString();
  const session = {
    id: 's1', title: 'Draft', slug: 'draft', kind: 'edit', parentSessionId: null, revertsSha: null, revertReason: null,
    ownerUserId: 'u1', ownerName: 'A', ownerEmail: 'a@x.test', ownerPicture: null, isOwner: true, canEdit: true,
    repo: 'o/r', baseBranch: 'main', workingBranch: 'w', baseSha: 'abc', prevBaseSha: null, status: 'running',
    astroReady: true, bootProgress: null, publishState: 'idle', publishError: null, prNumber: null, prUrl: null,
    mergedSha: null, mergedAt: null, archivedAt: null, volumeExpired: false, astroBase: '/', changedFilesCount: 0,
    lastActiveAt: now, createdAt: now,
  };
  let promptPosts = 0;
  const srv = await serve((req, res, u) => {
    if (u.pathname === '/api/auth/me') return json(res, 200, { authenticated: true, user, repo: 'o/r', spend });
    if (u.pathname === '/api/sessions') return json(res, 200, { sessions: [session], spend });
    if (u.pathname === '/api/sessions/s1') return json(res, 200, { session, spend });
    if (u.pathname === '/api/sessions/s1/prompt') { promptPosts++; return json(res, 500, { error: 'runner unavailable' }); }
    if (u.pathname === '/api/sessions/s1/transcript') return json(res, 200, { entries: [], live: { busy: false, activeTools: [], queuedCount: 0 } });
    return json(res, 500, { error: 'boom' });
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => ws.terminate());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/?session=s1`);
  await page.waitForTimeout(4000);
  check('C: reconnecting indicator visible while WS is down', (await page.getByTestId('ws-connection-indicator').count()) === 1);
  const box = page.locator('textarea').first();
  await box.fill('Please update the hero heading');
  await page.getByRole('button', { name: /Send/ }).first().click();
  await page.waitForTimeout(1500);
  check('C: HTTP fallback attempted', promptPosts === 1, `posts=${promptPosts}`);
  check('C: draft kept after failed send', (await box.inputValue()) === 'Please update the hero heading');
  check('C: send failure shown', (await page.innerText('body')).includes('runner unavailable'));
  check('C: no uncaught page errors', errors.length === 0, errors[0] ?? '');
  await page.close(); srv.close();
}
await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
