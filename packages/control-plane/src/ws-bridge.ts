import { type ChatServerMessage, type PublishProgressPayload } from '@halley/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { type TimerHandle } from './clock.js';
import { WorkspaceCrashLoopError } from './drivers/workspace-driver.js';
import { ignore, logger } from './log.js';
import { isAllowedWsOrigin } from './proxy/preview-proxy.js';
import {
  PUBLISH_LOCKED_STATES,
  type App,
  type ControlPlaneContext,
  type ControlPlaneExtras,
} from './control-plane-context.js';

/**
 * Chat WebSocket bridge (browser <-> workspace runner) and the upgrade router (preview HMR goes to
 * the preview proxy). Returns the upgrade handler the HTTP server wires to its 'upgrade' event.
 */
export function register(
  _app: App,
  ctx: ControlPlaneContext,
  extra: Pick<ControlPlaneExtras, 'previewProxy' | 'resumePendingRevert'>,
) {
  const { config, clock, nowIso, db, auth, driver, browserWsBySession } = ctx;
  const { previewProxy, resumePendingRevert } = extra;
  const MAX_PENDING_WS_MESSAGES = 50;
  const WS_PING_INTERVAL_MS = 20_000;

  const handleWsUpgrade = (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ) => {
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    const wsProto = req.headers['sec-websocket-protocol'] || '';
    if (urlPath.startsWith('/p/') || wsProto.includes('vite-hmr')) {
      void previewProxy.handleUpgrade(req, socket, head);
      return;
    }

    // Without an 'error' listener a client reset on the raw socket is an uncaught exception
    socket.on('error', (err) => {
      ignore(err, 'chat ws upgrade socket error', { url: req.url }, 'debug');
      socket.destroy();
    });

    if (!isAllowedWsOrigin(req, config.publicUrl)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const chatMatch = urlPath.match(/^\/ws\/sessions\/([^/]+)$/);
    if (!chatMatch?.[1]) {
      socket.destroy();
      return;
    }
    const user = auth.getUserFromCookieHeader(req.headers.cookie);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(chatMatch[1]);
    const session = db.getSession(sessionId);
    if (!session) {
      socket.destroy();
      return;
    }

    const handleBrowserSocket = async (browserWs: WebSocket) => {
      // ws emits 'error' for protocol violations (e.g. a frame over maxPayload, invalid UTF-8) and
      // socket resets. An EventEmitter 'error' with no listener crashes the whole process.
      browserWs.on('error', (err) => {
        logger.warn('chat ws error from browser; closing socket', { sessionId, err });
        browserWs.terminate();
      });

      let set = browserWsBySession.get(sessionId);
      if (!set) {
        set = new Set();
        browserWsBySession.set(sessionId, set);
      }
      set.add(browserWs);

      let runnerWs: WebSocket | null = null;
      let browserClosed = false;
      const pendingMessages: string[] = [];

      // Every WS_PING_INTERVAL_MS (on the injected clock): ping the browser so reverse proxies
      // (Synology Nginx, Cloudflare, etc.) don't drop idle WebSockets, and check the runner leg.
      // A runner socket still CONNECTING, or OPEN but silent since the previous ping, after a full
      // interval is stuck: terminate it, which closes the browser with 1012 so the client reconnects.
      let runnerPrevState: number | null = null;
      let runnerAwaitingPong = false;
      let pingTimer: TimerHandle | null = null;
      const pingTick = () => {
        pingTimer = null;
        if (browserClosed) return;
        if (browserWs.readyState === WebSocket.OPEN) browserWs.ping();
        const rws = runnerWs;
        if (rws) {
          const state = rws.readyState;
          if (state === WebSocket.CONNECTING && runnerPrevState === WebSocket.CONNECTING) {
            logger.warn('chat ws: runner connection stuck connecting; terminating', { sessionId });
            rws.terminate();
          } else if (state === WebSocket.OPEN && runnerAwaitingPong) {
            logger.warn('chat ws: runner connection unresponsive to ping; terminating', { sessionId });
            rws.terminate();
          } else if (state === WebSocket.OPEN) {
            runnerAwaitingPong = true;
            rws.ping();
          }
          runnerPrevState = state;
        }
        pingTimer = clock.setTimeout(pingTick, WS_PING_INTERVAL_MS);
      };
      pingTimer = clock.setTimeout(pingTick, WS_PING_INTERVAL_MS);

      // Register close handler BEFORE awaiting driver.ensureRunning so early disconnects
      // never leak pingTimer, browserWsBySession entries, or orphan runnerWs sockets.
      browserWs.on('close', () => {
        browserClosed = true;
        clock.clearTimeout(pingTimer);
        pingTimer = null;
        set?.delete(browserWs);
        // Drop the session's entry with its last socket (the map must not grow with every session)
        if (set && set.size === 0 && browserWsBySession.get(sessionId) === set) browserWsBySession.delete(sessionId);
        if (
          runnerWs &&
          (runnerWs.readyState === WebSocket.OPEN || runnerWs.readyState === WebSocket.CONNECTING)
        ) {
          runnerWs.close();
        }
      });

      const buildPublishPayload = (s: import('./db.js').SessionRecord): PublishProgressPayload => ({
        state: s.publish_state,
        prNumber: s.pr_number,
        prUrl: s.pr_url,
        error: s.publish_error,
      });

      // Push current spend, publish status, state sync, and boot progress immediately
      const latestSession = db.getSession(sessionId) ?? session;
      const spend = db.getSpendStatus(latestSession.owner_user_id);
      const initialPublishPayload = buildPublishPayload(latestSession);
      const initialAstroReady = driver.isSessionAstroReady
        ? driver.isSessionAstroReady(sessionId)
        : Boolean(latestSession.astro_url && latestSession.status === 'running');
      browserWs.send(JSON.stringify({ type: 'spend_status', ...spend }));
      browserWs.send(JSON.stringify({ type: 'publish_state', payload: initialPublishPayload }));
      browserWs.send(
        JSON.stringify({
          type: 'session_state_sync',
          workspaceLocked: PUBLISH_LOCKED_STATES.has(latestSession.publish_state),
          previewPaused: false,
          astroReady: initialAstroReady,
          publishProgress: initialPublishPayload,
        } satisfies ChatServerMessage),
      );
      const currentBootProgress = driver.getBootProgress?.(sessionId);
      if (currentBootProgress) {
        browserWs.send(JSON.stringify({ type: 'boot_progress', progress: currentBootProgress }));
      }

      browserWs.on('message', (data) => {
        try {
          onBrowserMessage(data);
        } catch (err) {
          logger.error('chat ws message handling failed', { sessionId, err });
        }
      });
      const onBrowserMessage = (data: import('ws').RawData) => {
        const curSession = db.getSession(sessionId) ?? latestSession;
        const canEdit =
          (curSession.owner_user_id === user.id || user.isAdmin) &&
          curSession.status !== 'published' &&
          curSession.status !== 'merged';
        if (!canEdit) {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(
              JSON.stringify({
                type: 'error',
                message: 'This session is read-only. You do not have permission to send edits.',
              }),
            );
          }
          return;
        }
        db.touchSessionActivity(sessionId);
        driver.touchSession?.(sessionId);
        const str = data.toString();
        if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
          runnerWs.send(str);
        } else if (pendingMessages.length < MAX_PENDING_WS_MESSAGES) {
          pendingMessages.push(str);
        } else if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(
            JSON.stringify({
              type: 'error',
              message: 'Workspace is still starting — too many queued messages.',
            }),
          );
        }
      };

      try {
        const ep = await driver.ensureRunning(latestSession);
        if (browserClosed || browserWs.readyState !== WebSocket.OPEN) {
          return;
        }
        if (latestSession.kind === 'revert') {
          void resumePendingRevert(sessionId)
            .then((message) => {
              if (message && browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'error', message } satisfies ChatServerMessage));
              }
            })
            .catch((err) => logger.error('revert: resuming pending revert failed', { sessionId, err }));
        }
        const wsUrl = ep.runnerUrl.replace(/^http/, 'ws') + '/ws';
        runnerWs = new WebSocket(wsUrl);
        runnerWs.on('pong', () => {
          runnerAwaitingPong = false;
        });
        runnerWs.on('open', () => {
          if (browserClosed) {
            runnerWs?.close();
            return;
          }
          while (pendingMessages.length > 0 && runnerWs?.readyState === WebSocket.OPEN) {
            runnerWs.send(pendingMessages.shift()!);
          }
        });
        runnerWs.on('error', (err) => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(
              JSON.stringify({
                type: 'error',
                message: `Workspace connection error: ${err.message}`,
              }),
            );
          }
        });
        runnerWs.on('close', () => {
          // Close the browser socket with 1012 (Service Restart) so the client reconnects
          // cleanly instead of black-holing prompts to a dead runner socket.
          if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
            browserWs.close(1012, 'Workspace connection closed');
          }
        });
        runnerWs.on('message', (data) => {
          runnerAwaitingPong = false; // any frame proves the runner leg is alive
          if (browserWs.readyState !== WebSocket.OPEN) return;
          const raw = data.toString();
          // Only state-sync frames are rewritten; skip JSON.parse for every other (streaming) frame
          if (raw.includes('"session_state_sync"')) {
            try {
              const parsed = JSON.parse(raw) as { type?: string; workspaceLocked?: boolean };
              if (parsed.type === 'session_state_sync') {
                const cur = db.getSession(sessionId);
                const enriched = {
                  ...parsed,
                  ...(cur
                    ? {
                        publishProgress: buildPublishPayload(cur),
                        workspaceLocked: Boolean(parsed.workspaceLocked) || PUBLISH_LOCKED_STATES.has(cur.publish_state),
                      }
                    : {}),
                };
                browserWs.send(JSON.stringify(enriched));
                return;
              }
            } catch (err) {
              ignore(err, 'chat ws: unparseable state-sync frame from runner; forwarding raw', { sessionId }, 'debug');
            }
          }
          browserWs.send(raw);
        });
      } catch (err) {
        if (!browserClosed && browserWs.readyState === WebSocket.OPEN) {
          if (err instanceof WorkspaceCrashLoopError) {
            const now = nowIso();
            browserWs.send(
              JSON.stringify({
                type: 'boot_progress',
                progress: {
                  stage: 'error',
                  message: err.oom
                    ? 'Workspace ran out of memory'
                    : 'Workspace paused after repeated crashes',
                  detail: err.message,
                  startedAt: now,
                  updatedAt: now,
                  crashLoop: true,
                  oom: err.oom,
                  retryAfterSec: err.retryAfterSec,
                },
              }),
            );
          }
          browserWs.send(
            JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'Workspace failed to connect',
            }),
          );
        }
      }
    };

    wss.handleUpgrade(req, socket, head, (browserWs) => {
      void handleBrowserSocket(browserWs).catch((err) => {
        logger.error('chat ws handler failed', { sessionId, err });
        try {
          browserWs.close(1011, 'Internal error');
        } catch (closeErr) {
          ignore(closeErr, 'closing chat ws after handler failure failed', { sessionId }, 'debug');
        }
      });
    });
  };
  return { handleWsUpgrade };
}
