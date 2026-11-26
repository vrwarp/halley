import type {
  BootProgressDto,
  ChatServerMessage,
  CheckpointInfo,
  EditorSessionDto,
  ElementContext,
  LiveRunStateDto,
  MergeReviewStateDto,
  PageRequestMetadata,
  PostMessageFromPreview,
  PreviewMode,
  PreviewRect,
  PublishProgressPayload,
  SiteRouteEntryDto,
  SpendStatusDto,
  StagedAttachment,
  TranscriptEntryDto,
  UserDto,
} from '@halley/shared';
import {
  ArrowLeft,
  Bug,
  CheckCircle2,
  ChevronDown,
  Copy,
  EyeOff,
  FilePlus,
  GitBranch,
  History,
  ImagePlus,
  LayoutGrid,
  Loader2,
  Monitor,
  MoreHorizontal,
  MousePointer,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Smartphone,
  Square,
  Tablet,
  Undo2,
  X,
} from 'lucide-react';
import { elementKey, friendlyElementKind } from '@halley/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type PriorThreadDto } from '../api.js';
import { flyToChip } from '../components/attachFlight.js';
import { BranchOffModal } from '../components/BranchOffModal.js';
import { ChatMessageContent, parseUserMessageDisplay } from '../components/ChatMessageContent.js';
import { ConflictCards } from '../components/ConflictCards.js';
import { DebugTraceDrawer } from '../components/DebugTraceDrawer.js';
import {
  defaultBubblePos,
  MobileChatBubble,
  type BubblePos,
} from '../components/MobileChatBubble.js';
import { MobileChatCard, type MobileNotice } from '../components/MobileChatCard.js';
import { MobileFullSheet } from '../components/MobileFullSheet.js';
import { NewPageCard, pageStatusText } from '../components/NewPageCard.js';
import { NewPageModal } from '../components/NewPageModal.js';
import { PageToolbarControls } from '../components/PageToolbarControls.js';
import { PublishModal } from '../components/PublishModal.js';
import { PreviewVerifyingOverlay } from '../components/PreviewVerifyingOverlay.js';
import { WorkspaceLoadingScreen } from '../components/WorkspaceLoadingScreen.js';

/** Chips are unique per element + highlighted phrase. */
const chipKeyOf = (c: ElementContext) => `${elementKey(c)}|${c.selectedText ?? ''}`;
const chipLabelOf = (c: ElementContext, persona: 'non-technical' | 'developer' = 'non-technical') => {
  if (c.selectedText) return `“${c.selectedText}”`;
  const kind = persona === 'developer' ? `<${c.tagName}>` : friendlyElementKind(c.tagName);
  return c.renderedText ? `${kind}: ${c.renderedText}` : kind;
};

interface Props {
  sessionId: string;
  user: UserDto;
  initialSpend: SpendStatusDto;
  initialOpenPublish?: boolean;
  onBack: () => void;
  onOpenSession: (id: string, opts?: { openPublish?: boolean }) => void;
}

const MUTATING_TOOLS = new Set(['edit', 'write', 'bash', 'process_image', 'undo_last_change']);

type TranscriptDisplayBlock =
  | { kind: 'entry'; entry: TranscriptEntryDto }
  | { kind: 'steps'; id: string; items: TranscriptEntryDto[] };

function groupTranscriptEntries(
  entries: TranscriptEntryDto[],
  collapseIntermediate: boolean,
): TranscriptDisplayBlock[] {
  if (!collapseIntermediate) {
    return entries.map((entry) => ({ kind: 'entry', entry }));
  }
  const blocks: TranscriptDisplayBlock[] = [];
  for (const entry of entries) {
    const isStep = entry.role === 'tool' || (entry.role === 'assistant' && entry.isIntermediate);
    if (isStep) {
      const prev = blocks.at(-1);
      if (prev && prev.kind === 'steps') {
        prev.items.push(entry);
      } else {
        blocks.push({ kind: 'steps', id: `steps-${entry.id}`, items: [entry] });
      }
    } else {
      blocks.push({ kind: 'entry', entry });
    }
  }
  return blocks;
}

function friendlyToolLabel(name?: string): string {
  switch (name) {
    case 'read':
      return 'Read file';
    case 'edit':
    case 'write':
      return 'Updated file';
    case 'create_page':
      return 'Created starter page';
    case 'bash':
      return 'Ran command';
    case 'process_image':
      return 'Optimized image';
    case 'screenshot_page':
      return 'Inspected page layout';
    case 'run_checks':
      return 'Checked site health';
    default:
      return name || 'Step';
  }
}

export function EditorPage({
  sessionId,
  user,
  initialSpend,
  initialOpenPublish = false,
  onBack,
  onOpenSession,
}: Props) {
  const [session, setSession] = useState<EditorSessionDto | null>(null);
  const [bootProgress, setBootProgress] = useState<BootProgressDto | null>(null);
  const [spend, setSpend] = useState<SpendStatusDto>(initialSpend);
  const [entries, setEntries] = useState<TranscriptEntryDto[]>([]);
  const [priorThread, setPriorThread] = useState<PriorThreadDto | null>(null);
  const [volumeExpired, setVolumeExpired] = useState(false);
  const [live, setLive] = useState<LiveRunStateDto>({
    busy: false,
    activeTools: [],
    queuedCount: 0,
  });
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [changedCount, setChangedCount] = useState(0);
  const [publishProgress, setPublishProgress] = useState<PublishProgressPayload | null>(null);
  const [previewPaused, setPreviewPaused] = useState<{ paused: boolean; reason?: string }>({
    paused: false,
  });
  const [wsReconnectNonce, setWsReconnectNonce] = useState(0);
  const crashLoopHaltedRef = useRef(false);
  const prevPreviewPausedRef = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [syncReview, setSyncReview] = useState<MergeReviewStateDto | null>(null);
  const [upstreamNotice, setUpstreamNotice] = useState<{
    behind: boolean;
    newerCount: number;
    heldOverlap?: number;
    coEditors: Array<{ ownerName: string; title: string }>;
  } | null>(null);

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );
  const [mode, setMode] = useState<PreviewMode>('browse');
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
      ? 'mobile'
      : 'desktop',
  );
  const [currentRoute, setCurrentRoute] = useState('/');
  const [siteRoutes, setSiteRoutes] = useState<SiteRouteEntryDto[]>([]);
  const [showPageSwitcher, setShowPageSwitcher] = useState(false);
  const [routeQuery, setRouteQuery] = useState('');
  const [showNewPageModal, setShowNewPageModal] = useState(false);
  const [newPageInitialTitle, setNewPageInitialTitle] = useState('');
  const [pageRequestsMap, setPageRequestsMap] = useState<Record<string, PageRequestMetadata>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [showPublish, setShowPublish] = useState(initialOpenPublish);
  const [showDebug, setShowDebug] = useState(false);

  // Mobile-specific UI state
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileBubblePos, setMobileBubblePos] = useState<BubblePos>(() => defaultBubblePos());
  const [previewSelectionActive, setPreviewSelectionActive] = useState(false);
  const [mobileCompletionToast, setMobileCompletionToast] = useState<string | null>(null);
  const [mobileSheet, setMobileSheet] = useState<
    null | 'history' | 'review' | 'pages' | 'menu' | 'checkpoints'
  >(null);
  const [showUndoPubModal, setShowUndoPubModal] = useState(false);
  const [undoPubReason, setUndoPubReason] = useState('');
  const [undoPubBusy, setUndoPubBusy] = useState(false);
  const [showBranchOffModal, setShowBranchOffModal] = useState(false);
  const [branchOffBusy, setBranchOffBusy] = useState(false);
  const [branchOffError, setBranchOffError] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [chips, setChips] = useState<ElementContext[]>([]);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [persona, setPersona] = useState<'non-technical' | 'developer'>(user.persona ?? 'non-technical');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPreviewReloadAtRef = useRef(0);
  const lastNavigationAtRef = useRef(0);
  const pendingRouteRef = useRef<string | null>(null);
  const prevBusyRef = useRef(false);
  const hadMutatingToolRef = useRef(false);
  const runStartEntryCountRef = useRef(0);
  const runStartRoutesRef = useRef<Set<string> | null>(null);
  const runStartedAtRef = useRef(0);
  const wakeRequestedRef = useRef(false);
  const chipRowRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileChipRowRef = useRef<HTMLDivElement>(null);
  const mobileComposerRef = useRef<HTMLDivElement>(null);
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const completionToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFlightRef = useRef<{ chipKey: string; from: PreviewRect | null; label: string } | null>(null);
  const pendingHighlightKeyRef = useRef<string | null>(null);
  const [flightNonce, setFlightNonce] = useState(0);

  // Sync phone layout breakpoint (< 640px) and keep editorContext.viewport accurate on phones
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => {
      const mobile = mq.matches;
      setIsMobile(mobile);
      if (mobile) {
        setViewport('mobile');
      }
    };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const reloadPreview = (force = false) => {
    const now = Date.now();
    if (!force) {
      if (pendingRouteRef.current !== null) return;
      if (now - lastNavigationAtRef.current < 3000) return;
      if (now - lastPreviewReloadAtRef.current < 1200) return;
    }
    lastPreviewReloadAtRef.current = now;
    iframeRef.current?.contentWindow?.postMessage({ type: 'halley:reload', force }, '*');
  };

  const loadSessionMeta = async (): Promise<Array<{ route: string; label: string; unlisted?: boolean }> | null> => {
    const res = await api.getSession(sessionId);
    setSession(res.session);
    if (res.session.bootProgress) {
      setBootProgress(res.session.bootProgress);
      if (res.session.bootProgress.crashLoop) {
        crashLoopHaltedRef.current = true;
      }
    }
    setSpend(res.spend);
    setChangedCount(res.session.changedFilesCount);
    if (!res.session.canEdit) setMode('browse');
    if (res.session.status === 'running') {
      try {
        const [ch, rt] = await Promise.all([api.getChanges(sessionId), api.getRoutes(sessionId)]);
        setChangesFromServer(ch.changes.length, ch.checkpoints);
        setSiteRoutes(rt.routes);
        return rt.routes;
      } catch {
        // runner may still be initializing
      }
    }
    return null;
  };

  const handleRetryBoot = async () => {
    crashLoopHaltedRef.current = false;
    setBootProgress(null);
    const shouldHardRestart = Boolean(bootProgress?.crashLoop) || session?.status === 'error';
    const { session: woken } = shouldHardRestart
      ? await api.restartSession(sessionId)
      : await api.wakeSession(sessionId);
    setSession(woken);
    if (woken.bootProgress) setBootProgress(woken.bootProgress);
    setWsReconnectNonce((n) => n + 1);
  };

  const setChangesFromServer = (count: number, ckpts: CheckpointInfo[]) => {
    setChangedCount(count);
    setCheckpoints(ckpts);
  };

  useEffect(() => {
    wakeRequestedRef.current = false;
    crashLoopHaltedRef.current = false;
    setBootProgress(null);
    setPreviewPaused({ paused: false });
    void loadSessionMeta();
  }, [sessionId]);

  useEffect(() => {
    if (!session) return;
    if (session.status !== 'running' && session.status !== 'published' && session.status !== 'merged') {
      return;
    }
    api
      .getTranscript(sessionId)
      .then((t) => {
        if (t.priorThread) setPriorThread(t.priorThread);
        if (t.volumeExpired) setVolumeExpired(true);
      })
      .catch(() => {});
  }, [sessionId, session?.status]);

  useEffect(() => {
    if (!session) return;
    if (session.status === 'sleeping' && !wakeRequestedRef.current) {
      wakeRequestedRef.current = true;
      void api
        .wakeSession(sessionId)
        .then(({ session: woken }) => {
          setSession(woken);
          if (woken.bootProgress) setBootProgress(woken.bootProgress);
        })
        .catch(() => {});
      return;
    }
    if (session.status !== 'starting') return;
    const timer = setInterval(() => {
      void loadSessionMeta();
    }, 1500);
    return () => clearInterval(timer);
  }, [sessionId, session?.status]);

  // Q8 / Q12: Safe-moment auto-sync & proactive upstream/co-editor banner
  const handleManualSync = async () => {
    if (!session?.canEdit || syncing || live.busy) return;
    setSyncing(true);
    setSyncToast(null);
    try {
      const res = await api.syncSession(session.id, { kind: 'sync' });
      if (res.review) {
        if (res.review.alreadyUpToDate) {
          setSyncToast('Already up to date with the live site.');
        } else if (res.review.status === 'applied') {
          setSyncToast(res.review.summary);
          reloadPreview(true);
        } else {
          setSyncReview(res.review);
          reloadPreview(true);
        }
        setUpstreamNotice((prev) => (prev ? { ...prev, behind: false, heldOverlap: undefined } : prev));
        await loadSessionMeta();
      }
    } catch (err) {
      setSyncToast(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!session || !session.canEdit || session.status !== 'running') return;
    let cancelled = false;
    const checkAndAutoSync = async () => {
      if (cancelled || live.busy || showPublish || syncing) return;
      try {
        const up = await api.getUpstreamStatus(session.id);
        if (cancelled) return;
        setUpstreamNotice({
          behind: up.behind,
          newerCount: up.newerCommits.length,
          coEditors: up.coEditors.map((c) => ({ ownerName: c.ownerName, title: c.title })),
        });
        // Auto-sync silently when behind and safe (never spends AI without user click)
        if (up.behind && !live.busy && !showPublish) {
          const res = await api.syncSession(session.id, { kind: 'sync', autoSyncOnly: true });
          if (cancelled) return;
          if (res.heldForUser) {
            setUpstreamNotice((prev) =>
              prev ? { ...prev, behind: true, heldOverlap: res.overlapCount ?? 1 } : prev,
            );
          } else if (res.review && !res.review.alreadyUpToDate) {
            if (res.review.status === 'ready_for_review') {
              setSyncReview(res.review);
            } else {
              setSyncToast(res.review.summary);
            }
            reloadPreview(true);
            await loadSessionMeta();
          }
        }
      } catch {
        // non-fatal
      }
    };
    void checkAndAutoSync();
    const timer = setInterval(() => void checkAndAutoSync(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session?.id, session?.status, session?.canEdit, live.busy, showPublish]);

  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed || crashLoopHaltedRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/sessions/${sessionId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        if (!disposed) setWsConnected(true);
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as ChatServerMessage;
        if (msg.type === 'boot_progress') {
          setBootProgress(msg.progress);
          if (msg.progress.crashLoop) {
            crashLoopHaltedRef.current = true;
          }
          if (msg.progress.stage === 'ready' || msg.progress.stage === 'error') {
            void loadSessionMeta();
          }
        } else if (msg.type === 'preview_paused') {
          setPreviewPaused({ paused: msg.paused, reason: msg.reason });
        } else if (msg.type === 'transcript_state') {
          setEntries(msg.entries);
          setLive(msg.live);
        } else if (msg.type === 'workspace_lock') {
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'halley:lock', locked: msg.locked, reason: msg.file },
            '*',
          );
        } else if (msg.type === 'checkpoint_created') {
          setChangedCount(msg.changedFilesCount);
          setCheckpoints((prev) => [msg.checkpoint, ...prev.filter((c) => c.sha !== msg.checkpoint.sha)]);
          if (!msg.checkpoint.message.startsWith('Inline edit in ')) {
            reloadPreview();
          }
          if (session?.kind === 'revert') {
            void loadSessionMeta();
          }
        } else if (msg.type === 'session_meta_updated') {
          void loadSessionMeta();
        } else if (msg.type === 'publish_state') {
          setPublishProgress(msg.payload);
          if (msg.payload.state === 'published') {
            void loadSessionMeta();
          }
        } else if (msg.type === 'spend_status') {
          setSpend({
            spentTodayUsd: msg.spentTodayUsd,
            dailyCapUsd: msg.dailyCapUsd,
            extraGrantedUsd: msg.extraGrantedUsd,
            capped: msg.capped,
          });
        } else if (msg.type === 'page_request_state') {
          const pr = msg.pageRequest;
          setPageRequestsMap((prev) => ({ ...prev, [pr.pageRequestId]: pr }));
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: 'halley:page-progress',
              route: pr.route,
              status: pr.status,
              message: pageStatusText(pr.status),
            },
            '*',
          );
          if (msg.autoNavigate) {
            navigatePreviewRef.current(pr.route);
            void api
              .getRoutes(sessionId)
              .then((rt) => setSiteRoutes(rt.routes))
              .catch(() => {});
          }
        } else if (msg.type === 'page_requests_sync') {
          const next: Record<string, PageRequestMetadata> = {};
          for (const pr of msg.pageRequests) {
            next[pr.pageRequestId] = pr;
          }
          setPageRequestsMap(next);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        if (crashLoopHaltedRef.current) return;
        attempt += 1;
        const baseDelay = Math.min(30_000, 2000 * 2 ** Math.min(attempt - 1, 4));
        const jitter = Math.floor(Math.random() * 500);
        reconnectTimer = setTimeout(connect, baseDelay + jitter);
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
  }, [sessionId, wsReconnectNonce]);

  // Reload iframe smoothly once Astro dev resumes after pre-publish verification
  const isPreviewPaused = previewPaused.paused || publishProgress?.state === 'verifying';
  useEffect(() => {
    if (prevPreviewPausedRef.current && !isPreviewPaused) {
      reloadPreview(true);
    }
    prevPreviewPausedRef.current = isPreviewPaused;
  }, [isPreviewPaused]);

  // Fallback HTTP transcript polling whenever WebSocket is disconnected (e.g. reverse proxy without WS headers)
  useEffect(() => {
    if (wsConnected) return;
    if (bootProgress?.crashLoop) return;
    if (!session || (session.status !== 'running' && session.status !== 'published')) return;
    const poll = () => {
      void api
        .getTranscript(sessionId)
        .then((t) => {
          setEntries(t.entries);
          setLive(t.live);
          if (t.pageRequests) {
            const next: Record<string, PageRequestMetadata> = {};
            for (const pr of t.pageRequests) next[pr.pageRequestId] = pr;
            setPageRequestsMap(next);
          }
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [sessionId, wsConnected, session?.status, bootProgress?.crashLoop]);

  // Track mutating tools during an agent run, refresh preview/metadata when the run completes,
  // and auto-navigate to a newly created single route if the user hasn't navigated away.
  useEffect(() => {
    if (live.busy) {
      if (!prevBusyRef.current) {
        runStartEntryCountRef.current = entries.length;
        runStartRoutesRef.current = siteRoutes.length > 0 ? new Set(siteRoutes.map((r) => r.route)) : null;
        runStartedAtRef.current = Date.now();
      }
      if (live.activeTools.some((t) => MUTATING_TOOLS.has(t.name))) {
        hadMutatingToolRef.current = true;
      }
    } else if (prevBusyRef.current) {
      const completedMutatingTool = entries
        .slice(runStartEntryCountRef.current)
        .some((e) => e.role === 'tool' && e.toolName && MUTATING_TOOLS.has(e.toolName));
      const shouldReload = hadMutatingToolRef.current || completedMutatingTool || !wsConnected;
      const beforeRoutes = runStartRoutesRef.current;
      const startedAt = runStartedAtRef.current;
      hadMutatingToolRef.current = false;
      runStartRoutesRef.current = null;

      void loadSessionMeta().then((updatedRoutes) => {
        if (beforeRoutes && updatedRoutes && lastNavigationAtRef.current < startedAt) {
          const added = updatedRoutes.filter((r) => !beforeRoutes.has(r.route));
          if (added.length === 1 && added[0] && added[0].route !== currentRoute) {
            navigatePreview(added[0].route);
            return;
          }
        }
        if (shouldReload) {
          reloadPreview();
        }
      });

      // On phones, if the chat card is closed when Halley finishes, show a 4s one-line toast next to the bubble.
      if (isMobile && !mobileChatOpen) {
        const lastReply = [...entries]
          .reverse()
          .find((e) => e.role === 'assistant' && !e.isIntermediate && e.text.trim());
        const firstLine = (lastReply?.text ?? '')
          .split('\n')
          .map((l) => l.replace(/[*_`#>-]/g, '').trim())
          .find(Boolean);
        const toastText = firstLine
          ? firstLine.length > 48
            ? `${firstLine.slice(0, 47)}…`
            : firstLine
          : 'Finished updating';
        setMobileCompletionToast(toastText);
        if (completionToastTimerRef.current) clearTimeout(completionToastTimerRef.current);
        completionToastTimerRef.current = setTimeout(() => {
          setMobileCompletionToast(null);
        }, 4200);
      }
    }
    prevBusyRef.current = live.busy;
  }, [live.busy, live.activeTools, entries.length, wsConnected, isMobile, mobileChatOpen]);

  useEffect(() => {
    return () => {
      if (completionToastTimerRef.current) clearTimeout(completionToastTimerRef.current);
    };
  }, []);

  // Resync session, transcript, and WebSocket when returning from backgrounding the mobile browser
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void loadSessionMeta();
      void api
        .getTranscript(sessionId)
        .then((t) => {
          setEntries(t.entries);
          setLive(t.live);
          if (t.pageRequests) {
            const next: Record<string, PageRequestMetadata> = {};
            for (const pr of t.pageRequests) next[pr.pageRequestId] = pr;
            setPageRequestsMap(next);
          }
        })
        .catch(() => {});
      if (
        !crashLoopHaltedRef.current &&
        (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      ) {
        setWsReconnectNonce((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sessionId]);

  // Fallback dismissal if user taps the iframe before halley:ready registers our pointerdown listener
  useEffect(() => {
    if (!isMobile || !mobileChatOpen) return;
    const onBlur = () => {
      if (document.activeElement === iframeRef.current) {
        setMobileChatOpen(false);
      }
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [isMobile, mobileChatOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length, live.streamingText]);

  useEffect(() => {
    if (!session) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'halley:set-mode', mode, readOnly: !session.canEdit, persona, touchLayout: isMobile },
      '*',
    );
  }, [mode, session?.canEdit, persona, isMobile]);

  // Numbered markers in the preview for attached elements on the *current* route
  // (keeps global chip numbers consistent even across multi-page selections).
  const pinsRef = useRef<Array<{ key: string; n: number }>>([]);
  useEffect(() => {
    const seen = new Set<string>();
    const pins: Array<{ key: string; n: number }> = [];
    chips.forEach((c, i) => {
      if (c.route !== currentRoute) return;
      const key = elementKey(c);
      if (seen.has(key)) return;
      seen.add(key);
      pins.push({ key, n: i + 1 });
    });
    pinsRef.current = pins;
    iframeRef.current?.contentWindow?.postMessage({ type: 'halley:pins', pins }, '*');
  }, [chips, currentRoute]);

  const highlightInPreview = (key: string | null) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'halley:highlight', key }, '*');
  };

  // Play the fly-to-chat animation once the (new or existing) chip is in the DOM.
  useLayoutEffect(() => {
    const pending = pendingFlightRef.current;
    if (!pending) return;
    const activeChipRow = isMobile ? mobileChipRowRef.current : chipRowRef.current;
    const chipEl = activeChipRow?.querySelector<HTMLElement>(
      `[data-chip-key="${CSS.escape(pending.chipKey)}"]`,
    );
    if (!chipEl) return;
    pendingFlightRef.current = null;
    flyToChip({
      from: pending.from,
      chipEl,
      composerEl: isMobile ? mobileComposerRef.current : composerRef.current,
      label: pending.label,
      onLanded: () => (isMobile ? mobileTextareaRef.current : textareaRef.current)?.focus(),
    });
  }, [flightNonce, isMobile, mobileChatOpen]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as PostMessageFromPreview;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'halley:ready') {
        if (pendingRouteRef.current === data.route) {
          pendingRouteRef.current = null;
        }
        setCurrentRoute(data.route);
        setPreviewSelectionActive(false);
        if (session) {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: 'halley:set-mode',
              mode,
              readOnly: !session.canEdit,
              persona,
              touchLayout: isMobile,
            },
            '*',
          );
        }
        iframeRef.current?.contentWindow?.postMessage({ type: 'halley:pins', pins: pinsRef.current }, '*');
        if (pendingHighlightKeyRef.current) {
          const k = pendingHighlightKeyRef.current;
          pendingHighlightKeyRef.current = null;
          iframeRef.current?.contentWindow?.postMessage({ type: 'halley:highlight', key: k }, '*');
          setTimeout(() => {
            iframeRef.current?.contentWindow?.postMessage({ type: 'halley:highlight', key: null }, '*');
          }, 1400);
        }
      } else if (data.type === 'halley:route-changed') {
        if (pendingRouteRef.current === data.route) {
          pendingRouteRef.current = null;
        }
        setCurrentRoute(data.route);
      } else if (data.type === 'halley:selection-changed') {
        setPreviewSelectionActive(Boolean(data.active));
      } else if (data.type === 'halley:preview-pointerdown') {
        if (isMobile) {
          setMobileChatOpen(false);
        }
      } else if (data.type === 'halley:element-context') {
        // Only sent when the user explicitly presses "Ask Halley…" in the preview.
        const ctx = data.context;
        const chipKey = chipKeyOf(ctx);
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
        pendingFlightRef.current = { chipKey, from, label: chipLabelOf(ctx, persona) };
        setChips((prev) => (prev.some((c) => chipKeyOf(c) === chipKey) ? prev : [...prev, ctx]));
        if (isMobile) {
          setMobileChatOpen(true);
          setMobileCompletionToast(null);
        }
        setFlightNonce((n) => n + 1);
      } else if (data.type === 'halley:patch-saved') {
        void loadSessionMeta();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [mode, session, persona, isMobile]);

  const dispatchClientMessage = (payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      void api.sendClientMessage(sessionId, payload);
    }
  };

  const navigatePreview = (route: string) => {
    if (!session) return;
    const clean = route.startsWith('/') ? route : `/${route}`;
    const baseSuffixVal = session.astroBase === '/' ? '' : session.astroBase.replace(/\/$/, '');
    lastNavigationAtRef.current = Date.now();
    pendingRouteRef.current = clean;
    if (iframeRef.current) {
      iframeRef.current.src = `/p/${session.id}${baseSuffixVal}${clean}`;
    }
    setCurrentRoute(clean);
    setShowPageSwitcher(false);
    setMobileSheet(null);
  };
  const navigatePreviewRef = useRef(navigatePreview);
  navigatePreviewRef.current = navigatePreview;

  // Keep placeholder progress synced whenever the preview lands on a newly created page
  useEffect(() => {
    const active = Object.values(pageRequestsMap)
      .filter((pr) => pr.route === currentRoute)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!active) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'halley:page-progress',
        route: active.route,
        status: active.status,
        message: pageStatusText(active.status),
      },
      '*',
    );
  }, [currentRoute, pageRequestsMap]);

  const handleRetryPageRequest = async (pageRequestId: string) => {
    const res = await api.retryPageRequest(sessionId, pageRequestId, viewport);
    if (res.pageRequest) {
      setPageRequestsMap((prev) => ({ ...prev, [res.pageRequest!.pageRequestId]: res.pageRequest! }));
    }
  };

  const handleDeletePage = async (route: string) => {
    await api.deletePage(sessionId, route);
    if (currentRoute === route) {
      navigatePreview('/');
    }
    await loadSessionMeta();
  };

  const openNewPageWizard = (initialTitle = '') => {
    setNewPageInitialTitle(initialTitle);
    setShowPageSwitcher(false);
    setShowNewPageModal(true);
  };

  const focusChipInPreview = (c: ElementContext) => {
    const key = elementKey(c);
    if (c.route !== currentRoute) {
      pendingHighlightKeyRef.current = key;
      navigatePreview(c.route);
      return;
    }
    highlightInPreview(key);
    setTimeout(() => highlightInPreview(null), 1200);
  };

  const sendPrompt = (whenBusy?: 'steer' | 'followUp', overrideText?: string) => {
    if (!session?.canEdit) return;
    const textToSend = (overrideText ?? input).trim();
    if (!textToSend && attachments.length === 0 && chips.length === 0) return;
    const defaultEmptyPrompt =
      attachments.length > 0 && chips.length === 0
        ? 'Please use the attached photo.'
        : chips.length === 1
          ? 'What is this section on the page and how could I update or improve it?'
          : 'How could I update or improve these selected sections?';
    dispatchClientMessage({
      type: 'submit_input',
      requestId: crypto.randomUUID(),
      text: textToSend || defaultEmptyPrompt,
      contextChips: chips,
      attachments,
      editorContext: {
        currentRoute,
        viewport,
        mode,
      },
      whenBusy,
    });
    if (overrideText === undefined) setInput('');
    setChips([]);
    setAttachments([]);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !session?.canEdit) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const att = await api.uploadImage(sessionId, file);
        setAttachments((prev) => [...prev, att]);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleUndoLast = async () => {
    if (!session?.canEdit || checkpoints.length < 1) return;
    const target = checkpoints[1]?.sha || session.baseSha;
    if (!target) return;
    await api.undoCheckpoint(sessionId, target);
    await loadSessionMeta();
    iframeRef.current?.contentWindow?.postMessage({ type: 'halley:reload' }, '*');
  };

  const handleRestoreCheckpoint = async (sha: string) => {
    if (!session?.canEdit) return;
    await api.undoCheckpoint(sessionId, sha);
    setShowHistory(false);
    await loadSessionMeta();
    iframeRef.current?.contentWindow?.postMessage({ type: 'halley:reload' }, '*');
  };

  if (!session) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#FAF9F7] text-sm text-stone-500">
        <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
        <span>Loading workspace…</span>
      </div>
    );
  }

  const isWorkspaceBooting =
    session.status === 'starting' ||
    session.status === 'sleeping' ||
    session.status === 'error';
  const baseSuffix = session.astroBase === '/' ? '' : session.astroBase.replace(/\/$/, '');
  const previewSrc = `/p/${session.id}${baseSuffix}/`;
  const spendPct = Math.min(100, (spend.spentTodayUsd / Math.max(0.01, spend.dailyCapUsd + spend.extraGrantedUsd)) * 100);
  const failedPageRequest = Object.values(pageRequestsMap).find(
    (pr) => pr.status === 'failed' || pr.status === 'capped',
  );
  const needsMobileAttention = Boolean(
    syncReview?.status === 'needs_choices' ||
      upstreamNotice?.heldOverlap ||
      failedPageRequest,
  );
  const mobileNotice: MobileNotice | null = (() => {
    if (syncReview && (syncReview.status === 'needs_choices' || syncReview.records.length > 0)) {
      return {
        text:
          syncReview.status === 'needs_choices'
            ? 'Live site conflict needs your choice'
            : syncReview.summary,
        actionLabel: 'Review',
        onAction: () => {
          setMobileChatOpen(false);
          setMobileSheet('review');
        },
        tone: 'amber',
      };
    }
    if (upstreamNotice?.heldOverlap) {
      return {
        text: `Live site update overlaps ${upstreamNotice.heldOverlap} file${upstreamNotice.heldOverlap === 1 ? '' : 's'}`,
        actionLabel: syncing ? 'Syncing…' : 'Review',
        onAction: () => void handleManualSync(),
        tone: 'amber',
      };
    }
    if (upstreamNotice?.behind) {
      return {
        text: `Live site has ${upstreamNotice.newerCount} newer update${upstreamNotice.newerCount === 1 ? '' : 's'}`,
        actionLabel: syncing ? 'Updating…' : 'Get latest',
        onAction: () => void handleManualSync(),
        tone: 'amber',
      };
    }
    if (failedPageRequest) {
      return {
        text: `Page "${failedPageRequest.title}" needs attention`,
        actionLabel: 'Review',
        onAction: () => {
          setMobileChatOpen(false);
          setMobileSheet('review');
        },
        tone: 'amber',
      };
    }
    if (syncToast) {
      return {
        text: syncToast,
        actionLabel: 'Dismiss',
        onAction: () => setSyncToast(null),
        tone: 'teal',
      };
    }
    return null;
  })();

  const handleConfirmUndoPublication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session.mergedSha || !undoPubReason.trim() || undoPubBusy) return;
    setUndoPubBusy(true);
    try {
      const { session: rev } = await api.revertPublication({
        sessionId: session.id,
        sha: session.mergedSha,
        reason: undoPubReason.trim(),
        title: session.title,
      });
      setShowUndoPubModal(false);
      setUndoPubReason('');
      onOpenSession(rev.id, { openPublish: true });
    } finally {
      setUndoPubBusy(false);
    }
  };

  const handleConfirmBranchOff = async () => {
    if (branchOffBusy) return;
    setBranchOffBusy(true);
    setBranchOffError(null);
    try {
      const { session: dup } = await api.duplicateSession(session.id);
      setShowBranchOffModal(false);
      onOpenSession(dup.id);
    } catch (err) {
      setBranchOffError(err instanceof Error ? err.message : 'Could not branch off draft');
    } finally {
      setBranchOffBusy(false);
    }
  };

  return (
    <div className="flex h-dvh w-full max-w-full flex-col overflow-x-clip bg-[#FAF9F7]">
      {isMobile ? (
      /* Mobile Top Bar (< 640px): single compact 48px row guaranteed to fit >=320px without overflow */
      <header
        className="flex min-h-[48px] w-full max-w-full min-w-0 shrink-0 items-center justify-between gap-1 overflow-x-clip border-b border-[#E7E5E4] bg-white px-1.5"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="All edits"
          title="All edits"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-700 hover:bg-stone-200/80 hover:text-stone-900"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>

        <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-stone-200" />

        <button
          type="button"
          onClick={async () => {
            setMobileChatOpen(false);
            setMobileSheet('pages');
            try {
              const rt = await api.getRoutes(sessionId);
              setSiteRoutes(rt.routes);
            } catch {
              // ignore
            }
          }}
          aria-label="Switch page"
          className="inline-flex min-h-[34px] min-w-0 flex-1 items-center justify-between gap-1 rounded-lg border border-stone-200 bg-[#FAF9F7] px-2 py-1 font-mono text-[11px] text-stone-800"
        >
          <span className="truncate">{currentRoute}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-stone-400" />
        </button>

        {session.canEdit && !isWorkspaceBooting && (
          <div className="inline-flex shrink-0 rounded-lg border border-stone-200 bg-white p-0.5 text-[11px]">
            {(
              [
                { id: 'browse', label: 'Browse', Icon: MousePointer },
                { id: 'edit', label: 'Edit', Icon: PenLine },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`inline-flex min-h-[30px] items-center gap-1 rounded-md px-2 py-1 font-medium whitespace-nowrap transition ${
                  mode === id ? 'bg-stone-900 text-white' : 'text-stone-600'
                }`}
              >
                <Icon className="hidden h-3 w-3 min-[430px]:inline" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}

        {session.canEdit ? (
          <button
            type="button"
            onClick={() => {
              setMobileChatOpen(false);
              setShowPublish(true);
            }}
            className="inline-flex min-h-[34px] shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-stone-900 px-2 py-1 text-[11px] font-semibold text-white"
          >
            {session.publishState === 'published' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <>Publish{changedCount > 0 ? ` · ${changedCount}` : ''}</>
            )}
          </button>
        ) : session.status === 'published' || session.status === 'merged' ? (
          <button
            type="button"
            onClick={async () => {
              const { session: cont } = await api.duplicateSession(session.id);
              onOpenSession(cont.id);
            }}
            className="inline-flex min-h-[34px] shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-stone-900 px-2 py-1 text-[11px] font-semibold text-white"
          >
            Continue
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => {
            setMobileChatOpen(false);
            setMobileSheet('menu');
          }}
          aria-label="More actions"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-stone-600 hover:bg-stone-100"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </header>
      ) : (
      /* Desktop Top Bar (>= 640px) */
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#E7E5E4] bg-white px-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
            title="Back to edits"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="truncate text-sm font-semibold text-stone-900">{session.title}</span>
          {!session.canEdit && (
            <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
              {session.status === 'published'
                ? 'Published archive'
                : session.status === 'merged'
                  ? 'Merged (deploy pending)'
                  : `Read-only (${session.ownerName})`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {(session.status === 'published' || session.status === 'merged') && (
            <>
              <button
                type="button"
                onClick={async () => {
                  const { session: cont } = await api.duplicateSession(session.id);
                  onOpenSession(cont.id);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
              >
                <Copy className="h-3.5 w-3.5" />
                Continue editing
              </button>
              {session.mergedSha && (
                <button
                  type="button"
                  onClick={() => {
                    setUndoPubReason('');
                    setShowUndoPubModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:border-red-300 hover:text-red-700"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Undo publication
                </button>
              )}
              {session.status === 'merged' && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.retryDeploy(session.id);
                    await loadSessionMeta();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry deploy check
                </button>
              )}
            </>
          )}

          {!session.canEdit && session.status !== 'published' && session.status !== 'merged' && (
            <>
              <button
                type="button"
                onClick={async () => {
                  const { session: dup } = await api.duplicateSession(session.id);
                  onOpenSession(dup.id);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50"
              >
                <Copy className="h-3.5 w-3.5" />
                Duplicate into my edit
              </button>
              {user.isAdmin && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.takeoverSession(session.id);
                    await loadSessionMeta();
                  }}
                  className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
                >
                  Take over
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setShowDebug(true)}
            title="Inspect & download full agent debug trace"
            aria-label="Open agent debug trace"
            className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900"
          >
            <Bug className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Debug</span>
          </button>

          {session.canEdit && (
            <>
              <button
                type="button"
                disabled={syncing || live.busy}
                onClick={() => void handleManualSync()}
                title="Pull latest updates from the live site"
                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span className="hidden md:inline">{syncing ? 'Updating…' : 'Get latest'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setBranchOffError(null);
                  setShowBranchOffModal(true);
                }}
                title="Branch off a copy of this draft"
                aria-label="Branch off a copy of this draft"
                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
              >
                <GitBranch className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Branch off</span>
              </button>

              <div className="relative flex items-center">
                <button
                  type="button"
                  disabled={checkpoints.length < 1}
                  onClick={handleUndoLast}
                  title="Undo last change"
                  className="inline-flex items-center gap-1 rounded-l-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => setShowHistory(!showHistory)}
                  title="Version history"
                  className="rounded-r-lg border border-l-0 border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"
                >
                  <History className="h-3.5 w-3.5" />
                </button>

                {showHistory && (
                  <div className="absolute right-0 top-10 z-40 w-72 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                      Recent Checkpoints
                    </p>
                    <div className="max-h-64 overflow-y-auto divide-y divide-stone-100">
                      {checkpoints.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-stone-500">No checkpoints yet.</p>
                      ) : (
                        checkpoints.map((c, idx) => (
                          <div key={c.sha} className="px-2 py-2 text-xs">
                            {c.isSyncBoundary && (
                              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-teal-700">
                                — Updated from live site · {new Date(c.timestamp).toLocaleDateString()} —
                              </p>
                            )}
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate font-medium text-stone-800">{c.summary}</p>
                                <p className="text-[11px] text-stone-400">
                                  {new Date(c.timestamp).toLocaleTimeString()}
                                </p>
                              </div>
                              {idx > 0 && (
                                <button
                                  type="button"
                                  onClick={() => handleRestoreCheckpoint(c.sha)}
                                  className="shrink-0 rounded border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-stone-700 hover:bg-stone-50"
                                >
                                  Restore
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setShowPublish(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-stone-800"
              >
                {session.publishState === 'published' ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Published
                  </>
                ) : (
                  <>
                    Publish{changedCount > 0 ? ` · ${changedCount}` : ''}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </header>
      )}

      {/* Workspace Loading or Split Workspace */}
      {isWorkspaceBooting ? (
        <WorkspaceLoadingScreen
          session={session}
          bootProgress={bootProgress}
          onRetry={handleRetryBoot}
          onBack={onBack}
        />
      ) : (
      <div className="flex flex-1 min-h-0">
        {/* Left Chat Sidebar (desktop >= 640px) */}
        <aside
          onDragOver={(e) => {
            e.preventDefault();
            if (session.canEdit) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(e.dataTransfer.files);
          }}
          className={`hidden sm:flex sm:w-[300px] md:w-[340px] lg:w-[400px] shrink-0 flex-col border-r border-[#E7E5E4] bg-white transition ${
            dragOver ? 'ring-2 ring-inset ring-amber-500 bg-amber-50/30' : ''
          }`}
        >
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {(volumeExpired || session.volumeExpired) && (
              <div className="rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-xs text-stone-600">
                Workspace expired after 420 days; conversation history is still available. Use{' '}
                <strong>Continue editing</strong> or <strong>Undo publication</strong> above anytime.
              </div>
            )}

            {upstreamNotice && (upstreamNotice.heldOverlap || upstreamNotice.behind || upstreamNotice.coEditors.length > 0) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-950 space-y-1.5">
                {upstreamNotice.heldOverlap ? (
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      An update from the live site overlaps your edits on {upstreamNotice.heldOverlap} file
                      {upstreamNotice.heldOverlap === 1 ? '' : 's'}.
                    </span>
                    <button
                      type="button"
                      disabled={syncing}
                      onClick={() => void handleManualSync()}
                      className="shrink-0 rounded-lg bg-stone-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-stone-800"
                    >
                      Combine now
                    </button>
                  </div>
                ) : upstreamNotice.behind ? (
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      The live site has {upstreamNotice.newerCount} newer update
                      {upstreamNotice.newerCount === 1 ? '' : 's'}.
                    </span>
                    <button
                      type="button"
                      disabled={syncing}
                      onClick={() => void handleManualSync()}
                      className="shrink-0 rounded-lg bg-stone-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-stone-800"
                    >
                      Get latest
                    </button>
                  </div>
                ) : null}
                {upstreamNotice.coEditors.length > 0 && (
                  <p className="text-[11px] text-amber-800">
                    Heads up: {upstreamNotice.coEditors[0]!.ownerName} also has an unpublished draft (
                    &ldquo;{upstreamNotice.coEditors[0]!.title}&rdquo;).
                  </p>
                )}
              </div>
            )}

            {syncToast && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3.5 py-2 text-xs text-teal-900">
                <span>{syncToast}</span>
                <button
                  type="button"
                  onClick={() => setSyncToast(null)}
                  className="text-teal-700 hover:text-teal-950"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {syncReview && (
              <ConflictCards
                sessionId={session.id}
                review={syncReview}
                onUpdated={(next) => {
                  setSyncReview(next);
                  reloadPreview(true);
                  void loadSessionMeta();
                }}
                onUndone={() => {
                  setSyncReview(null);
                  setSyncToast('Update undone.');
                  reloadPreview(true);
                  void loadSessionMeta();
                }}
              />
            )}

            {/* Q2 / Q18: Unified Hybrid carry-over — read-only prior conversation above divider */}
            {priorThread && priorThread.entries.length > 0 && (
              <div className="space-y-3 opacity-75">
                {priorThread.entries.map((entry) => {
                  if (entry.role === 'user') {
                    const parsed = parseUserMessageDisplay(entry.text);
                    return (
                      <div key={`prior-${entry.id}`} className="flex flex-col items-end">
                        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-700 px-3.5 py-2 text-xs text-white whitespace-pre-wrap">
                          {parsed.body}
                        </div>
                      </div>
                    );
                  }
                  if (entry.role === 'assistant') {
                    return (
                      <div
                        key={`prior-${entry.id}`}
                        className="rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-700"
                      >
                        <ChatMessageContent text={entry.text} onNavigateRoute={navigatePreview} />
                      </div>
                    );
                  }
                  return null;
                })}
                <div className="flex items-center gap-2 py-1 text-[11px] font-medium text-stone-500">
                  <div className="h-px flex-1 bg-stone-200" />
                  <span className="truncate max-w-[85%]">
                    {session.kind === 'revert' ? (
                      <>
                        Undoing &ldquo;{priorThread.parentTitle}&rdquo;
                        {session.revertReason ? ` · ${session.revertReason}` : ''}
                      </>
                    ) : (
                      <>
                        Continued from &ldquo;{priorThread.parentTitle}&rdquo; ·{' '}
                        {new Date(priorThread.parentPublishedAt).toLocaleDateString()}
                      </>
                    )}
                  </span>
                  <div className="h-px flex-1 bg-stone-200" />
                </div>
              </div>
            )}

            {entries.length === 0 && Object.keys(pageRequestsMap).length === 0 && !live.busy && (
              session.kind === 'revert' ? (
                <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-stone-700">
                  <div>
                    <p className="font-medium text-stone-900">
                      Undo draft ready to review or refine.
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-stone-600">
                      All changes from this update are currently undone in the preview
                      {session.revertReason ? ` (Reason: “${session.revertReason}”)` : ''}. Click{' '}
                      <strong>Publish</strong> to undo everything, or tell Halley here if you only
                      want to undo a specific part and keep the rest.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-stone-200 bg-[#FAF9F7] p-4 text-sm text-stone-600">
                  <div>
                    <p className="font-medium text-stone-900">Ready when you are.</p>
                    <p className="mt-1 text-xs leading-relaxed text-stone-500">
                      Ask Halley to update schedules, add pages, or upload photos — or click any text in the preview using <strong>Edit</strong> mode to tweak copy directly.
                    </p>
                  </div>
                  {session.canEdit && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => openNewPageWizard()}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50/70 px-2.5 py-1 text-left text-[11px] font-medium text-amber-900 transition hover:bg-amber-100"
                      >
                      <FilePlus className="h-3 w-3" />
                      Add a new page
                    </button>
                    {[
                      `What's on this page (${currentRoute})?`,
                      'Add a new upcoming event',
                      'Check this page on desktop and mobile',
                    ].map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => sendPrompt(undefined, starter)}
                        className="rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-left text-[11px] font-medium text-stone-700 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900"
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              )
            )}

            {groupTranscriptEntries(entries, persona === 'non-technical').map((block) => {
              if (block.kind === 'steps') {
                const isOpen = expandedTool === block.id;
                const toolSteps = block.items.filter((i) => i.role === 'tool');
                const stepCount = toolSteps.length || block.items.length;
                return (
                  <div key={block.id} className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedTool(isOpen ? null : block.id)}
                      className="flex w-full items-center justify-between text-stone-600"
                    >
                      <span className="font-medium">
                        {stepCount === 1
                          ? friendlyToolLabel(toolSteps[0]?.toolName)
                          : `Completed ${stepCount} steps`}
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOpen && (
                      <div className="mt-2 space-y-1.5 border-t border-stone-200/70 pt-2 text-[11px] text-stone-500">
                        {block.items.map((step) =>
                          step.role === 'tool' ? (
                            <div key={step.id} className="flex items-center justify-between gap-2">
                              <span className="font-medium text-stone-600">{friendlyToolLabel(step.toolName)}</span>
                              {step.toolStatus === 'error' && (
                                <span className="text-red-600 font-medium">issue</span>
                              )}
                            </div>
                          ) : (
                            <p key={step.id} className="text-stone-500 leading-relaxed">
                              {step.text}
                            </p>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                );
              }
              const entry = block.entry;
              if (entry.role === 'user') {
                if (entry.pageRequest) {
                  const livePr = pageRequestsMap[entry.pageRequest.pageRequestId] ?? entry.pageRequest;
                  return (
                    <NewPageCard
                      key={entry.id}
                      pageRequest={livePr}
                      persona={persona}
                      canEdit={session.canEdit}
                      spendCapped={spend.capped}
                      onNavigateRoute={navigatePreview}
                      onRetry={handleRetryPageRequest}
                      onDelete={handleDeletePage}
                    />
                  );
                }
                const parsed = parseUserMessageDisplay(entry.text);
                return (
                  <div key={entry.id} className="flex flex-col items-end gap-1">
                    {parsed.badges.length > 0 && (
                      <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
                        {parsed.badges.map((b, idx) => (
                          <span
                            key={idx}
                            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-900"
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-900 px-3.5 py-2.5 text-sm text-white whitespace-pre-wrap">
                      {parsed.body}
                    </div>
                  </div>
                );
              }
              if (entry.role === 'tool') {
                const isOpen = expandedTool === entry.id;
                return (
                  <div key={entry.id} className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedTool(isOpen ? null : entry.id)}
                      className="flex w-full items-center justify-between text-stone-600"
                    >
                      <span className="font-medium">{friendlyToolLabel(entry.toolName)}</span>
                      <ChevronDown className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOpen && entry.toolOutput && (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-stone-500">
                        {entry.toolOutput}
                      </pre>
                    )}
                  </div>
                );
              }
              return (
                <div key={entry.id}>
                  <ChatMessageContent
                    text={entry.text}
                    onNavigateRoute={navigatePreview}
                    knownRoutes={new Set(siteRoutes.map((r) => r.route))}
                    astroBase={session.astroBase}
                  />
                </div>
              );
            })}

            {(() => {
              const renderedIds = new Set(
                entries.map((e) => e.pageRequest?.pageRequestId).filter(Boolean) as string[],
              );
              const standalone = Object.values(pageRequestsMap)
                .filter((pr) => !renderedIds.has(pr.pageRequestId))
                .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
              return standalone.map((pr) => (
                <NewPageCard
                  key={`standalone-${pr.pageRequestId}`}
                  pageRequest={pr}
                  persona={persona}
                  canEdit={session.canEdit}
                  spendCapped={spend.capped}
                  onNavigateRoute={navigatePreview}
                  onRetry={handleRetryPageRequest}
                  onDelete={handleDeletePage}
                />
              ));
            })()}

            {live.activeTools
              .filter((t) => t.status !== 'done' && t.status !== 'error')
              .map((t) => (
                <div
                  key={t.callId}
                  className="flex items-center gap-2 rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2 text-xs text-amber-900"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
                  <span>{friendlyToolLabel(t.name)}…</span>
                </div>
              ))}

            {live.streamingText && (
              <div>
                <ChatMessageContent
                  text={live.streamingText}
                  onNavigateRoute={navigatePreview}
                  knownRoutes={new Set(siteRoutes.map((r) => r.route))}
                  astroBase={session.astroBase}
                />
                <span className="inline-block h-3.5 w-1.5 ml-0.5 animate-pulse bg-amber-600 align-middle" />
              </div>
            )}

            {live.runFailure && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800">
                <strong>Couldn&apos;t complete request:</strong> {live.runFailure.detail || live.runFailure.reason}
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Composer */}
          {session.canEdit && (
            <div className="border-t border-stone-200 p-3 space-y-2 bg-white">
              {(spendPct >= 75 || spend.capped) && (
                <div
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] ${
                    spend.capped
                      ? 'bg-red-50 text-red-800 border border-red-200'
                      : 'bg-amber-50 text-amber-900 border border-amber-200'
                  }`}
                >
                  {spend.capped
                    ? 'Daily AI budget reached. Ask an admin to grant extra allowance.'
                    : `Daily AI budget ${Math.round(spendPct)}% used ($${spend.spentTodayUsd.toFixed(2)} / $${(spend.dailyCapUsd + spend.extraGrantedUsd).toFixed(2)})`}
                </div>
              )}

              {chips.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-stone-500">
                    <span>
                      {chips.length} {chips.length === 1 ? 'selection' : 'selections'} attached
                    </span>
                    <button
                      type="button"
                      onClick={() => setChips([])}
                      className="font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-red-700"
                    >
                      Clear all
                    </button>
                  </div>
                  <div ref={chipRowRef} className="flex flex-wrap gap-1.5">
                    {chips.map((c) => {
                      const onOtherPage = c.route !== currentRoute;
                      const tooltip =
                        persona === 'developer'
                          ? `${c.route} · <${c.tagName}> · ${c.file}`
                          : onOtherPage
                            ? `On ${c.route} — click to view on page`
                            : `On ${c.route}`;
                      return (
                        <span
                          key={chipKeyOf(c)}
                          data-chip-key={chipKeyOf(c)}
                          title={tooltip}
                          onMouseEnter={() => !onOtherPage && highlightInPreview(elementKey(c))}
                          onMouseLeave={() => highlightInPreview(null)}
                          className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 py-0.5 pl-0.5 pr-2 text-[11px] font-medium text-amber-900"
                        >
                          <button
                            type="button"
                            onClick={() => focusChipInPreview(c)}
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px] font-bold text-white">
                              {chips.findIndex((x) => elementKey(x) === elementKey(c)) + 1}
                            </span>
                            <span className="truncate max-w-[170px]">{chipLabelOf(c, persona)}</span>
                            {onOtherPage && (
                              <span className="rounded bg-amber-100/80 px-1 text-[10px] text-amber-800">
                                {c.route}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label="Remove from chat"
                            onClick={() => {
                              highlightInPreview(null);
                              setChips((prev) => prev.filter((x) => chipKeyOf(x) !== chipKeyOf(c)));
                            }}
                            className="ml-0.5 hover:text-red-700"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  {!input.trim() && !live.busy && !spend.capped && (
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      {(
                        [
                          {
                            label: 'Rewrite clearer',
                            prompt:
                              chips.length === 1
                                ? 'Rewrite this so it reads more clearly and warmly while keeping all factual details.'
                                : 'Rewrite these selected sections so they read more clearly and warmly while keeping all factual details.',
                          },
                          {
                            label: 'Explain this',
                            prompt:
                              chips.length === 1
                                ? 'Explain where this content comes from and how it works.'
                                : 'Explain where these selected sections come from and how they work.',
                          },
                          {
                            label: 'Remove this',
                            prompt:
                              chips.length === 1
                                ? 'Remove this from the page cleanly.'
                                : 'Remove these selected items from the page cleanly.',
                          },
                        ] as const
                      ).map((q) => (
                        <button
                          key={q.label}
                          type="button"
                          onClick={() => sendPrompt(undefined, q.prompt)}
                          className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-[11px] font-medium text-stone-600 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900"
                        >
                          {q.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {attachments.map((a) => (
                    <div key={a.stagedId} className="relative group">
                      {a.thumbnailDataUrl ? (
                        <img
                          src={a.thumbnailDataUrl}
                          alt={a.filename}
                          className="h-12 w-12 rounded-lg object-cover border border-stone-200"
                        />
                      ) : (
                        <div className="flex h-12 w-20 items-center justify-center rounded-lg border border-stone-200 bg-stone-50 text-[10px] px-1 truncate">
                          {a.filename}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((x) => x.stagedId !== a.stagedId))
                        }
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-stone-900 p-0.5 text-white shadow"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                  {attachments.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setAttachments([])}
                      className="text-[11px] font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-red-700"
                    >
                      Clear photos
                    </button>
                  )}
                </div>
              )}

              <div
                ref={composerRef}
                className="rounded-xl border border-stone-300 bg-[#FAF9F7] p-2 focus-within:border-amber-600 focus-within:bg-white"
              >
                <textarea
                  ref={textareaRef}
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendPrompt(live.busy ? 'followUp' : undefined);
                    }
                  }}
                  placeholder={
                    live.busy
                      ? 'Send a redirect or queue your next request…'
                      : chips.length > 0
                        ? `What should Halley change about ${chips.length === 1 ? 'this' : 'these'}?`
                        : `Ask Halley about ${currentRoute}, or drop an image…`
                  }
                  className="w-full resize-none bg-transparent text-sm text-stone-900 placeholder:text-stone-400 outline-none"
                />

                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => void handleFiles(e.target.files)}
                    />
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach photo"
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-200/60 hover:text-stone-900"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      {uploading ? 'Uploading…' : 'Photo'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const next = persona === 'non-technical' ? 'developer' : 'non-technical';
                        setPersona(next);
                        await api.updatePreferences(next).catch(() => {});
                      }}
                      title="Switch Halley's communication style"
                      className="rounded-lg px-2 py-1 text-[11px] font-medium text-stone-400 hover:bg-stone-200/60 hover:text-stone-700"
                    >
                      {persona === 'non-technical' ? 'Tone: Plain-English' : 'Tone: Technical'}
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {live.busy ? (
                      <>
                        <button
                          type="button"
                          onClick={() => wsRef.current?.send(JSON.stringify({ type: 'abort' }))}
                          className="inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
                        >
                          <Square className="h-3 w-3 fill-current" /> Stop
                        </button>
                        <button
                          type="button"
                          onClick={() => sendPrompt('steer')}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                        >
                          Steer
                        </button>
                        <button
                          type="button"
                          onClick={() => sendPrompt('followUp')}
                          className="rounded-lg bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-800"
                        >
                          Queue
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={spend.capped}
                        onClick={() => sendPrompt()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
                      >
                        <Send className="h-3 w-3" /> Send
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* Right Preview Stage */}
        <main className="flex flex-1 flex-col min-w-0 bg-[#F3F1EE]">
          <div className="hidden h-11 shrink-0 items-center justify-between border-b border-[#E7E5E4] bg-[#FAF9F7] px-4 sm:flex">
            <div className="relative flex items-center gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  const next = !showPageSwitcher;
                  setShowPageSwitcher(next);
                  if (next) {
                    try {
                      const rt = await api.getRoutes(sessionId);
                      setSiteRoutes(rt.routes);
                    } catch {
                      // ignore
                    }
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1 font-mono text-xs text-stone-700 hover:border-stone-300 hover:text-stone-900"
                title="Switch or create page"
              >
                <span>{currentRoute}</span>
                <ChevronDown className="h-3 w-3 text-stone-400" />
              </button>

              {showPageSwitcher && (
                <div className="absolute left-0 top-9 z-40 w-80 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
                  <input
                    type="text"
                    value={routeQuery}
                    onChange={(e) => setRouteQuery(e.target.value)}
                    placeholder="Filter pages…"
                    className="w-full rounded-lg border border-stone-200 bg-[#FAF9F7] px-2.5 py-1.5 text-xs outline-none focus:border-amber-600 focus:bg-white"
                  />
                  <div className="mt-1.5 max-h-60 overflow-y-auto divide-y divide-stone-100">
                    {siteRoutes
                      .filter((r) => r.route.toLowerCase().includes(routeQuery.toLowerCase()))
                      .map((r) => (
                        <button
                          key={r.route}
                          type="button"
                          onClick={() => navigatePreview(r.route)}
                          className={`flex w-full items-center justify-between px-2.5 py-2 text-left text-xs hover:bg-stone-50 ${
                            currentRoute === r.route ? 'font-semibold text-amber-800 bg-amber-50/40' : 'text-stone-700'
                          }`}
                        >
                          <span className="font-mono truncate">{r.route}</span>
                          {r.unlisted && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-500">
                              <EyeOff className="h-2.5 w-2.5" /> Unlisted
                            </span>
                          )}
                        </button>
                      ))}
                    {siteRoutes.length === 0 && (
                      <p className="px-2.5 py-3 text-xs text-stone-400">Loading pages…</p>
                    )}
                  </div>

                  {session.canEdit && (
                    <div className="mt-1.5 border-t border-stone-100 pt-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const filtered = siteRoutes.filter((r) =>
                            r.route.toLowerCase().includes(routeQuery.toLowerCase()),
                          );
                          const prefill = filtered.length === 0 ? routeQuery.trim() : '';
                          setRouteQuery('');
                          openNewPageWizard(prefill);
                        }}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50"
                      >
                        <FilePlus className="h-3.5 w-3.5" />
                        {routeQuery.trim() &&
                        siteRoutes.filter((r) => r.route.toLowerCase().includes(routeQuery.toLowerCase())).length === 0
                          ? `New page "${routeQuery.trim()}"…`
                          : 'New page…'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <PageToolbarControls
                sessionId={session.id}
                currentRoute={currentRoute}
                currentRouteEntry={siteRoutes.find((r) => r.route === currentRoute)}
                canEdit={session.canEdit}
                viewport={viewport}
                onVisibilityChanged={async () => {
                  await loadSessionMeta();
                  reloadPreview(true);
                }}
                onRenamed={async (newRoute) => {
                  await loadSessionMeta();
                  navigatePreview(newRoute);
                }}
              />

              {session.canEdit && (
                <button
                  type="button"
                  onClick={() => openNewPageWizard()}
                  title="Create a new page"
                  className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-[11px] font-medium text-stone-700 hover:border-amber-400 hover:bg-amber-50 hover:text-amber-900"
                >
                  <Plus className="h-3 w-3" />
                  <span>New page</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => reloadPreview(true)}
                title="Reload preview"
                className="rounded-md p-1 text-stone-500 hover:bg-stone-200/70 hover:text-stone-900"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            {session.canEdit && (
              <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5 text-xs">
                {(
                  [
                    { id: 'browse', label: 'Browse', Icon: MousePointer },
                    { id: 'edit', label: 'Edit', Icon: PenLine },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMode(id)}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition ${
                      mode === id
                        ? 'bg-stone-900 text-white'
                        : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
              {(
                [
                  { id: 'desktop', Icon: Monitor },
                  { id: 'tablet', Icon: Tablet },
                  { id: 'mobile', Icon: Smartphone },
                ] as const
              ).map(({ id, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setViewport(id)}
                  className={`rounded-md p-1.5 transition ${
                    viewport === id
                      ? 'bg-stone-100 text-stone-900'
                      : 'text-stone-400 hover:text-stone-700'
                  }`}
                  title={id}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-auto p-0 sm:p-4">
            <div
              className="relative h-full overflow-hidden bg-white transition-all duration-200 sm:rounded-xl sm:border sm:border-[#E7E5E4] sm:shadow-sm"
              style={{
                width: isMobile
                  ? '100%'
                  : viewport === 'mobile'
                    ? '390px'
                    : viewport === 'tablet'
                      ? '768px'
                      : '100%',
              }}
            >
              <iframe
                ref={iframeRef}
                src={previewSrc}
                title="Live Astro Preview"
                className="h-full w-full border-0"
              />
              {isPreviewPaused && (
                <PreviewVerifyingOverlay reason={previewPaused.reason} />
              )}
            </div>
          </div>
        </main>
      </div>
      )}

      {/* Mobile Floating Chat Bubble + Compact Card (< 640px) */}
      {isMobile && !isWorkspaceBooting && (
        <>
          <MobileChatBubble
            visible={
              !mobileChatOpen &&
              !previewSelectionActive &&
              !mobileSheet &&
              !showPublish &&
              !showNewPageModal &&
              !showDebug &&
              !showBranchOffModal &&
              !showUndoPubModal
            }
            pos={mobileBubblePos}
            onChangePos={setMobileBubblePos}
            onTap={() => {
              setMobileCompletionToast(null);
              setMobileChatOpen(true);
            }}
            busy={live.busy}
            chipCount={chips.length}
            needsAttention={needsMobileAttention}
            entryPulse={entries.length === 0 && !live.busy}
            completionToast={mobileCompletionToast}
            onTapToast={() => {
              setMobileCompletionToast(null);
              setMobileChatOpen(true);
            }}
          />

          <MobileChatCard
            open={mobileChatOpen}
            bubblePos={mobileBubblePos}
          canEdit={session.canEdit}
          currentRoute={currentRoute}
          astroBase={session.astroBase}
          knownRoutes={new Set(siteRoutes.map((r) => r.route))}
          persona={persona}
          spend={spend}
          entries={entries}
          live={live}
          input={input}
          onChangeInput={setInput}
          chips={chips}
          onRemoveChip={(key) => {
            highlightInPreview(null);
            setChips((prev) => prev.filter((x) => chipKeyOf(x) !== key));
          }}
          onClearChips={() => setChips([])}
          onFocusChip={(c) => {
            setMobileChatOpen(false);
            focusChipInPreview(c);
          }}
          attachments={attachments}
          onRemoveAttachment={(stagedId) =>
            setAttachments((prev) => prev.filter((x) => x.stagedId !== stagedId))
          }
          uploading={uploading}
          onTriggerPhotoUpload={() => fileInputRef.current?.click()}
          onSend={(whenBusy, overrideText) => sendPrompt(whenBusy, overrideText)}
          onAbort={() => wsRef.current?.send(JSON.stringify({ type: 'abort' }))}
          onOpenNewPage={() => {
            setMobileChatOpen(false);
            openNewPageWizard();
          }}
          onNavigateRouteAndClose={(route) => {
            setMobileChatOpen(false);
            navigatePreview(route);
          }}
          onShowHistory={() => {
            setMobileChatOpen(false);
            setMobileSheet('history');
          }}
          onClose={() => setMobileChatOpen(false)}
          notice={mobileNotice}
          friendlyToolLabel={friendlyToolLabel}
          chipRowRef={mobileChipRowRef}
          composerRef={mobileComposerRef}
          textareaRef={mobileTextareaRef}
        />
        </>
      )}

      {/* Mobile Full-Screen Sheets */}
      {isMobile && mobileSheet === 'history' && (
        <MobileFullSheet
          title="Conversation History"
          subtitle={session.title}
          onClose={() => setMobileSheet(null)}
        >
          <div className="space-y-4">
            {priorThread && priorThread.entries.length > 0 && (
              <div className="space-y-3 opacity-75">
                {priorThread.entries.map((entry) => {
                  if (entry.role === 'user') {
                    const parsed = parseUserMessageDisplay(entry.text);
                    return (
                      <div key={`m-prior-${entry.id}`} className="flex flex-col items-end">
                        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-700 px-3.5 py-2 text-xs text-white whitespace-pre-wrap">
                          {parsed.body}
                        </div>
                      </div>
                    );
                  }
                  if (entry.role === 'assistant') {
                    return (
                      <div
                        key={`m-prior-${entry.id}`}
                        className="rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-700"
                      >
                        <ChatMessageContent
                          text={entry.text}
                          onNavigateRoute={(r) => {
                            setMobileSheet(null);
                            navigatePreview(r);
                          }}
                        />
                      </div>
                    );
                  }
                  return null;
                })}
                <div className="flex items-center gap-2 py-1 text-[11px] font-medium text-stone-500">
                  <div className="h-px flex-1 bg-stone-200" />
                  <span className="truncate max-w-[85%]">
                    {session.kind === 'revert'
                      ? `Undoing “${priorThread.parentTitle}”`
                      : `Continued from “${priorThread.parentTitle}”`}
                  </span>
                  <div className="h-px flex-1 bg-stone-200" />
                </div>
              </div>
            )}

            {entries.length === 0 && Object.keys(pageRequestsMap).length === 0 ? (
              session.kind === 'revert' ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5 text-xs text-stone-600">
                  <p className="font-medium text-stone-900">Undo draft ready to review or refine.</p>
                  <p className="mt-1 leading-relaxed">
                    All changes from this update are currently undone in the preview. Tell Halley
                    here if you only want to undo a specific part and keep the rest.
                  </p>
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-stone-500">No messages yet.</p>
              )
            ) : (
              groupTranscriptEntries(entries, persona === 'non-technical').map((block) => {
                if (block.kind === 'steps') {
                  const isOpen = expandedTool === `m-${block.id}`;
                  const toolSteps = block.items.filter((i) => i.role === 'tool');
                  const stepCount = toolSteps.length || block.items.length;
                  return (
                    <div
                      key={`m-${block.id}`}
                      className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-2 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedTool(isOpen ? null : `m-${block.id}`)}
                        className="flex w-full items-center justify-between text-stone-600"
                      >
                        <span className="font-medium">
                          {stepCount === 1
                            ? friendlyToolLabel(toolSteps[0]?.toolName)
                            : `Completed ${stepCount} steps`}
                        </span>
                        <ChevronDown className={`h-3.5 w-3.5 transition ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen && (
                        <div className="mt-2 space-y-1.5 border-t border-stone-200/70 pt-2 text-[11px] text-stone-500">
                          {block.items.map((step) =>
                            step.role === 'tool' ? (
                              <div key={step.id} className="font-medium text-stone-600">
                                {friendlyToolLabel(step.toolName)}
                              </div>
                            ) : (
                              <p key={step.id}>{step.text}</p>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                }
                const entry = block.entry;
                if (entry.role === 'user') {
                  if (entry.pageRequest) {
                    const livePr = pageRequestsMap[entry.pageRequest.pageRequestId] ?? entry.pageRequest;
                    return (
                      <NewPageCard
                        key={`m-${entry.id}`}
                        pageRequest={livePr}
                        persona={persona}
                        canEdit={session.canEdit}
                        spendCapped={spend.capped}
                        onNavigateRoute={(r) => {
                          setMobileSheet(null);
                          navigatePreview(r);
                        }}
                        onRetry={handleRetryPageRequest}
                        onDelete={handleDeletePage}
                      />
                    );
                  }
                  const parsed = parseUserMessageDisplay(entry.text);
                  return (
                    <div key={`m-${entry.id}`} className="flex flex-col items-end gap-1">
                      {parsed.badges.length > 0 && (
                        <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
                          {parsed.badges.map((b, idx) => (
                            <span
                              key={idx}
                              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-900"
                            >
                              {b}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-stone-900 px-3.5 py-2.5 text-sm text-white whitespace-pre-wrap">
                        {parsed.body}
                      </div>
                    </div>
                  );
                }
                if (entry.role === 'tool') {
                  return (
                    <div
                      key={`m-${entry.id}`}
                      className="rounded-lg border border-stone-200/80 bg-[#FAF9F7] px-3 py-1.5 text-xs text-stone-600"
                    >
                      {friendlyToolLabel(entry.toolName)}
                    </div>
                  );
                }
                return (
                  <div key={`m-${entry.id}`}>
                    <ChatMessageContent
                      text={entry.text}
                      onNavigateRoute={(r) => {
                        setMobileSheet(null);
                        navigatePreview(r);
                      }}
                      knownRoutes={new Set(siteRoutes.map((r) => r.route))}
                      astroBase={session.astroBase}
                    />
                  </div>
                );
              })
            )}
          </div>
        </MobileFullSheet>
      )}

      {isMobile && mobileSheet === 'review' && (
        <MobileFullSheet
          title="Review Updates"
          subtitle="Resolve live site updates or page issues"
          onClose={() => setMobileSheet(null)}
        >
          <div className="space-y-4">
            {syncReview && (
              <ConflictCards
                sessionId={session.id}
                review={syncReview}
                onUpdated={(next) => {
                  setSyncReview(next);
                  reloadPreview(true);
                  void loadSessionMeta();
                }}
                onUndone={() => {
                  setSyncReview(null);
                  setSyncToast('Update undone.');
                  setMobileSheet(null);
                  reloadPreview(true);
                  void loadSessionMeta();
                }}
              />
            )}
            {Object.values(pageRequestsMap)
              .filter((pr) => pr.status === 'failed' || pr.status === 'capped')
              .map((pr) => (
                <NewPageCard
                  key={`review-${pr.pageRequestId}`}
                  pageRequest={pr}
                  persona={persona}
                  canEdit={session.canEdit}
                  spendCapped={spend.capped}
                  onNavigateRoute={(r) => {
                    setMobileSheet(null);
                    navigatePreview(r);
                  }}
                  onRetry={handleRetryPageRequest}
                  onDelete={handleDeletePage}
                />
              ))}
          </div>
        </MobileFullSheet>
      )}

      {isMobile && mobileSheet === 'pages' && (
        <MobileFullSheet
          title="Switch Page"
          subtitle={`Currently on ${currentRoute}`}
          onClose={() => setMobileSheet(null)}
          footer={
            session.canEdit ? (
              <button
                type="button"
                onClick={() => {
                  const filtered = siteRoutes.filter((r) =>
                    r.route.toLowerCase().includes(routeQuery.toLowerCase()),
                  );
                  const prefill = filtered.length === 0 ? routeQuery.trim() : '';
                  setRouteQuery('');
                  setMobileSheet(null);
                  openNewPageWizard(prefill);
                }}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white"
              >
                <FilePlus className="h-4 w-4" />
                New page…
              </button>
            ) : undefined
          }
        >
          <div className="space-y-3">
            <input
              type="text"
              value={routeQuery}
              onChange={(e) => setRouteQuery(e.target.value)}
              placeholder="Filter pages…"
              className="w-full rounded-xl border border-stone-300 bg-[#FAF9F7] px-3.5 py-2.5 text-sm outline-none focus:border-amber-600 focus:bg-white"
            />
            <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
              {siteRoutes
                .filter((r) => r.route.toLowerCase().includes(routeQuery.toLowerCase()))
                .map((r) => (
                  <button
                    key={r.route}
                    type="button"
                    onClick={() => navigatePreview(r.route)}
                    className={`flex min-h-[44px] w-full items-center justify-between px-3.5 py-2.5 text-left text-sm ${
                      currentRoute === r.route ? 'bg-amber-50/60 font-semibold text-amber-900' : 'text-stone-800'
                    }`}
                  >
                    <span className="truncate font-mono text-xs">{r.route}</span>
                    {r.unlisted && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-500">
                        <EyeOff className="h-2.5 w-2.5" /> Unlisted
                      </span>
                    )}
                  </button>
                ))}
              {siteRoutes.length === 0 && (
                <p className="px-3.5 py-4 text-xs text-stone-400">Loading pages…</p>
              )}
            </div>
          </div>
        </MobileFullSheet>
      )}

      {isMobile && mobileSheet === 'menu' && (
        <MobileFullSheet
          title={session.title}
          subtitle={`Page: ${currentRoute}`}
          onClose={() => setMobileSheet(null)}
        >
          <div className="space-y-4">
            {session.canEdit && currentRoute !== '/' && (
              <div className="rounded-xl border border-stone-200 bg-[#FAF9F7] p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  Current Page
                </p>
                <PageToolbarControls
                  sessionId={session.id}
                  currentRoute={currentRoute}
                  currentRouteEntry={siteRoutes.find((r) => r.route === currentRoute)}
                  canEdit={session.canEdit}
                  viewport={viewport}
                  inlineMobile
                  onVisibilityChanged={async () => {
                    await loadSessionMeta();
                    reloadPreview(true);
                    setMobileSheet(null);
                  }}
                  onRenamed={async (newRoute) => {
                    await loadSessionMeta();
                    navigatePreview(newRoute);
                  }}
                />
              </div>
            )}

            <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
              <button
                type="button"
                onClick={() => {
                  setMobileSheet(null);
                  onBack();
                }}
                className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
              >
                <LayoutGrid className="h-4 w-4 text-stone-500" />
                All edits
              </button>
              {session.canEdit && (
                <>
                  <button
                    type="button"
                    disabled={checkpoints.length < 1}
                    onClick={async () => {
                      setMobileSheet(null);
                      await handleUndoLast();
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800 disabled:opacity-40"
                  >
                    <Undo2 className="h-4 w-4 text-stone-500" />
                    Undo last change
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobileSheet('checkpoints')}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
                  >
                    <History className="h-4 w-4 text-stone-500" />
                    Checkpoint history ({checkpoints.length})
                  </button>
                  <button
                    type="button"
                    disabled={syncing || live.busy}
                    onClick={async () => {
                      setMobileSheet(null);
                      await handleManualSync();
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800 disabled:opacity-40"
                  >
                    <RefreshCw className={`h-4 w-4 text-stone-500 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Updating from live site…' : 'Get latest from live site'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileSheet(null);
                      openNewPageWizard();
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
                  >
                    <FilePlus className="h-4 w-4 text-amber-700" />
                    New page…
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileSheet(null);
                      setBranchOffError(null);
                      setShowBranchOffModal(true);
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
                  >
                    <GitBranch className="h-4 w-4 text-stone-500" />
                    Branch off copy
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const next = persona === 'non-technical' ? 'developer' : 'non-technical';
                      setPersona(next);
                      await api.updatePreferences(next).catch(() => {});
                    }}
                    className="flex min-h-[48px] w-full items-center justify-between px-4 text-left text-sm font-medium text-stone-800"
                  >
                    <span>Halley tone</span>
                    <span className="text-xs text-stone-500">
                      {persona === 'non-technical' ? 'Plain-English' : 'Technical'}
                    </span>
                  </button>
                </>
              )}

              {(session.status === 'published' || session.status === 'merged') && session.mergedSha && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileSheet(null);
                    setUndoPubReason('');
                    setShowUndoPubModal(true);
                  }}
                  className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-red-700"
                >
                  <RotateCcw className="h-4 w-4" />
                  Undo publication
                </button>
              )}

              {session.status === 'merged' && (
                <button
                  type="button"
                  onClick={async () => {
                    setMobileSheet(null);
                    await api.retryDeploy(session.id);
                    await loadSessionMeta();
                  }}
                  className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-amber-900"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry deploy check
                </button>
              )}

              {!session.canEdit && session.status !== 'published' && session.status !== 'merged' && (
                <>
                  <button
                    type="button"
                    onClick={async () => {
                      setMobileSheet(null);
                      const { session: dup } = await api.duplicateSession(session.id);
                      onOpenSession(dup.id);
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
                  >
                    <Copy className="h-4 w-4 text-stone-500" />
                    Duplicate into my edit
                  </button>
                  {user.isAdmin && (
                    <button
                      type="button"
                      onClick={async () => {
                        setMobileSheet(null);
                        await api.takeoverSession(session.id);
                        await loadSessionMeta();
                      }}
                      className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-semibold text-stone-900"
                    >
                      Take over draft
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  setMobileSheet(null);
                  reloadPreview(true);
                }}
                className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-800"
              >
                <RefreshCw className="h-4 w-4 text-stone-500" />
                Reload preview
              </button>

              <button
                type="button"
                onClick={() => {
                  setMobileSheet(null);
                  setShowDebug(true);
                }}
                className="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-stone-600"
              >
                <Bug className="h-4 w-4 text-stone-500" />
                Agent debug trace
              </button>
            </div>
          </div>
        </MobileFullSheet>
      )}

      {isMobile && mobileSheet === 'checkpoints' && (
        <MobileFullSheet
          title="Checkpoint History"
          subtitle="Restore an earlier save point"
          onClose={() => setMobileSheet(null)}
        >
          {checkpoints.length === 0 ? (
            <p className="py-8 text-center text-xs text-stone-500">No checkpoints yet.</p>
          ) : (
            <div className="divide-y divide-stone-100 rounded-xl border border-stone-200 bg-white">
              {checkpoints.map((c, idx) => (
                <div key={c.sha} className="px-4 py-3 text-xs">
                  {c.isSyncBoundary && (
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-teal-700">
                      Updated from live site · {new Date(c.timestamp).toLocaleDateString()}
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-stone-900">{c.summary}</p>
                      <p className="mt-0.5 text-[11px] text-stone-400">
                        {new Date(c.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                    {idx > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          setMobileSheet(null);
                          await handleRestoreCheckpoint(c.sha);
                        }}
                        className="min-h-[36px] shrink-0 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-700"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </MobileFullSheet>
      )}

      {showUndoPubModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/35 p-4 backdrop-blur-[2px]">
          <form
            onSubmit={handleConfirmUndoPublication}
            className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl space-y-4 sm:p-6"
          >
            <div>
              <h3 className="text-base font-semibold text-stone-900">
                Undo &ldquo;{session.title}&rdquo;?
              </h3>
              <p className="mt-1 text-xs text-stone-500">
                Prepare an undo draft on top of the latest live site so you can review before publishing.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-stone-700">
                Reason for undoing (required)
              </label>
              <input
                type="text"
                required
                value={undoPubReason}
                onChange={(e) => setUndoPubReason(e.target.value)}
                placeholder='e.g. "Wrong service time listed"'
                className="w-full rounded-xl border border-stone-300 px-3.5 py-2 text-sm focus:border-stone-900 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowUndoPubModal(false)}
                className="min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!undoPubReason.trim() || undoPubBusy}
                className="min-h-[40px] rounded-lg bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
              >
                {undoPubBusy ? 'Preparing undo…' : 'Review & undo'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showNewPageModal && (
        <NewPageModal
          sessionId={session.id}
          initialTitle={newPageInitialTitle}
          currentRoute={currentRoute}
          editorContext={{ currentRoute, viewport, mode }}
          isBusy={live.busy}
          spendCapped={spend.capped}
          onClose={() => setShowNewPageModal(false)}
          onCreated={(result) => {
            setShowNewPageModal(false);
            setPageRequestsMap((prev) => ({
              ...prev,
              [result.pageRequest.pageRequestId]: result.pageRequest,
            }));
            navigatePreview(result.route);
            void loadSessionMeta();
          }}
          onOpenExistingRoute={(route) => navigatePreview(route)}
        />
      )}

      {showPublish && (
        <PublishModal
          session={session}
          persona={persona}
          currentRoute={currentRoute}
          publishProgress={publishProgress}
          onClose={() => setShowPublish(false)}
          onAskHalleyToFix={async (summary, logs) => {
            await api.fixWithPi(session.id, summary, logs);
          }}
          onStartNewEdit={onBack}
          onChangedFilesUpdated={async () => {
            await loadSessionMeta();
          }}
        />
      )}

      {showBranchOffModal && (
        <BranchOffModal
          draftTitle={session.title}
          busy={branchOffBusy}
          error={branchOffError}
          onCancel={() => {
            if (!branchOffBusy) {
              setShowBranchOffModal(false);
              setBranchOffError(null);
            }
          }}
          onConfirm={() => void handleConfirmBranchOff()}
        />
      )}

      {showDebug && (
        <DebugTraceDrawer
          sessionId={session.id}
          sessionTitle={session.title}
          currentRoute={currentRoute}
          wsConnected={wsConnected}
          onClose={() => setShowDebug(false)}
        />
      )}
    </div>
  );
}
