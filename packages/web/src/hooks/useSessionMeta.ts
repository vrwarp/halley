import type {
  BootProgressDto,
  CheckpointInfo,
  EditorSessionDto,
  SiteRouteEntryDto,
  SpendStatusDto,
} from '@halley/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { backoffDelayMs, errorMessage, useStableCallback } from '../lib/retry.js';

export type MetaRoutes = Array<{ route: string; label: string; unlisted?: boolean }> | null;

export interface UseSessionMetaOptions {
  sessionId: string;
  initialSpend: SpendStatusDto;
  /** The server reports the viewer cannot edit this session (the editor forces Browse mode). */
  onReadOnly: () => void;
  /** Runs synchronously at the start of every initial (re)load: session switch or manual retry. */
  onLoadStart?: () => void;
}

/**
 * Session metadata (session DTO, boot progress, spend, changes/checkpoints, routes) with:
 *  - a request-generation guard: only the newest `loadSessionMeta` call may apply its response,
 *    a superseded call resolves to the newest call's result instead of overwriting state;
 *  - the initial load with backoff auto-retry (1s, 2s, 4s… 30s) and a manual retry;
 *  - auto-wake of a sleeping workspace and polling while Astro is still booting.
 */
export function useSessionMeta({ sessionId, initialSpend, onReadOnly, onLoadStart }: UseSessionMetaOptions) {
  const [session, setSession] = useState<EditorSessionDto | null>(null);
  const [bootProgress, setBootProgress] = useState<BootProgressDto | null>(null);
  const [spend, setSpend] = useState<SpendStatusDto>(initialSpend);
  const [astroReady, setAstroReady] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [changedCount, setChangedCount] = useState(0);
  const [siteRoutes, setSiteRoutes] = useState<SiteRouteEntryDto[]>([]);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [initialLoadError, setInitialLoadError] = useState<{ message: string; retryInMs: number } | null>(
    null,
  );
  const [initialLoadNonce, setInitialLoadNonce] = useState(0);
  /** Set once the workspace is in a crash loop: stops WS reconnects and transcript polling. */
  const crashLoopHaltedRef = useRef(false);
  const wakeRequestedRef = useRef(false);
  const onReadOnlyStable = useStableCallback(onReadOnly);
  const onLoadStartRef = useRef(onLoadStart);
  onLoadStartRef.current = onLoadStart;

  const setChangesFromServer = (count: number, ckpts: CheckpointInfo[]) => {
    setChangedCount(count);
    setCheckpoints(ckpts);
  };

  /** Applies a session DTO returned by wake/restart (not a full meta refresh). */
  const applyWokenSession = (woken: EditorSessionDto) => {
    setSession(woken);
    if (woken.astroReady !== undefined) setAstroReady(Boolean(woken.astroReady));
    if (woken.bootProgress) setBootProgress(woken.bootProgress);
  };

  // Request generation counter: loadSessionMeta is fired from intervals, WS events, visibility
  // changes, etc. Only the newest call may apply its response; a superseded call resolves to
  // the newest call's result instead of overwriting state with stale data.
  const metaGenRef = useRef(0);
  const latestMetaPromiseRef = useRef<Promise<MetaRoutes> | null>(null);

  const fetchSessionMeta = async (gen: number): Promise<MetaRoutes> => {
    const isStale = () => gen !== metaGenRef.current;
    let res: Awaited<ReturnType<typeof api.getSession>>;
    try {
      res = await api.getSession(sessionId);
    } catch (err) {
      if (isStale() && latestMetaPromiseRef.current) return latestMetaPromiseRef.current;
      throw err;
    }
    if (isStale()) return latestMetaPromiseRef.current ?? null;
    setSession(res.session);
    if (res.session.astroReady !== undefined) {
      setAstroReady(Boolean(res.session.astroReady));
    } else if (res.session.status === 'running') {
      setAstroReady(true);
    }
    if (res.session.bootProgress) {
      setBootProgress(res.session.bootProgress);
      if (res.session.bootProgress.crashLoop) {
        crashLoopHaltedRef.current = true;
      }
    }
    setSpend(res.spend);
    setChangedCount(res.session.changedFilesCount);
    if (!res.session.canEdit) onReadOnlyStable();
    if (res.session.status === 'running') {
      try {
        const [ch, rt] = await Promise.all([api.getChanges(sessionId), api.getRoutes(sessionId)]);
        if (isStale()) return latestMetaPromiseRef.current ?? null;
        setChangesFromServer(ch.changes.length, ch.checkpoints);
        setSiteRoutes(rt.routes);
        return rt.routes;
      } catch (err) {
        // runner may still be initializing
        console.debug('[halley] changes/routes not available yet', err);
      }
    }
    return null;
  };

  /** Throws on failure (used by the initial-load retry loop). */
  const loadSessionMetaOrThrow = (): Promise<MetaRoutes> => {
    const gen = ++metaGenRef.current;
    const p = fetchSessionMeta(gen);
    latestMetaPromiseRef.current = p;
    return p;
  };

  /** Never rejects: background refreshes surface failures as a dismissible notice. */
  const loadSessionMeta = async (): Promise<MetaRoutes> => {
    try {
      const routes = await loadSessionMetaOrThrow();
      setMetaError(null);
      return routes;
    } catch (err) {
      console.warn('[halley] session refresh failed', err);
      setMetaError(`Couldn't refresh workspace: ${errorMessage(err)}`);
      return null;
    }
  };

  // Initial load: on failure show an error with Retry and auto-retry with backoff (1s, 2s, 4s… 30s).
  useEffect(() => {
    wakeRequestedRef.current = false;
    crashLoopHaltedRef.current = false;
    setAstroReady(false);
    setBootProgress(null);
    onLoadStartRef.current?.();
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        await loadSessionMetaOrThrow();
        if (cancelled) return;
        setInitialLoadError(null);
        setMetaError(null);
      } catch (err) {
        if (cancelled) return;
        const delay = backoffDelayMs(attempt++);
        console.warn(`[halley] loading session failed, retrying in ${delay}ms`, err);
        setInitialLoadError({ message: errorMessage(err, 'Could not load this workspace'), retryInMs: delay });
        timer = setTimeout(() => void run(), delay);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, initialLoadNonce]);

  // Wake a sleeping workspace once; poll while it boots or Astro is not ready yet.
  useEffect(() => {
    if (!session) return;
    if (session.status === 'sleeping' && !wakeRequestedRef.current) {
      wakeRequestedRef.current = true;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      void api
        .wakeSession(sessionId)
        .then(({ session: woken }) => {
          applyWokenSession(woken);
        })
        .catch(() => {
          retryTimer = setTimeout(() => {
            wakeRequestedRef.current = false;
            void loadSessionMeta();
          }, 2500);
        });
      return () => {
        if (retryTimer) clearTimeout(retryTimer);
      };
    }
    const waitingForAstro =
      session.status === 'starting' ||
      (session.status === 'running' && session.astroReady === false && !astroReady);
    if (!waitingForAstro) return;
    const timer = setInterval(() => {
      void loadSessionMeta();
    }, 1500);
    return () => clearInterval(timer);
  }, [sessionId, session?.status, session?.astroReady, astroReady]);

  return {
    session,
    setSession,
    bootProgress,
    setBootProgress,
    spend,
    setSpend,
    astroReady,
    setAstroReady,
    checkpoints,
    setCheckpoints,
    changedCount,
    setChangedCount,
    siteRoutes,
    setSiteRoutes,
    metaError,
    setMetaError,
    initialLoadError,
    retryInitialLoad: () => setInitialLoadNonce((n) => n + 1),
    loadSessionMeta,
    loadSessionMetaOrThrow,
    applyWokenSession,
    crashLoopHaltedRef,
  };
}
