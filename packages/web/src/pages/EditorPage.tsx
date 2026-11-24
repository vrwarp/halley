import type {
  ChatServerMessage,
  CheckpointInfo,
  EditorSessionDto,
  ElementContext,
  LiveRunStateDto,
  PostMessageFromPreview,
  PreviewMode,
  PublishProgressPayload,
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
  History,
  ImagePlus,
  Loader2,
  Monitor,
  MousePointer,
  PenLine,
  RefreshCw,
  Send,
  Smartphone,
  Square,
  Tablet,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ChatMessageContent, parseUserMessageDisplay } from '../components/ChatMessageContent.js';
import { DebugTraceDrawer } from '../components/DebugTraceDrawer.js';
import { PublishModal } from '../components/PublishModal.js';

interface Props {
  sessionId: string;
  user: UserDto;
  initialSpend: SpendStatusDto;
  onBack: () => void;
  onOpenSession: (id: string) => void;
}

function friendlyToolLabel(name?: string): string {
  switch (name) {
    case 'read':
      return 'Read file';
    case 'edit':
    case 'write':
      return 'Updated file';
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
  onBack,
  onOpenSession,
}: Props) {
  const [session, setSession] = useState<EditorSessionDto | null>(null);
  const [spend, setSpend] = useState<SpendStatusDto>(initialSpend);
  const [entries, setEntries] = useState<TranscriptEntryDto[]>([]);
  const [live, setLive] = useState<LiveRunStateDto>({
    busy: false,
    activeTools: [],
    queuedCount: 0,
  });
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [changedCount, setChangedCount] = useState(0);
  const [publishProgress, setPublishProgress] = useState<PublishProgressPayload | null>(null);

  const [mode, setMode] = useState<PreviewMode>('browse');
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [currentRoute, setCurrentRoute] = useState('/');
  const [siteRoutes, setSiteRoutes] = useState<Array<{ route: string; label: string; unlisted?: boolean }>>([]);
  const [showPageSwitcher, setShowPageSwitcher] = useState(false);
  const [routeQuery, setRouteQuery] = useState('');
  const [showNewPageForm, setShowNewPageForm] = useState(false);
  const [newPagePath, setNewPagePath] = useState('');
  const [newPageUnlisted, setNewPageUnlisted] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

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

  const loadSessionMeta = async () => {
    const res = await api.getSession(sessionId);
    setSession(res.session);
    setSpend(res.spend);
    setChangedCount(res.session.changedFilesCount);
    if (!res.session.canEdit) setMode('browse');
    try {
      const [ch, rt] = await Promise.all([api.getChanges(sessionId), api.getRoutes(sessionId)]);
      setChangesFromServer(ch.changes.length, ch.checkpoints);
      setSiteRoutes(rt.routes);
    } catch {
      // runner may still be booting
    }
  };

  const setChangesFromServer = (count: number, ckpts: CheckpointInfo[]) => {
    setChangedCount(count);
    setCheckpoints(ckpts);
  };

  useEffect(() => {
    void loadSessionMeta();
  }, [sessionId]);

  useEffect(() => {
    if (!session || session.status !== 'starting') return;
    const timer = setInterval(() => {
      void loadSessionMeta();
    }, 2000);
    return () => clearInterval(timer);
  }, [sessionId, session?.status]);

  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/sessions/${sessionId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setWsConnected(true);
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as ChatServerMessage;
        if (msg.type === 'transcript_state') {
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
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
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
  }, [sessionId]);

  // Fallback HTTP transcript polling whenever WebSocket is disconnected (e.g. reverse proxy without WS headers)
  useEffect(() => {
    if (wsConnected) return;
    const poll = () => {
      void api
        .getTranscript(sessionId)
        .then((t) => {
          setEntries(t.entries);
          setLive(t.live);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [sessionId, wsConnected]);

  // Track mutating tools during an agent run and refresh preview + session metadata when the run completes
  useEffect(() => {
    if (live.busy) {
      if (live.activeTools.some((t) => ['edit', 'write', 'bash', 'undo_last_change'].includes(t.name))) {
        hadMutatingToolRef.current = true;
      }
    } else if (prevBusyRef.current) {
      void loadSessionMeta();
      if (hadMutatingToolRef.current || !wsConnected) {
        reloadPreview();
      }
      hadMutatingToolRef.current = false;
    }
    prevBusyRef.current = live.busy;
  }, [live.busy, live.activeTools, wsConnected]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length, live.streamingText]);

  useEffect(() => {
    if (!session) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'halley:set-mode', mode, readOnly: !session.canEdit },
      '*',
    );
  }, [mode, session?.canEdit]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as PostMessageFromPreview;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'halley:ready') {
        if (pendingRouteRef.current === data.route) {
          pendingRouteRef.current = null;
        }
        setCurrentRoute(data.route);
        if (session) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'halley:set-mode', mode, readOnly: !session.canEdit },
            '*',
          );
        }
      } else if (data.type === 'halley:route-changed') {
        if (pendingRouteRef.current === data.route) {
          pendingRouteRef.current = null;
        }
        setCurrentRoute(data.route);
      } else if (data.type === 'halley:element-context') {
        setChips((prev) => {
          const exists = prev.some((c) => c.file === data.context.file && c.loc === data.context.loc);
          return exists ? prev : [...prev, data.context];
        });
      } else if (data.type === 'halley:patch-saved') {
        void loadSessionMeta();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [mode, session]);

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
  };

  const sendPrompt = (whenBusy?: 'steer' | 'followUp', overrideText?: string) => {
    if (!session?.canEdit) return;
    const textToSend = (overrideText ?? input).trim();
    if (!textToSend && attachments.length === 0 && chips.length === 0) return;
    dispatchClientMessage({
      type: 'submit_input',
      requestId: crypto.randomUUID(),
      text: textToSend || 'Please use the attached context/image.',
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
      <div className="flex h-screen items-center justify-center bg-[#FAF9F7] text-sm text-stone-500">
        Loading workspace…
      </div>
    );
  }

  const baseSuffix = session.astroBase === '/' ? '' : session.astroBase.replace(/\/$/, '');
  const previewSrc = `/p/${session.id}${baseSuffix}/`;
  const spendPct = Math.min(100, (spend.spentTodayUsd / Math.max(0.01, spend.dailyCapUsd + spend.extraGrantedUsd)) * 100);

  return (
    <div className="flex h-screen flex-col bg-[#FAF9F7]">
      {/* Top Bar */}
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
              {session.status === 'published' ? 'Published archive' : `Read-only (${session.ownerName})`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!session.canEdit && session.status !== 'published' && (
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
            <span className="hidden sm:inline">Debug</span>
          </button>

          {session.canEdit && (
            <>
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
                          <div key={c.sha} className="flex items-center justify-between gap-2 px-2 py-2 text-xs">
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

      {/* Split Workspace */}
      <div className="flex flex-1 min-h-0">
        {/* Left Chat Sidebar */}
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
          className={`flex w-[400px] shrink-0 flex-col border-r border-[#E7E5E4] bg-white transition ${
            dragOver ? 'ring-2 ring-inset ring-amber-500 bg-amber-50/30' : ''
          }`}
        >
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {entries.length === 0 && !live.busy && (
              <div className="space-y-3 rounded-xl border border-stone-200 bg-[#FAF9F7] p-4 text-sm text-stone-600">
                <div>
                  <p className="font-medium text-stone-900">Ready when you are.</p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-500">
                    Ask Halley to update schedules, add pages, or upload photos — or click any text in the preview using <strong>Edit</strong> mode to tweak copy directly.
                  </p>
                </div>
                {session.canEdit && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
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
            )}

            {entries.map((entry) => {
              if (entry.role === 'user') {
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

            {live.activeTools.map((t) => (
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
                      {chips.length} {chips.length === 1 ? 'element' : 'elements'} selected
                    </span>
                    <button
                      type="button"
                      onClick={() => setChips([])}
                      className="font-medium text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-red-700"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <span
                        key={`${c.file}:${c.loc}`}
                        title={`${c.route} · <${c.tagName}>`}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-900"
                      >
                        <span className="truncate max-w-[180px]">
                          &lt;{c.tagName}&gt; {c.renderedText || c.file}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setChips((prev) => prev.filter((x) => !(x.file === c.file && x.loc === c.loc)))
                          }
                          className="hover:text-red-700"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
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

              <div className="rounded-xl border border-stone-300 bg-[#FAF9F7] p-2 focus-within:border-amber-600 focus-within:bg-white">
                <textarea
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
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#E7E5E4] bg-[#FAF9F7] px-4">
            <div className="relative flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const next = !showPageSwitcher;
                  setShowPageSwitcher(next);
                  setShowNewPageForm(false);
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
                      {!showNewPageForm ? (
                        <button
                          type="button"
                          onClick={() => setShowNewPageForm(true)}
                          className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50"
                        >
                          <FilePlus className="h-3.5 w-3.5" />
                          New page (or unlisted page)…
                        </button>
                      ) : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const slug = newPagePath.trim().replace(/^\/+/, '');
                            if (!slug) return;
                            const prompt = newPageUnlisted
                              ? `Please create a new unlisted page at \`/${slug}\` (\`src/pages/${slug}.astro\`) using the site's layout and \`url()\`. Keep it unlisted: do NOT link it in navigation menus, mark it \`indexable={false}\` (noindex), and exclude it from the sitemap if \`astro.config.mjs\` uses a sitemap filter.`
                              : `Please create a new page at \`/${slug}\` (\`src/pages/${slug}.astro\`) using the site's layout and \`url()\`.`;
                            dispatchClientMessage({
                              type: 'submit_input',
                              requestId: crypto.randomUUID(),
                              text: prompt,
                              contextChips: [],
                              attachments: [],
                              editorContext: {
                                currentRoute,
                                viewport,
                                mode,
                              },
                            });
                            setNewPagePath('');
                            setNewPageUnlisted(false);
                            setShowNewPageForm(false);
                            setShowPageSwitcher(false);
                          }}
                          className="space-y-2 p-1.5"
                        >
                          <input
                            type="text"
                            value={newPagePath}
                            onChange={(e) => setNewPagePath(e.target.value)}
                            placeholder="e.g., spring-retreat"
                            className="w-full rounded-lg border border-stone-300 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-amber-600"
                          />
                          <label className="flex items-center gap-2 text-[11px] text-stone-600">
                            <input
                              type="checkbox"
                              checked={newPageUnlisted}
                              onChange={(e) => setNewPageUnlisted(e.target.checked)}
                            />
                            Keep unlisted (hidden from menus &amp; search)
                          </label>
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setShowNewPageForm(false)}
                              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              className="rounded bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-800"
                            >
                              Create with Halley
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  )}
                </div>
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
                    { id: 'select', label: 'Select', Icon: MousePointer },
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

          <div className="flex flex-1 items-center justify-center overflow-auto p-4">
            <div
              className="h-full overflow-hidden rounded-xl border border-[#E7E5E4] bg-white shadow-sm transition-all duration-200"
              style={{
                width:
                  viewport === 'mobile' ? '390px' : viewport === 'tablet' ? '768px' : '100%',
              }}
            >
              <iframe
                ref={iframeRef}
                src={previewSrc}
                title="Live Astro Preview"
                className="h-full w-full border-0"
              />
            </div>
          </div>
        </main>
      </div>

      {showPublish && (
        <PublishModal
          session={session}
          publishProgress={publishProgress}
          onClose={() => setShowPublish(false)}
          onAskHalleyToFix={async (summary, logs) => {
            await api.fixWithPi(session.id, summary, logs);
          }}
          onStartNewEdit={onBack}
          onChangedFilesUpdated={loadSessionMeta}
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
