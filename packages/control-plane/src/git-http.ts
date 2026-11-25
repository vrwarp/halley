import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Context } from 'hono';
import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb } from './db.js';
import { hashWorkspaceToken } from './proxy/llm-proxy.js';

const execFileAsync = promisify(execFile);

let cachedHttpBackendPath: string | null = null;

async function resolveGitHttpBackend(): Promise<string> {
  if (cachedHttpBackendPath) return cachedHttpBackendPath;
  const { stdout } = await execFileAsync('git', ['--exec-path']);
  cachedHttpBackendPath = path.join(stdout.trim(), 'git-http-backend');
  return cachedHttpBackendPath;
}

const PRE_RECEIVE_HOOK = `#!/bin/sh
while read oldrev newrev refname; do
  case "$refname" in
    refs/heads/halley/*) ;;
    *)
      echo "Rejected push to non-halley ref: $refname" >&2
      exit 1
      ;;
  esac
done
exit 0
`;

/**
 * Ensures the bare mirror at `mirrorDir` allows smart-HTTP receive-pack for `refs/heads/halley/*` only.
 */
export async function configureBareMirrorForHttp(mirrorDir: string): Promise<void> {
  await execFileAsync('git', ['-c', 'safe.directory=*', 'config', 'http.receivepack', 'true'], {
    cwd: mirrorDir,
  }).catch(() => {});
  const hooksDir = path.join(mirrorDir, 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-receive');
  await fs.writeFile(hookPath, PRE_RECEIVE_HOOK, { mode: 0o755 });
}

/**
 * Hono handler serving `/internal/git/repo.git/*` via `git-http-backend`.
 * Keeps all GitHub credentials strictly inside control-plane: `workspaces` only ever
 * fetches from and pushes `halley/*` working branches to this internal endpoint.
 */
export function createInternalGitHttpHandler(
  config: HalleyConfig,
  db: ControlPlaneDb,
  ensureMirrorReady: () => Promise<void>,
): (c: Context) => Promise<Response> {
  const projectRoot = path.join(config.dataDir, 'git-mirror');

  return async (c: Context): Promise<Response> => {
    // Authenticate: if WORKSPACE_HOST_SECRET is set, accept it OR any active WORKSPACE_TOKEN
    if (config.workspaceHostSecret) {
      const auth = c.req.header('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const okSecret = token === config.workspaceHostSecret;
      const okSession = Boolean(token && db.getSessionByTokenHash(hashWorkspaceToken(token)));
      if (!okSecret && !okSession) {
        return c.text('Unauthorized', 401);
      }
    }

    await ensureMirrorReady();

    const backendPath = await resolveGitHttpBackend();
    const url = new URL(c.req.url);
    const prefix = '/internal/git';
    const pathInfo = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
    const queryString = url.search.startsWith('?') ? url.search.slice(1) : '';
    const contentType = c.req.header('content-type') || '';

    const body =
      c.req.method === 'GET' || c.req.method === 'HEAD'
        ? Buffer.alloc(0)
        : Buffer.from(await c.req.arrayBuffer());

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: c.req.method,
      REMOTE_USER: 'halley-workspaces',
      CONTENT_TYPE: contentType,
      CONTENT_LENGTH: String(body.length),
    };
    const gitProtocol = c.req.header('git-protocol');
    if (gitProtocol) env.HTTP_GIT_PROTOCOL = gitProtocol;
    const contentEncoding = c.req.header('content-encoding');
    if (contentEncoding) env.HTTP_CONTENT_ENCODING = contentEncoding;

    const rawOut = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(backendPath, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 && outChunks.length === 0) {
          reject(new Error(`git-http-backend exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
          return;
        }
        resolve(Buffer.concat(outChunks));
      });
      if (body.length > 0) child.stdin.write(body);
      child.stdin.end();
    });

    // Parse CGI response headers (\r\n\r\n or \n\n)
    let sepIdx = rawOut.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (sepIdx === -1) {
      sepIdx = rawOut.indexOf('\n\n');
      sepLen = 2;
    }
    if (sepIdx === -1) {
      return new Response(new Uint8Array(rawOut), { status: 200 });
    }

    const headerText = rawOut.subarray(0, sepIdx).toString('utf8');
    const respBody = rawOut.subarray(sepIdx + sepLen);
    const headers = new Headers();
    let status = 200;

    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') {
        const parsed = parseInt(val, 10);
        if (!Number.isNaN(parsed)) status = parsed;
      } else {
        headers.append(key, val);
      }
    }

    return new Response(new Uint8Array(respBody), { status, headers });
  };
}
