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
      delta: { type: 'text_delta', text: 'Docker smoke Pi turn succeeded!' },
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

async function createMinimalAstroSiteWithLockfile(dir: string): Promise<void> {
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
      <p>Static copy inside ephemeral workspace container.</p>
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
  const dataVol = `halley-data-smoke-${process.pid}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-docker-smoke-'));
  const repoDir = path.join(tmp, 'site-repo');
  let sessionId = '';
  let dupSessionId = '';
  let anthropicServer: http.Server | null = null;

  try {
    console.log('[docker-smoke] 1. Creating fixture Astro git repo…');
    await createMinimalAstroSiteWithLockfile(repoDir);

    const fakeLlmPort = await getFreePort();
    const hostPort = await getFreePort();
    anthropicServer = await startFakeAnthropicOnAllInterfaces(fakeLlmPort);

    console.log(`[docker-smoke] 2. Creating network ${netName} & data volume ${dataVol}…`);
    await run('docker', ['network', 'create', netName]);
    await run('docker', ['volume', 'create', dataVol]);

    // Inspect gateway IP of the custom bridge network so control-plane container can reach fake Anthropic on host
    const gatewayIp = await run('docker', [
      'network',
      'inspect',
      netName,
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ]);

    // Ensure workspace entry script supports npm install when no lockfile is present
    console.log('[docker-smoke] 3. Starting halley-control-plane container (auto-network + docker.sock)…');
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
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-e',
      'WORKSPACE_DRIVER=docker',
      '-e',
      'WORKSPACE_IMAGE=halley-workspace:ci-smoke',
      // Deliberately OMIT WORKSPACE_DOCKER_NETWORK to verify auto-detection of netName!
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

    // Copy fixture git repo into control-plane container at /tmp/fixture-repo
    await run('docker', ['cp', repoDir, `${cpName}:/tmp/fixture-repo`]);

    const cpUrl = `http://127.0.0.1:${hostPort}`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${cpUrl}/api/health`);
        if (res.ok) break;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log('[docker-smoke] 4. Checking /api/health/doctor preflight…');
    const docRes = await fetch(`${cpUrl}/api/health/doctor`);
    const docJson = (await docRes.json()) as { ok: boolean; errors: string[]; details: { dataDirMounted?: boolean } };
    if (!docJson.ok) {
      throw new Error(`Doctor check failed: ${JSON.stringify(docJson)}`);
    }
    if (!docJson.details.dataDirMounted) {
      throw new Error(`Expected dataDirMounted=true in doctor report: ${JSON.stringify(docJson)}`);
    }

    console.log('[docker-smoke] 5. Logging in and creating Docker-backed session…');
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
      body: JSON.stringify({ title: 'Docker Smoke Session' }),
    });
    if (!createRes.ok) throw new Error(`Create session failed: ${createRes.status}`);
    const { session } = (await createRes.json()) as { session: { id: string } };
    sessionId = session.id;

    console.log(`[docker-smoke] 6. Waiting for halley-ws-${sessionId.slice(0, 12)} container & Astro dev preview…`);
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
          throw new Error(`Vite allowedHosts blocked Docker preview request: ${text}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!previewHtml.includes('Docker Workspace Alive')) {
      const cpLogs = await run('docker', ['logs', cpName]).catch(() => '');
      const wsLogs = await run('docker', ['logs', `halley-ws-${sessionId.slice(0, 12)}`]).catch(() => '');
      throw new Error(`Timed out waiting for Docker preview.\nCP logs:\n${cpLogs}\nWS logs:\n${wsLogs}`);
    }
    console.log('[docker-smoke] 7. Verified live preview HTML via preview-proxy (no Vite host block)!');

    console.log('[docker-smoke] 7b. Verifying root /@vite/client module proxy returns JavaScript (not text/html)…');
    const viteClientRes = await fetch(`${cpUrl}/@vite/client`, {
      headers: {
        Cookie: cookie,
        Referer: `${cpUrl}/p/${sessionId}/docker-site/`,
      },
    });
    const viteClientCt = viteClientRes.headers.get('content-type') || '';
    if (!viteClientRes.ok || !viteClientCt.includes('javascript')) {
      throw new Error(
        `Expected /@vite/client with preview Referer to return JS, got status=${viteClientRes.status} content-type=${viteClientCt}`,
      );
    }

    console.log('[docker-smoke] 8. Verifying AST /__editor/inspect inside Docker workspace…');
    const inspectRes = await fetch(`${cpUrl}/p/${sessionId}/docker-site/__editor/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ file: 'src/pages/index.astro', loc: '7:7' }),
    });
    const inspectJson = (await inspectRes.json()) as { editability?: string };
    if (inspectJson.editability !== 'editable-static') {
      throw new Error(`Expected p at 7:7 to be editable-static, got: ${JSON.stringify(inspectJson)}`);
    }

    console.log('[docker-smoke] 9. Verifying shared Chromium POST /internal/screenshot in control-plane against workspace container…');
    const wsEnvLines = (
      await run('docker', [
        'inspect',
        `halley-ws-${sessionId.slice(0, 12)}`,
        '--format',
        '{{range .Config.Env}}{{println .}}{{end}}',
      ])
    ).split(/\r?\n/);
    const wsTokenLine = wsEnvLines.find((l) => l.startsWith('WORKSPACE_TOKEN='));
    const wsToken = wsTokenLine ? wsTokenLine.slice('WORKSPACE_TOKEN='.length) : '';
    if (!wsToken) {
      throw new Error('Failed to extract WORKSPACE_TOKEN from workspace container env');
    }

    const shotRes = await fetch(`${cpUrl}/internal/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wsToken}`,
      },
      body: JSON.stringify({ route: '/', viewport: 'desktop' }),
    });
    if (!shotRes.ok) {
      throw new Error(`POST /internal/screenshot failed (${shotRes.status}): ${await shotRes.text()}`);
    }
    if (shotRes.headers.get('content-type') !== 'image/jpeg') {
      throw new Error(`Expected image/jpeg from /internal/screenshot, got ${shotRes.headers.get('content-type')}`);
    }
    const shotBytes = Buffer.from(await shotRes.arrayBuffer());
    if (shotBytes.length < 100 || shotBytes[0] !== 0xff || shotBytes[1] !== 0xd8 || shotBytes[2] !== 0xff) {
      throw new Error(`Expected valid JPEG bytes from /internal/screenshot, got ${shotBytes.length} bytes`);
    }

    console.log('[docker-smoke] 10. Verifying privilege drop to `node`, duplicateWorkspace, and legacy UID 1001 volume self-healing…');
    const wsContainer = `halley-ws-${sessionId.slice(0, 12)}`;
    const pid1Owner = await run('docker', ['exec', wsContainer, 'stat', '-c', '%U', '/proc/1']);
    if (pid1Owner !== 'node') {
      throw new Error(`Expected PID 1 inside workspace container to run as unprivileged 'node', got '${pid1Owner}'`);
    }

    // 10a. Duplicate workspace and verify duplicated volume boots cleanly without ERR_SQLITE_ERROR
    const dupRes = await fetch(`${cpUrl}/api/sessions/${sessionId}/duplicate`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (!dupRes.ok) {
      throw new Error(`Duplicate session failed (${dupRes.status}): ${await dupRes.text()}`);
    }
    const { session: dupSession } = (await dupRes.json()) as { session: { id: string } };
    dupSessionId = dupSession.id;
    const dupDeadline = Date.now() + 90_000;
    let dupReady = false;
    while (Date.now() < dupDeadline) {
      const dsRes = await fetch(`${cpUrl}/api/sessions/${dupSessionId}`, { headers: { Cookie: cookie } });
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
      throw new Error('Timed out waiting for duplicated session workspace to become ready');
    }

    // 10b. Simulate legacy UID 1001 (pwuser) + read-only mode bits on /halley-volume/state & pi.sqlite, then wake
    await run('docker', ['rm', '-f', wsContainer]);
    await run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-v',
      `halley-ws-${sessionId}:/halley-volume`,
      'halley-workspace:ci-smoke',
      '-c',
      'chown -R 1001:1001 /halley-volume && chmod 0755 /halley-volume/state && chmod 0444 /halley-volume/state/pi.sqlite',
    ]);

    const wakeRes = await fetch(`${cpUrl}/api/sessions/${sessionId}/wake`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (!wakeRes.ok) {
      throw new Error(`Wake after UID 1001 simulation failed (${wakeRes.status}): ${await wakeRes.text()}`);
    }
    const wakeDeadline = Date.now() + 90_000;
    let wokeCleanly = false;
    while (Date.now() < wakeDeadline) {
      const wsRes = await fetch(`${cpUrl}/api/sessions/${sessionId}`, { headers: { Cookie: cookie } });
      const wsData = (await wsRes.json()) as { session: { status: string; bootProgress?: { detail?: string } } };
      if (wsData.session.status === 'error') {
        throw new Error(`Woken legacy-UID session failed (ERR_SQLITE_ERROR regression): ${JSON.stringify(wsData.session.bootProgress)}`);
      }
      if (wsData.session.status === 'running') {
        wokeCleanly = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!wokeCleanly) {
      throw new Error('Timed out waiting for legacy-UID session to self-heal and wake');
    }

    console.log('[docker-smoke] SUCCESS — Docker-in-Docker orchestration verified end-to-end!');
  } finally {
    anthropicServer?.close();
    if (dupSessionId) {
      await run('docker', ['rm', '-f', `halley-ws-${dupSessionId.slice(0, 12)}`]).catch(() => {});
      await run('docker', ['volume', 'rm', '-f', `halley-ws-${dupSessionId}`]).catch(() => {});
    }
    if (sessionId) {
      await run('docker', ['rm', '-f', `halley-ws-${sessionId.slice(0, 12)}`]).catch(() => {});
      await run('docker', ['volume', 'rm', '-f', `halley-ws-${sessionId}`]).catch(() => {});
    }
    await run('docker', ['rm', '-f', cpName]).catch(() => {});
    await run('docker', ['volume', 'rm', '-f', dataVol]).catch(() => {});
    await run('docker', ['network', 'rm', netName]).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[docker-smoke] FAILED:', err);
  process.exit(1);
});
