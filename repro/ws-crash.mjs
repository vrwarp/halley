// Boots the REAL built control-plane as a child process, signs in via dev-login, opens the chat
// WebSocket, and sends one frame larger than the server's 2MB maxPayload. Reports whether the
// whole control-plane process dies.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('packages/control-plane/package.json'));
const { WebSocket } = require('ws');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-wscrash-'));
const port = 39000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, ['packages/control-plane/dist/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: tmp, HALLEY_DEV_LOGIN: 'true', SESSION_SECRET: 'x'.repeat(64),
    HALLEY_PUBLIC_URL: `http://127.0.0.1:${port}`, WORKSPACE_HOST_URL: 'http://127.0.0.1:1', HALLEY_WARM_POOL_SIZE: '0',
    HALLEY_ALLOWED_DOMAINS: 'x.test', GITHUB_TOKEN: '', ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
let exit = null;
child.on('exit', (code, signal) => (exit = { code, signal }));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@x.test', name: 'A' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'T' }) });
const cj = await created.json();
const sessionId = cj.session?.id ?? cj.id;
console.log('login', login.status, 'create', created.status, 'session', sessionId, 'alive-before:', exit === null);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, { headers: { Cookie: cookie, Origin: base } });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.on('error', () => {}); ws.on('close', () => {});
ws.send(Buffer.alloc(3 * 1024 * 1024, 0x61)); // 3MB > 2MB maxPayload
await new Promise((r) => setTimeout(r, 2500));
let healthAfter = 'unreachable';
try { healthAfter = String((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).status); } catch {}
console.log('RESULT process-exit:', JSON.stringify(exit), '| /api/health after frame:', healthAfter);
console.log('--- last server output ---\n' + log.split('\n').slice(-14).join('\n'));
child.kill('SIGKILL');
await fs.rm(tmp, { recursive: true, force: true });
process.exit(0);
