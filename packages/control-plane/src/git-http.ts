import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { deriveInternalHostToken, extractBearerToken, safeEqualToken } from '@halley/shared/auth';
import type { Context } from 'hono';
import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb } from './db.js';

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

function extractGitAuthToken(authHeader?: string | null): string {
  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;
  if (authHeader && /^basic\s+/i.test(authHeader.trim())) {
    try {
      const decoded = Buffer.from(authHeader.trim().replace(/^basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(idx + 1).trim() : decoded.trim();
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Hono handler serving `/internal/git/repo.git/*` via `git-http-backend`.
 * Keeps all GitHub credentials strictly inside control-plane: `workspaces` only ever
 * fetches from and pushes `halley/*` working branches to this internal endpoint.
 * Mandatory Bearer auth is enforced unconditionally via HKDF-derived host/workspace tokens.
 */
export function createInternalGitHttpHandler(
  config: HalleyConfig,
  db: ControlPlaneDb,
  ensureMirrorReady: () => Promise<void>,
): (c: Context) => Promise<Response> {
  const projectRoot = path.join(config.dataDir, 'git-mirror');
  const derivedHostToken = deriveInternalHostToken(config.sessionSecret);

  return async (c: Context): Promise<Response> => {
    const token = extractGitAuthToken(c.req.header('authorization'));
    const okDerived = safeEqualToken(token, derivedHostToken);
    const okExplicit = config.workspaceHostSecret
      ? safeEqualToken(token, config.workspaceHostSecret)
      : false;
    const okSession = Boolean(token && db.resolveSessionByWorkspaceToken(token));
    if (!okDerived && !okExplicit && !okSession) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="halley-internal-git"' },
      });
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
      let settled = false;
      const finish = (err: Error | null, buf?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        c.req.raw.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(buf ?? Buffer.alloc(0));
      };
      const onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(new Error('git-http-backend request aborted'));
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(new Error('git-http-backend timed out after 45s'));
      }, 45_000);
      c.req.raw.signal?.addEventListener('abort', onAbort, { once: true });

      // Swallow EPIPE if git-http-backend exits early before consuming a >64KB request body
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (code !== 0 && outChunks.length === 0) {
          finish(new Error(`git-http-backend exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
          return;
        }
        finish(null, Buffer.concat(outChunks));
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
