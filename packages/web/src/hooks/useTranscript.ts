import type { LiveRunStateDto, PageRequestMetadata, TranscriptEntryDto } from '@halley/shared';
import { useEffect, useState } from 'react';
import { api, type PriorThreadDto } from '../api.js';
import { shareTranscriptEntries } from '../lib/client-frames.js';
import { reportIgnored } from '../lib/retry.js';

type TranscriptResponse = Awaited<ReturnType<typeof api.getTranscript>>;

export interface UseTranscriptOptions {
  sessionId: string;
  sessionStatus: string | null;
  /** While the WebSocket is down the transcript is polled over HTTP instead. */
  wsConnected: boolean;
  crashLoop: boolean;
}

function pageRequestsById(list: PageRequestMetadata[]): Record<string, PageRequestMetadata> {
  const next: Record<string, PageRequestMetadata> = {};
  for (const pr of list) next[pr.pageRequestId] = pr;
  return next;
}

/**
 * Transcript entries, live run state and page requests. Updates keep unchanged entries
 * referentially identical ({@link shareTranscriptEntries}) so memoized message rows do not
 * re-render. Polls over HTTP while the WebSocket is disconnected.
 */
export function useTranscript({ sessionId, sessionStatus, wsConnected, crashLoop }: UseTranscriptOptions) {
  const [entries, setEntries] = useState<TranscriptEntryDto[]>([]);
  const [live, setLive] = useState<LiveRunStateDto>({
    busy: false,
    activeTools: [],
    queuedCount: 0,
  });
  const [pageRequestsMap, setPageRequestsMap] = useState<Record<string, PageRequestMetadata>>({});
  const [priorThread, setPriorThread] = useState<PriorThreadDto | null>(null);
  const [volumeExpired, setVolumeExpired] = useState(false);

  /** Applies a full transcript snapshot from the HTTP API. */
  const applyTranscript = (t: TranscriptResponse) => {
    setEntries((prev) => shareTranscriptEntries(prev, t.entries));
    setLive(t.live);
    if (t.pageRequests) setPageRequestsMap(pageRequestsById(t.pageRequests));
  };

  /** Applies a `transcript_state` WebSocket frame (either part may be absent). */
  const applyTranscriptFrame = (frame: { entries: TranscriptEntryDto[]; live: LiveRunStateDto }) => {
    // Defensive: frames from older runners may omit either part.
    if (Array.isArray(frame.entries)) {
      const nextEntries = frame.entries;
      setEntries((prev) => shareTranscriptEntries(prev, nextEntries));
    }
    if (frame.live && typeof frame.live === 'object') setLive(frame.live);
  };

  const upsertPageRequest = (pr: PageRequestMetadata) =>
    setPageRequestsMap((prev) => ({ ...prev, [pr.pageRequestId]: pr }));

  const replacePageRequests = (list: PageRequestMetadata[]) => setPageRequestsMap(pageRequestsById(list));

  /** Fetches and applies the transcript; rejects on failure. */
  const refreshTranscript = async (): Promise<void> => {
    applyTranscript(await api.getTranscript(sessionId));
  };

  useEffect(() => {
    if (!sessionStatus) return;
    if (sessionStatus !== 'running' && sessionStatus !== 'published' && sessionStatus !== 'merged') {
      return;
    }
    api
      .getTranscript(sessionId)
      .then((t) => {
        if (t.priorThread) setPriorThread(t.priorThread);
        if (t.volumeExpired) setVolumeExpired(true);
      })
      .catch((err) => reportIgnored(err, 'prior-thread transcript fetch failed'));
  }, [sessionId, sessionStatus]);

  // Fallback HTTP transcript polling whenever WebSocket is disconnected (e.g. reverse proxy without WS headers)
  useEffect(() => {
    if (wsConnected) return;
    if (crashLoop) return;
    if (sessionStatus !== 'running' && sessionStatus !== 'published') return;
    const poll = () => {
      void api
        .getTranscript(sessionId)
        .then((t) => applyTranscript(t))
        .catch((err) => reportIgnored(err, 'transcript poll failed; next tick retries'));
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [sessionId, wsConnected, sessionStatus, crashLoop]);

  return {
    entries,
    live,
    pageRequestsMap,
    setPageRequestsMap,
    priorThread,
    volumeExpired,
    applyTranscript,
    applyTranscriptFrame,
    upsertPageRequest,
    replacePageRequests,
    refreshTranscript,
  };
}
