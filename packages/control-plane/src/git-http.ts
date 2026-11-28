import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { deriveInternalHostToken, extractBearerToken, safeEqualToken } from '@halley/shared/auth';
import type { Context } from 'hono';
import { realClock, type Clock } from './clock.js';
import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb } from './db.js';
import { ignore, logger } from './log.js';

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
  }).catch((err) => {
    // Without receivepack, workspace pushes are refused with 403: make that diagnosable
    logger.error('git-http: enabling http.receivepack on the mirror failed', { mirrorDir, err });
  });
  const hooksDir = path.join(mirrorDir, 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-receive');
  await fs.writeFile(hookPath, PRE_RECEIVE_HOOK, { mode: 0o755 });
}

function extractGitAuthToken(authHeader?: string | null): string {
  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;
  if (authHeader && /^basic\s+/i.test(authHeader.trim())) {
    // Buffer.from(..., 'base64') never throws: invalid characters are skipped, so a malformed
    // header simply yields a token that fails the constant-time comparison downstream.
    const decoded = Buffer.from(authHeader.trim().replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx >= 0 ? decoded.slice(idx + 1).trim() : decoded.trim();
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
  clock: Clock = realClock,
): (c: Context) => Promise<Response> {
  const projectRoot = path.join(config.dataDir, 'git-mirror');
  const derivedHostToken = deriveInternalHostToken(config.sessionSecret);

  return async (c: Context): Promise<Response> => {
    const token = extractGitAuthToken(c.req.header('authorization'));
    const okDerived = safeEqualToken(token, derivedHostToken);
    const okExplicit = config.workspaceHostSecret
      ? safeEqualToken(token, config.workspaceHostSecret)
      : false;
    // The host token is the common case: only fall back to the per-session lookup when it didn't match
    const ok =
      okDerived || okExplicit || Boolean(token && db.resolveSessionByWorkspaceToken(token));
    if (!ok) {
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

    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.raw.body !== null;
    // Stream the request body straight into git-http-backend. With a Content-Length it reads that
    // many bytes; without one (chunked pushes) it reads stdin until EOF.
    const contentLength = hasBody ? c.req.header('content-length') : '0';

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: queryString,
      REQUEST_METHOD: c.req.method,
      REMOTE_USER: 'halley-workspaces',
      CONTENT_TYPE: contentType,
    };
    if (contentLength !== undefined) env.CONTENT_LENGTH = contentLength;
    const gitProtocol = c.req.header('git-protocol');
    if (gitProtocol) env.HTTP_GIT_PROTOCOL = gitProtocol;
    const contentEncoding = c.req.header('content-encoding');
    if (contentEncoding) env.HTTP_CONTENT_ENCODING = contentEncoding;

    const child = spawn(backendPath, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    let finished = false;
    const kill = (reason: string) => {
      if (finished) return;
      finished = true;
      clock.clearTimeout(killTimer);
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn('git-http: killing git-http-backend', { reason, pathInfo });
        child.kill('SIGKILL');
      }
    };
    // Hard cap on the whole exchange, streaming included
    const killTimer = clock.setTimeout(() => kill('timed out after 45s'), 45_000);
    const onAbort = () => kill('client aborted');
    c.req.raw.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => {
      finished = true;
      clock.clearTimeout(killTimer);
      c.req.raw.signal?.removeEventListener('abort', onAbort);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < 64 * 1024) {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    });
    // EPIPE when git-http-backend exits before consuming the whole body (e.g. auth/ref rejection)
    child.stdin.on('error', (err) => ignore(err, 'git-http: backend closed stdin early', { pathInfo }, 'debug'));

    if (hasBody) {
      const reqStream = Readable.fromWeb(c.req.raw.body as unknown as NodeReadableStream<Uint8Array>);
      reqStream.on('error', (err) => {
        ignore(err, 'git-http: request body stream failed', { pathInfo }, 'debug');
        kill('request body stream failed');
      });
      reqStream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    // Read only the CGI header block, then hand the rest of stdout to the response as a stream
    let head: { status: number; headers: Headers; rest: Buffer };
    try {
      head = await readCgiHeaders(child, () => Buffer.concat(errChunks).toString('utf8'));
    } catch (err) {
      kill('failed before sending headers');
      throw err;
    }

    const out = child.stdout;
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.rest.length > 0) controller.enqueue(new Uint8Array(head.rest));
        out.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) out.pause();
        });
        out.on('end', () => controller.close());
        out.on('error', (err) => controller.error(err));
        child.on('close', (code, signal) => {
          if (signal) {
            try {
              controller.error(new Error(`git-http-backend killed (${signal})`));
            } catch (closeErr) {
              ignore(closeErr, 'git-http: response stream already closed', { pathInfo }, 'debug');
            }
          } else if (code !== 0) {
            logger.warn('git-http: git-http-backend exited non-zero', {
              code,
              pathInfo,
              stderr: Buffer.concat(errChunks).toString('utf8').slice(0, 2000),
            });
          }
        });
      },
      pull() {
        out.resume();
      },
      cancel() {
        kill('response cancelled');
      },
    });

    return new Response(bodyStream, { status: head.status, headers: head.headers });
  };
}

/** Accumulates stdout until the CGI header terminator, parses Status/headers, returns the rest. */
function readCgiHeaders(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<{ status: number; headers: Headers; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const out = child.stdout!;
    let buf: Buffer = Buffer.alloc(0);
    const cleanup = () => {
      out.off('data', onData);
      out.off('end', onEnd);
      child.off('error', onError);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      if (buf.length === 0) {
        reject(new Error(`git-http-backend produced no output: ${stderr().slice(0, 2000)}`));
        return;
      }
      // No header block: pass everything through as the body (matches the old behaviour)
      resolve({ status: 200, headers: new Headers(), rest: buf });
    };
    const onData = (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let sepIdx = buf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = buf.indexOf('\n\n');
        sepLen = 2;
      }
      if (sepIdx === -1) {
        if (buf.length > 64 * 1024) {
          cleanup();
          reject(new Error('git-http-backend sent an oversized CGI header block'));
        }
        return;
      }
      cleanup();
      out.pause();
      const headers = new Headers();
      let status = 200;
      for (const line of buf.subarray(0, sepIdx).toString('utf8').split(/\r?\n/)) {
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
      resolve({ status, headers, rest: buf.subarray(sepIdx + sepLen) });
    };
    out.on('data', onData);
    out.on('end', onEnd);
    child.on('error', onError);
  });
}
