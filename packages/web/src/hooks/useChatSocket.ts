import type { ChatServerMessage } from '@halley/shared';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../api.js';
import type { WsStatus } from '../components/EditorStatusOverlays.js';
import { parseServerFrame } from '../lib/client-frames.js';
import { errorMessage } from '../lib/retry.js';
import { createResyncScheduler, WsSequencer, type ResyncReason } from '../lib/ws-sequencer.js';

export interface UseChatSocketOptions {
  sessionId: string;
  /** While true (workspace crash loop) the socket does not reconnect and reports 'offline'. */
  haltedRef: MutableRefObject<boolean>;
  /** Every in-order (or gap-tolerated) server frame. Always the latest callback is invoked. */
  onMessage: (msg: ChatServerMessage) => void;
  /** Full state resync after lost/out-of-order frames, a runner restart or a reconnect. */
  onResync: (reason: ResyncReason) => Promise<void>;
  /** A client message could be delivered neither over the socket nor the HTTP fallback. */
  onSendError: (text: string) => void;
}

/** Reconnect delay after the n-th consecutive drop (1-based): 2s, 4s, 8s, 16s, 30s cap, + jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const baseDelay = Math.min(30_000, 2000 * 2 ** Math.min(attempt - 1, 4));
  return baseDelay + Math.floor(random() * 500);
}

/**
 * The session chat WebSocket: connect, reconnect with backoff, frame ordering (seq/epoch via
 * {@link WsSequencer}) with coalesced resyncs, and client-message dispatch with an HTTP fallback.
 * Liveness is left to the browser's WebSocket ping/pong handling: any close (including a server
 * heartbeat timeout) goes through the same reconnect + resync path.
 */
export function useChatSocket({ sessionId, haltedRef, onMessage, onResync, onSendError }: UseChatSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  // 'connecting' until the first open; 'reconnecting' after a drop; 'offline' when halted (crash loop).
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // Latest-callback refs: the WS effect only re-runs on [sessionId, reconnectNonce], so its
  // handlers must not call functions captured at connect time (they would see stale state).
  const handlersRef = useRef({ onMessage, onResync, onSendError });
  handlersRef.current = { onMessage, onResync, onSendError };

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const sequencer = new WsSequencer();
    const requestResync = createResyncScheduler((reason) =>
      disposed ? Promise.resolve() : handlersRef.current.onResync(reason),
    );
    setWsConnected(false);
    setWsStatus((prev) => (prev === 'connecting' ? prev : 'reconnecting'));

    const connect = () => {
      if (disposed || haltedRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/sessions/${sessionId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        if (!disposed) {
          setWsConnected(true);
          setWsStatus('open');
          const resync = sequencer.onOpen();
          if (resync) requestResync(resync);
        }
      };

      ws.onmessage = (evt) => {
        if (disposed) return;
        const msg = parseServerFrame(evt.data);
        if (!msg) {
          console.warn('[halley] ignoring malformed WebSocket frame', String(evt.data).slice(0, 200));
          return;
        }
        const decision = sequencer.observe(msg);
        if (decision.action === 'drop') {
          console.debug('[halley] dropping duplicate WebSocket frame', msg.type, decision.seq, '<=', decision.lastSeq);
          return;
        }
        if (decision.action === 'apply-and-resync') {
          console.warn(`[halley] WebSocket ${decision.reason} (${decision.detail}); resyncing`);
          requestResync(decision.reason);
        }
        try {
          handlersRef.current.onMessage(msg);
        } catch (err) {
          console.error('[halley] failed to handle WebSocket frame', msg.type, err);
        }
      };

      ws.onclose = (evt) => {
        if (disposed) return;
        sequencer.onClose(evt.code);
        if (evt.code === 1012 || evt.code === 1013) {
          console.info(`[halley] WebSocket closed with ${evt.code}; will resync on reconnect`);
        }
        setWsConnected(false);
        if (haltedRef.current) {
          setWsStatus('offline');
          return;
        }
        setWsStatus('reconnecting');
        attempt += 1;
        reconnectTimer = setTimeout(connect, reconnectDelayMs(attempt));
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [sessionId, reconnectNonce]);

  /** Tears down and re-establishes the socket (manual retry, wake from background, boot retry). */
  const reconnect = () => setReconnectNonce((n) => n + 1);

  const isOpen = () => Boolean(wsRef.current && wsRef.current.readyState === WebSocket.OPEN);

  /**
   * Sends over the open WebSocket, or falls back to HTTP. Resolves true once the message was
   * handed to an open socket or the HTTP fallback succeeded; false (with a visible notice) on failure.
   */
  const dispatchClientMessage = async (payload: Record<string, unknown>): Promise<boolean> => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (err) {
        console.warn('[halley] WebSocket send failed, falling back to HTTP', err);
      }
    }
    try {
      await api.sendClientMessage(sessionId, payload);
      return true;
    } catch (err) {
      handlersRef.current.onSendError(`Couldn't send to Halley: ${errorMessage(err)}`);
      return false;
    }
  };

  return { wsConnected, wsStatus, reconnect, isOpen, dispatchClientMessage };
}
