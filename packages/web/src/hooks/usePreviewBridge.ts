import type {
  EditorSessionDto,
  ElementContext,
  PostMessageFromPreview,
  PostMessageToPreview,
  PreviewMode,
  PreviewRect,
} from '@halley/shared';
import { useEffect, useRef, useState } from 'react';
import { reportIgnored, useStableCallback } from '../lib/retry.js';

export type PreviewPin = { key: string; n: number };

export interface UsePreviewBridgeOptions {
  session: EditorSessionDto | null;
  mode: PreviewMode;
  persona: 'non-technical' | 'developer';
  isMobile: boolean;
  /** "Ask Halley…" pressed in the preview; `from` is the element rect in page coords (clipped). */
  onElementContext: (ctx: ElementContext, from: PreviewRect | null) => void;
  /** The user tapped/clicked inside the preview. */
  onPreviewPointerDown: () => void;
  /** An inline edit was saved to disk by the preview bridge. */
  onPatchSaved: () => void;
}

function previewPath(session: EditorSessionDto, route: string): string {
  const baseSuffix = session.astroBase === '/' ? '' : session.astroBase.replace(/\/$/, '');
  const clean = route.startsWith('/') ? route : `/${route}`;
  return `/p/${session.id}${baseSuffix}${clean}`;
}

/**
 * The editor side of the preview iframe's postMessage bridge: current route tracking, navigation,
 * (throttled) reloads, mode/pins/highlight messages and the inbound `halley:*` message handling.
 */
export function usePreviewBridge({
  session,
  mode,
  persona,
  isMobile,
  onElementContext,
  onPreviewPointerDown,
  onPatchSaved,
}: UsePreviewBridgeOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentRoute, setCurrentRoute] = useState('/');
  const currentRouteRef = useRef(currentRoute);
  currentRouteRef.current = currentRoute;
  const [previewSelectionActive, setPreviewSelectionActive] = useState(false);
  const lastPreviewReloadAtRef = useRef(0);
  const lastNavigationAtRef = useRef(0);
  const pendingRouteRef = useRef<string | null>(null);
  const pendingRouteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinsRef = useRef<PreviewPin[]>([]);
  const pendingHighlightKeyRef = useRef<string | null>(null);
  const onElementContextStable = useStableCallback(onElementContext);
  const onPreviewPointerDownStable = useStableCallback(onPreviewPointerDown);
  const onPatchSavedStable = useStableCallback(onPatchSaved);

  const postToPreview = (payload: PostMessageToPreview) => {
    try {
      iframeRef.current?.contentWindow?.postMessage(payload, window.location.origin);
    } catch (err) {
      // Cross-origin frame navigated externally; nothing to deliver the message to.
      reportIgnored(err, 'postMessage to preview iframe failed');
    }
  };

  const reloadPreview = (force = false) => {
    const now = Date.now();
    if (!force) {
      if (pendingRouteRef.current !== null) return;
      if (now - lastNavigationAtRef.current < 3000) return;
      if (now - lastPreviewReloadAtRef.current < 1200) return;
    }
    lastPreviewReloadAtRef.current = now;
    const frame = iframeRef.current;
    if (!frame) return;
    if (force && session) {
      try {
        const href = frame.contentWindow?.location?.href;
        if (!href || !href.includes(`/p/${session.id}`)) {
          frame.src = previewPath(session, currentRouteRef.current);
          return;
        }
      } catch {
        // Cross-origin frame navigated to external link in Browse mode: reset src back to preview!
        frame.src = previewPath(session, currentRouteRef.current);
        return;
      }
    }
    postToPreview({ type: 'halley:reload', force });
  };

  /** Navigates the iframe; returns false (doing nothing) before the session is loaded. */
  const navigatePreview = (route: string): boolean => {
    if (!session) return false;
    const clean = route.startsWith('/') ? route : `/${route}`;
    lastNavigationAtRef.current = Date.now();
    pendingRouteRef.current = clean;
    if (pendingRouteTimerRef.current) clearTimeout(pendingRouteTimerRef.current);
    pendingRouteTimerRef.current = setTimeout(() => {
      pendingRouteRef.current = null;
      pendingRouteTimerRef.current = null;
    }, 5_000);
    if (iframeRef.current) {
      iframeRef.current.src = previewPath(session, clean);
    }
    setCurrentRoute(clean);
    return true;
  };

  const highlightInPreview = (key: string | null) => {
    postToPreview({ type: 'halley:highlight', key });
  };

  /** Numbered chat-attachment markers for the current route (re-sent on every `halley:ready`). */
  const setPreviewPins = (pins: PreviewPin[]) => {
    pinsRef.current = pins;
    postToPreview({ type: 'halley:pins', pins });
  };

  /** Flash-highlight `key` once the preview reports ready (after a navigation). */
  const highlightOnNextReady = (key: string) => {
    pendingHighlightKeyRef.current = key;
  };

  useEffect(() => {
    if (!session) return;
    postToPreview({
      type: 'halley:set-mode',
      mode,
      readOnly: !session.canEdit,
      persona,
      touchLayout: isMobile,
    });
  }, [mode, session?.canEdit, persona, isMobile]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow || e.origin !== window.location.origin) {
        return;
      }
      const data = e.data as PostMessageFromPreview;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'halley:ready') {
        pendingRouteRef.current = null;
        if (pendingRouteTimerRef.current) {
          clearTimeout(pendingRouteTimerRef.current);
          pendingRouteTimerRef.current = null;
        }
        setCurrentRoute(data.route);
        setPreviewSelectionActive(false);
        if (session) {
          postToPreview({
            type: 'halley:set-mode',
            mode,
            readOnly: !session.canEdit,
            persona,
            touchLayout: isMobile,
          });
        }
        postToPreview({ type: 'halley:pins', pins: pinsRef.current });
        if (pendingHighlightKeyRef.current) {
          const k = pendingHighlightKeyRef.current;
          pendingHighlightKeyRef.current = null;
          postToPreview({ type: 'halley:highlight', key: k });
          setTimeout(() => {
            postToPreview({ type: 'halley:highlight', key: null });
          }, 1400);
        }
      } else if (data.type === 'halley:route-changed') {
        pendingRouteRef.current = null;
        if (pendingRouteTimerRef.current) {
          clearTimeout(pendingRouteTimerRef.current);
          pendingRouteTimerRef.current = null;
        }
        lastNavigationAtRef.current = Date.now();
        setCurrentRoute(data.route);
      } else if (data.type === 'halley:selection-changed') {
        setPreviewSelectionActive(Boolean(data.active));
      } else if (data.type === 'halley:preview-pointerdown') {
        onPreviewPointerDownStable();
      } else if (data.type === 'halley:element-context') {
        // Only sent when the user explicitly presses "Ask Halley…" in the preview.
        const frame = iframeRef.current?.getBoundingClientRect();
        let from: PreviewRect | null = null;
        if (data.rect && frame) {
          // Convert iframe-viewport coords to page coords, clipped to the visible frame.
          const left = Math.max(frame.left, frame.left + data.rect.left);
          const top = Math.max(frame.top, frame.top + data.rect.top);
          const right = Math.min(frame.right, frame.left + data.rect.left + data.rect.width);
          const bottom = Math.min(frame.bottom, frame.top + data.rect.top + data.rect.height);
          if (right > left && bottom > top) from = { left, top, width: right - left, height: bottom - top };
        }
        onElementContextStable(data.context, from);
      } else if (data.type === 'halley:patch-saved') {
        onPatchSavedStable();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [mode, session, persona, isMobile]);

  return {
    iframeRef,
    currentRoute,
    currentRouteRef,
    lastNavigationAtRef,
    previewSelectionActive,
    postToPreview,
    reloadPreview,
    navigatePreview,
    highlightInPreview,
    setPreviewPins,
    highlightOnNextReady,
  };
}
