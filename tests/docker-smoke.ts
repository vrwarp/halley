import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], cwd = process.cwd()): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '0.0.0.0', () => {
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

function startFakeAnthropicOnAllInterfaces(port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
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
        id: 'msg_docker_smoke_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-5-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    });
    emit('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '2-container Docker smoke Pi turn succeeded!' },
    });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    emit('message_stop', { type: 'message_stop' });
    res.end();
  });

  return new Promise((resolve) => {
    srv.listen(port, '0.0.0.0', () => resolve(srv));
  });
}

async function createMinimalAstroSite(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src/pages'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'docker-smoke-site',
        version: '0.0.1',
        private: true,
        type: 'module',
        dependencies: {
          astro: '^5.5.0',
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(dir, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config';
export default defineConfig({ base: '/docker-site' });
`,
  );
  await fs.writeFile(
    path.join(dir, 'src/pages/index.astro'),
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Docker Smoke</title></head>
  <body>
    <main>
      <h1>Docker Workspace Alive — Em Dash Check</h1>
      <p>Static copy inside shared workspaces container.</p>
    </main>
  </body>
</html>
`,
  );
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n.astro/\n');

  await run('git', ['init', '-b', 'main'], dir);
  await run('git', ['config', 'user.name', 'Smoke Bot'], dir);
  await run('git', ['config', 'user.email', 'smoke@example.org'], dir);
  await run('git', ['add', '-A'], dir);
  await run('git', ['commit', '-m', 'init'], dir);
}

async function main() {
  const netName = `halley-smoke-net-${process.pid}`;
  const cpName = `halley-cp-smoke-${process.pid}`;
  const wsName = `halley-ws-smoke-${process.pid}`;
  const dataVol = `halley-data-smoke-${process.pid}`;
  const wsVol = `halley-ws-vol-smoke-${process.pid}`;
  const hostSecret = `smoke-secret-${process.pid}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-docker-smoke-'));
  const repoDir = path.join(tmp, 'site-repo');
  let anthropicServer: http.Server | null = null;

  try {
    console.log('[docker-smoke] 1. Creating fixture Astro git repo…');
    await createMinimalAstroSite(repoDir);

    const fakeLlmPort = await getFreePort();
    const hostPort = await getFreePort();
    anthropicServer = await startFakeAnthropicOnAllInterfaces(fakeLlmPort);

    console.log(`[docker-smoke] 2. Creating network ${netName} & volumes (${dataVol}, ${wsVol})…`);
    await run('docker', ['network', 'create', netName]);
    await run('docker', ['volume', 'create', dataVol]);
    await run('docker', ['volume', 'create', wsVol]);

    const gatewayIp = await run('docker', [
      'network',
      'inspect',
      netName,
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ]);

    console.log('[docker-smoke] 3a. Starting halley-workspace container (unprivileged, zero secrets, zero docker.sock)…');
    await run('docker', [
      'run',
      '-d',
      '--name',
      wsName,
      '--network',
      netName,
      '-v',
      `${wsVol}:/workspaces`,
      '-e',
      'WORKSPACES_DIR=/workspaces',
      '-e',
      'SUPERVISOR_PORT=4000',
      '-e',
      `CONTROL_PLANE_INTERNAL_URL=http://${cpName}:3000`,
      '-e',
      `WORKSPACE_HOST_SECRET=${hostSecret}`,
      '-e',
      'HALLEY_REPO=smoke/site',
      '-e',
      'HALLEY_BASE_BRANCH=main',
      '-e',
      'HALLEY_WARM_POOL_SIZE=1',
      '-e',
      'MAX_ACTIVE_WORKSPACES=5',
      'halley-workspace:ci-smoke',
    ]);

    // Deliberately wait 2s before starting control-plane to exercise workspaces-first cold boot
    await new Promise((r) => setTimeout(r, 2000));

    console.log('[docker-smoke] 3b. Starting halley-control-plane container (zero docker.sock)…');
    await run('docker', [
      'run',
      '-d',
      '--name',
      cpName,
      '--network',
      netName,
      '-p',
      `127.0.0.1:${hostPort}:3000`,
      '-v',
      `${dataVol}:/data`,
      '-e',
      `WORKSPACE_HOST_URL=http://${wsName}:4000`,
      '-e',
      `WORKSPACE_HOST_SECRET=${hostSecret}`,
      '-e',
      `CONTROL_PLANE_INTERNAL_URL=http://${cpName}:3000`,
      '-e',
      'HALLEY_REPO=smoke/site',
      '-e',
      'HALLEY_BASE_BRANCH=main',
      '-e',
      'HALLEY_DEV_LOCAL_REPO=/tmp/fixture-repo',
      '-e',
      'HALLEY_DEV_LOGIN=true',
      '-e',
      'HALLEY_ALLOWED_DOMAINS=thecrossing.website',
      '-e',
      'ANTHROPIC_API_KEY=fake-key',
      '-e',
      `ANTHROPIC_BASE_URL=http://${gatewayIp}:${fakeLlmPort}`,
      '-e',
      'GITHUB_TOKEN=fake-token',
      'halley-control-plane:ci-smoke',
    ]);

    // Copy fixture git repo into control-plane ONLY (workspaces must clone via internal HTTP mirror!)
    await run('docker', ['cp', repoDir, `${cpName}:/tmp/fixture-repo`]);

    const cpUrl = `http://127.0.0.1:${hostPort}`;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${cpUrl}/api/health`);
        if (res.ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log('[docker-smoke] 4. Checking /api/health/doctor & waiting for warm standby pool (HALLEY_WARM_POOL_SIZE=1)…');
    let warmReady = false;
    const warmDeadline = Date.now() + 120_000;
    while (Date.now() < warmDeadline) {
      const docRes = await fetch(`${cpUrl}/api/health/doctor`);
      const docJson = (await docRes.json()) as {
        ok: boolean;
        errors: string[];
        details: {
          supervisor?: {
            protocolVersion?: number;
            warmPool?: { enabled?: boolean; ready?: number };
          };
        };
      };
      if (!docJson.ok) {
        throw new Error(`Doctor check failed: ${JSON.stringify(docJson)}`);
      }
      if (!docJson.details.supervisor?.protocolVersion) {
        throw new Error(`Expected supervisor protocolVersion in doctor report: ${JSON.stringify(docJson)}`);
      }
      if ((docJson.details.supervisor?.warmPool?.ready ?? 0) >= 1) {
        warmReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!warmReady) {
      const wsLogs = await run('docker', ['logs', wsName]).catch(() => '');
      throw new Error(`Timed out waiting for warm standby pool to become ready.\nWS logs:\n${wsLogs}`);
    }

    console.log('[docker-smoke] 5. Verifying workspaces PID 1 dropped privileges to `node`…');
    const pid1Owner = await run('docker', ['exec', wsName, 'stat', '-c', '%U', '/proc/1']);
    if (pid1Owner !== 'node') {
      throw new Error(`Expected PID 1 inside workspaces container to run as 'node', got '${pid1Owner}'`);
    }

    console.log('[docker-smoke] 6. Logging in and creating session (cloning via internal Git HTTP mirror)…');
    const loginRes = await fetch(`${cpUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'editor@thecrossing.website', name: 'Smoke Editor' }),
    });
    if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    const createRes = await fetch(`${cpUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: '2-Container Smoke Session' }),
    });
    if (!createRes.ok) throw new Error(`Create session failed: ${createRes.status}`);
    const { session } = (await createRes.json()) as { session: { id: string } };
    const sessionId = session.id;

    console.log(`[docker-smoke] 7. Waiting for session ${sessionId.slice(0, 8)} Astro preview…`);
    let previewHtml = '';
    const bootDeadline = Date.now() + 120_000;
    while (Date.now() < bootDeadline) {
      const sRes = await fetch(`${cpUrl}/api/sessions/${sessionId}`, { headers: { Cookie: cookie } });
      const sData = (await sRes.json()) as { session: { status: string; publishError?: string } };
      if (sData.session.status === 'error') {
        throw new Error(`Session entered error state: ${sData.session.publishError}`);
      }
      if (sData.session.status === 'running') {
        const prevRes = await fetch(`${cpUrl}/p/${sessionId}/docker-site/`, {
          headers: { Cookie: cookie },
        });
        const text = await prevRes.text();
        if (prevRes.status === 200 && text.includes('Docker Workspace Alive')) {
          previewHtml = text;
          break;
        }
        if (prevRes.status === 403 || text.includes('Blocked request')) {
          throw new Error(`Vite allowedHosts blocked preview request: ${text}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!previewHtml.includes('Docker Workspace Alive')) {
      const cpLogs = await run('docker', ['logs', cpName]).catch(() => '');
      const wsLogs = await run('docker', ['logs', wsName]).catch(() => '');
      throw new Error(`Timed out waiting for preview.\nCP logs:\n${cpLogs}\nWS logs:\n${wsLogs}`);
    }
    console.log('[docker-smoke] 8. Verified live preview HTML + /@vite/client + AST /__editor/inspect!');

    const viteClientRes = await fetch(`${cpUrl}/@vite/client`, {
      headers: { Cookie: cookie, Referer: `${cpUrl}/p/${sessionId}/docker-site/` },
    });
    const viteClientCt = viteClientRes.headers.get('content-type') || '';
    if (!viteClientRes.ok || !viteClientCt.includes('javascript')) {
      throw new Error(`Expected /@vite/client JS, got status=${viteClientRes.status} ct=${viteClientCt}`);
    }

    const inspectRes = await fetch(`${cpUrl}/p/${sessionId}/docker-site/__editor/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ file: 'src/pages/index.astro', loc: '7:7' }),
    });
    const inspectJson = (await inspectRes.json()) as { editability?: string };
    if (inspectJson.editability !== 'editable-static') {
      throw new Error(`Expected p at 7:7 to be editable-static, got: ${JSON.stringify(inspectJson)}`);
    }

    console.log('[docker-smoke] 9. Verifying session duplication inside shared workspaces container…');
    const dupRes = await fetch(`${cpUrl}/api/sessions/${sessionId}/duplicate`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (!dupRes.ok) {
      throw new Error(`Duplicate session failed (${dupRes.status}): ${await dupRes.text()}`);
    }
    const { session: dupSession } = (await dupRes.json()) as { session: { id: string } };
    const dupDeadline = Date.now() + 90_000;
    let dupReady = false;
    while (Date.now() < dupDeadline) {
      const dsRes = await fetch(`${cpUrl}/api/sessions/${dupSession.id}`, { headers: { Cookie: cookie } });
      const dsData = (await dsRes.json()) as { session: { status: string; bootProgress?: { detail?: string } } };
      if (dsData.session.status === 'error') {
        throw new Error(`Duplicated session entered error state: ${JSON.stringify(dsData.session.bootProgress)}`);
      }
      if (dsData.session.status === 'running') {
        dupReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!dupReady) {
      throw new Error('Timed out waiting for duplicated session to boot');
    }

    console.log('[docker-smoke] 10. Restarting workspaces container and verifying state reconciliation + lazy wake…');
    await run('docker', ['restart', wsName]);
    // Wait for doctor to report healthy again (which reconciles DB sessions to sleeping)
    const reconDeadline = Date.now() + 20_000;
    while (Date.now() < reconDeadline) {
      const r = await fetch(`${cpUrl}/api/health/doctor`);
      if (r.ok) break;
      await new Promise((r2) => setTimeout(r2, 400));
    }
    const afterRestartRes = await fetch(`${cpUrl}/api/sessions/${sessionId}`, { headers: { Cookie: cookie } });
    const afterRestart = (await afterRestartRes.json()) as { session: { status: string } };
    if (afterRestart.session.status !== 'sleeping') {
      throw new Error(`Expected session to reconcile to 'sleeping' after workspaces restart, got '${afterRestart.session.status}'`);
    }

    // Simulate an interrupted/partial node_modules directory (empty dir, missing astro) before waking
    await run('docker', [
      'exec',
      wsName,
      'sh',
      '-c',
      `rm -rf /workspaces/sessions/${sessionId}/workspace/node_modules && mkdir -p /workspaces/sessions/${sessionId}/workspace/node_modules`,
    ]);

    const wakeRes = await fetch(`${cpUrl}/api/sessions/${sessionId}/wake`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (!wakeRes.ok) throw new Error(`Wake failed: ${wakeRes.status}`);
    const wakeDeadline = Date.now() + 90_000;
    let woke = false;
    while (Date.now() < wakeDeadline) {
      const wRes = await fetch(`${cpUrl}/api/sessions/${sessionId}`, { headers: { Cookie: cookie } });
      const wData = (await wRes.json()) as { session: { status: string; publishError?: string } };
      if (wData.session.status === 'error') {
        throw new Error(`Woken session failed: ${wData.session.publishError}`);
      }
      if (wData.session.status === 'running') {
        woke = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!woke) throw new Error('Timed out waiting for session to wake after workspaces restart');

    console.log('[docker-smoke] SUCCESS — 2-container stack (zero docker.sock) verified end-to-end!');
  } finally {
    anthropicServer?.close();
    await run('docker', ['rm', '-f', cpName]).catch(() => {});
    await run('docker', ['rm', '-f', wsName]).catch(() => {});
    await run('docker', ['volume', 'rm', '-f', dataVol]).catch(() => {});
    await run('docker', ['volume', 'rm', '-f', wsVol]).catch(() => {});
    await run('docker', ['network', 'rm', netName]).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[docker-smoke] FAILED:', err);
  process.exit(1);
});
