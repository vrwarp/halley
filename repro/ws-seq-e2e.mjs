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
const check = (l, c, d = '') => { console.log(`   ${c ? 'PASS' : 'FAIL'}: ${l}${d ? ` (${d})` : ''}`); if (!c) failures.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
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
const hits = { transcript: 0, changes: 0 };
const entry = (id, text) => ({ id, role: 'assistant', text, createdAt: Date.now() });
let serverEntries = [entry('e1', 'first message')];
const srv = await serve((req, res, u) => {
  if (u.pathname === '/api/auth/me') return json(res, 200, { authenticated: true, user, repo: 'o/r', spend });
  if (u.pathname === '/api/sessions') return json(res, 200, { sessions: [session], spend });
  if (u.pathname === '/api/sessions/s1') return json(res, 200, { session, spend });
  if (u.pathname === '/api/sessions/s1/transcript') { hits.transcript++; return json(res, 200, { entries: serverEntries, live: { busy: false, activeTools: [], queuedCount: 0 } }); }
  if (u.pathname === '/api/sessions/s1/changes') { hits.changes++; return json(res, 200, { changes: [], checkpoints: [] }); }
  if (u.pathname === '/api/sessions/s1/routes') return json(res, 200, { routes: [] });
  return json(res, 404, { error: 'nope' });
});
const wss = new WebSocketServer({ server: srv });
let sock = null; let conns = 0;
wss.on('connection', (ws) => { sock = ws; conns++; });
const live = { busy: false, activeTools: [], queuedCount: 0 };
const send = (f) => sock.send(JSON.stringify(f));
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = []; const logs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => logs.push(m.text()));
await page.goto(`http://127.0.0.1:${srv.address().port}/?session=s1`);
for (let i = 0; i < 50 && !sock; i++) await sleep(100);
await sleep(500);
send({ type: 'transcript_state', entries: serverEntries, live, usageUsd: 0, seq: 1, epoch: 'boot-a' });
send({ type: 'transcript_state', entries: [...serverEntries, entry('e2', 'second message')], live, usageUsd: 0, seq: 2, epoch: 'boot-a' });
await sleep(500);
check('D: in-order frames applied', (await page.innerText('body')).includes('second message'));
let base = { ...hits };
// duplicate with different content must be dropped
send({ type: 'transcript_state', entries: [...serverEntries, entry('e2', 'second message'), entry('dup', 'DUPLICATE SHOULD NOT SHOW')], live, usageUsd: 0, seq: 2, epoch: 'boot-a' });
await sleep(500);
check('D: duplicate seq dropped', !(await page.innerText('body')).includes('DUPLICATE SHOULD NOT SHOW'));
check('D: no resync for in-order/duplicate', hits.transcript === base.transcript && hits.changes === base.changes, JSON.stringify(hits));
// gap: server says seq 5 (3,4 lost, e.g. a checkpoint_created) -> full resync
serverEntries = [entry('e1', 'first message'), entry('e2', 'second message'), entry('e3', 'third via resync')];
send({ type: 'spend_status', spentTodayUsd: 0, dailyCapUsd: 10, extraGrantedUsd: 0, capped: false, seq: 5, epoch: 'boot-a' });
await sleep(800);
check('D: gap triggers transcript + changes/checkpoints resync', hits.transcript > base.transcript && hits.changes > base.changes, JSON.stringify(hits));
check('D: resynced transcript rendered', (await page.innerText('body')).includes('third via resync'));
// 1012 close -> reconnect -> resync
base = { ...hits };
sock.close(1012, 'restart');
for (let i = 0; i < 80 && conns < 2; i++) await sleep(100);
await sleep(800);
check('D: reconnected after 1012', conns >= 2, `conns=${conns}`);
check('D: resync after 1012 reconnect', hits.transcript > base.transcript && hits.changes > base.changes, JSON.stringify(hits));
// epoch change on the new connection's 2nd frame -> resync
send({ type: 'spend_status', spentTodayUsd: 0, dailyCapUsd: 10, extraGrantedUsd: 0, capped: false, seq: 6, epoch: 'boot-a' });
await sleep(300);
base = { ...hits };
send({ type: 'spend_status', spentTodayUsd: 0, dailyCapUsd: 10, extraGrantedUsd: 0, capped: false, seq: 1, epoch: 'boot-b' });
await sleep(800);
check('D: epoch change triggers resync', hits.transcript > base.transcript, JSON.stringify(hits));
// legacy frames (no seq/epoch) still applied, no resync
base = { ...hits };
send({ type: 'transcript_state', entries: [...serverEntries, entry('e4', 'legacy frame applied')], live, usageUsd: 0 });
await sleep(500);
check('D: legacy frames without seq applied', (await page.innerText('body')).includes('legacy frame applied'));
check('D: no resync for legacy frames', hits.transcript === base.transcript, JSON.stringify(hits));
check('D: resync logged', logs.some((l) => l.includes('resyncing')), logs.filter((l) => l.includes('halley')).slice(0, 5).join(' | '));
check('D: no uncaught page errors', errors.length === 0, errors[0] ?? '');
await page.close(); srv.close(); await browser.close();
if (failures.length) { console.error('FAILED', failures); process.exit(1); }
console.log('All D checks passed'); process.exit(0);
