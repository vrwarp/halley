import { ChatClientMessageSchema, type ChatServerMessage } from '@halley/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RunnerWsHandlers, WsClientState } from './index.js';
import { ignoreExpected, logger } from './log.js';
import type { RunnerContext } from './runner-context.js';

/**
 * The runner's WebSocket side: connection setup (snapshot frames, client commands), and the
 * ping/pong heartbeat on the injected clock (a client that missed two pongs is terminated).
 */
export function createRunnerWs(ctx: RunnerContext): { wss: WebSocketServer; wsHandlers: RunnerWsHandlers } {
  const {
    config,
    clock,
    wsClients,
    wsEpoch,
    safeSend,
    pageService,
    astroManager,
    cancelSpeculativeVerify,
  } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  wss.on('error', (err) => logger.error('ws: server error', { err }));

  function handleConnection(ws: WebSocket): void {
    const state: WsClientState = { missedPongs: 0, queue: [], pendingTranscript: null, seq: 0 };
    wsClients.set(ws, state);
    // An unhandled 'error' on a socket (ECONNRESET, invalid frame) would crash the whole runner
    ws.on('error', (err) => {
      ignoreExpected(err, 'ws: client socket error');
      wsClients.delete(ws);
    });
    ws.on('pong', () => {
      state.missedPongs = 0;
    });
    // Snapshot frames: consecutive seqs; the client rebases on the first frame of a connection
    if (ctx.latestTranscript) {
      safeSend(ws, ctx.lastTranscriptPayload || JSON.stringify(ctx.latestTranscript));
    }
    safeSend(
      ws,
      JSON.stringify({
        type: 'page_requests_sync',
        pageRequests: pageService.listPageRequests(),
      }),
    );
    safeSend(
      ws,
      JSON.stringify({
        type: 'session_state_sync',
        workspaceLocked: ctx.currentWorkspaceLocked,
        lockedFile: ctx.currentLockedFile,
        previewPaused: ctx.currentPreviewPaused,
        previewPauseReason: ctx.currentPreviewPauseReason,
        astroReady: astroManager.getStatus().ready,
        mergeReview: ctx.activeMergeState,
      } satisfies ChatServerMessage),
    );
    ws.on('message', async (raw) => {
      if (ctx.draining) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Workspace is going to sleep; reconnect to wake it.' }));
        return;
      }
      if (ctx.readOnly) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Session is read-only' }));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch (err) {
        ignoreExpected(err, 'ws: client sent a non-JSON frame');
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid JSON frame' }));
        return;
      }
      try {
        const parsed = ChatClientMessageSchema.parse(frame);
        if (parsed.type === 'submit_input') {
          cancelSpeculativeVerify();
          await ctx.piRuntime?.submitUserInput(parsed);
        } else if (parsed.type === 'abort') {
          await ctx.piRuntime?.abort();
        } else if (parsed.type === 'continue_run') {
          cancelSpeculativeVerify();
          await ctx.piRuntime?.continueRun();
        }
      } catch (err) {
        safeSend(
          ws,
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Invalid command',
          }),
        );
      }
    });
    ws.on('close', () => wsClients.delete(ws));
  }

  /** Pings every client; a client that missed two consecutive pongs is terminated (half-open TCP). */
  function heartbeat(): void {
    for (const [ws, state] of wsClients) {
      if (state.missedPongs >= 2) {
        logger.info('ws: terminating client that missed 2 heartbeats');
        wsClients.delete(ws);
        ws.terminate();
        continue;
      }
      state.missedPongs++;
      try {
        ws.ping();
      } catch (err) {
        ignoreExpected(err, 'ws: ping failed (socket closing)');
      }
    }
  }
  const armHeartbeat = () => {
    if (ctx.shuttingDown || config.wsHeartbeatMs <= 0) return;
    ctx.wsHeartbeatTimer = clock.setTimeout(() => {
      heartbeat();
      armHeartbeat();
    }, config.wsHeartbeatMs);
    ctx.wsHeartbeatTimer.unref?.();
  };
  armHeartbeat();

  const wsHandlers: RunnerWsHandlers = {
    handleConnection,
    heartbeat,
    clientCount: () => wsClients.size,
    maxMissedPongs: () => Math.max(0, ...[...wsClients.values()].map((c) => c.missedPongs)),
    // highest seq sent on any open connection (per-connection counters)
    sequence: () => ({ epoch: wsEpoch, seq: Math.max(0, ...[...wsClients.values()].map((c) => c.seq)) }),
  };

  return { wss, wsHandlers };
}
