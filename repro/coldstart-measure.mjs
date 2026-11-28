// Cold-start measurement: real runner (dist/index.js), real astro dev, local bare repo as upstream.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serve } from '/home/user/halley/node_modules/.pnpm/@hono+node-server@1.19.19_hono@4.13.20/node_modules/@hono/node-server/dist/index.js';
const SUP = '/home/user/halley/packages/workspace-runner/dist/supervisor.js';
const { createWorkspaceSupervisor } = await import(SUP);
const root = path.resolve(process.argv[2] || './run');
const mode = process.argv[3] || 'all';
await fs.rm(root, { recursive: true, force: true });
const site = path.join(root, 'site');
await fs.mkdir(path.join(site, 'src/pages'), { recursive: true });
await fs.writeFile(path.join(site, 'package.json'), JSON.stringify({ name: 'm', private: true, type: 'module', dependencies: { astro: '5.18.2' } }, null, 2));
await fs.writeFile(path.join(site, 'astro.config.mjs'), `import { defineConfig } from 'astro/config';\nexport default defineConfig({ site: 'https://example.org', base: '/test-site' });\n`);
await fs.writeFile(path.join(site, 'src/pages/index.astro'), `---\nconst t = 'Home';\n---\n<html><body><main><h1>Welcome to our community</h1><p>Join us.</p></main></body></html>\n`);
await fs.writeFile(path.join(site, '.gitignore'), 'node_modules/\n');
await fs.cp(path.join(process.cwd(), 'package-lock.json'), path.join(site, 'package-lock.json'));
const g = (cwd, ...a) => execFileSync('git', a, { cwd }).toString().trim();
g(site, 'init', '-q', '-b', 'main'); g(site, 'config', 'user.email', 'a@b.c'); g(site, 'config', 'user.name', 'a');
g(site, 'add', '-A'); g(site, 'commit', '-qm', 'init');
const ws = path.join(root, 'ws');
const remote = path.join(ws, 'cp', 'internal', 'git', 'repo.git');
await fs.mkdir(path.dirname(remote), { recursive: true });
execFileSync('git', ['clone', '-q', '--bare', site, remote]);
// pkg-cache shared across runs so "cold" = empty nm-cache but warm npm cache (prefer-offline)
const pkgCache = path.join(process.cwd(), 'pkg-cache-shared');
await fs.mkdir(path.join(ws, 'pkg-cache'), { recursive: true }).catch(() => {});
await fs.rm(path.join(ws, 'pkg-cache'), { recursive: true, force: true });
await fs.symlink(pkgCache, path.join(ws, 'pkg-cache')).catch(() => {});
await fs.mkdir(pkgCache, { recursive: true });

const warm = mode === 'warm';
const sup = createWorkspaceSupervisor({
  workspacesDir: ws, controlPlaneInternalUrl: path.join(ws, 'cp'), repo: 't/s', baseBranch: 'main',
  modelId: 'haiku-latest', thinkingLevel: 'off', gitBotName: 'B', gitBotEmail: 'b@x', warmPoolSize: warm ? 1 : 0,
  maxActiveWorkspaces: 4, bindHost: '127.0.0.1', port: 0,
});
const server = serve({ fetch: sup.app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
sup.setSupervisorSelfUrl(`http://127.0.0.1:${server.address().port}`);
const post = (p, b) => sup.app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const start = async (id) => {
  const t = Date.now();
  const r = await post(`/api/sessions/${id}/start`, { baseBranch: 'main', workingBranch: `halley/${id}`, workspaceToken: 'tok' });
  const body = await r.json();
  const wall = Date.now() - t;
  const pr = await (await sup.app.request(`/api/sessions/${id}/progress`)).json();
  if (r.status !== 200) throw new Error(JSON.stringify(body));
  return { wall, path: pr.phases?.path, phases: pr.phases?.phasesMs };
};
const out = {};
try {
  if (warm) {
    sup.startWarmPool();
    const deadline = Date.now() + 180_000;
    while (sup.getWarmPoolStatus().ready < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const r = await (await post('/api/warm/reserve')).json();
    const id = r.reserved.id;
    out.warmStandbyBoot = (await (await sup.app.request(`/api/sessions/${id}/progress`)).json()).phases;
    out.warmClaim = await start(id);
  } else {
    out.cold = await start('s-cold');           // empty nm-cache: real npm ci + manifest
    out.warmCache = await start('s-warmcache'); // nm-cache hit: verify + cp -al
    await post('/api/sessions/s-cold/stop');
    out.wake = await start('s-cold');            // session dir exists: no clone, node_modules unchanged
  }
} finally {
  await sup.stopAll();
  server.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
