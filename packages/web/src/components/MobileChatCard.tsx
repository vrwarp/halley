import type {
  ElementContext,
  LiveRunStateDto,
  SpendStatusDto,
  StagedAttachment,
  TranscriptEntryDto,
} from '@halley/shared';
import { elementKey, friendlyElementKind } from '@halley/shared';
import {
  AlertTriangle,
  FilePlus,
  History,
  ImagePlus,
  Loader2,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { ChatMessageContent, parseUserMessageDisplay } from './ChatMessageContent.js';
import type { BubblePos } from './MobileChatBubble.js';
import { NewPageCard } from './NewPageCard.js';

export interface MobileNotice {
  text: string;
  actionLabel: string;
  onAction: () => void;
  tone?: 'amber' | 'teal';
}

interface Props {
  open: boolean;
  bubblePos: BubblePos;
  canEdit: boolean;
  currentRoute: string;
  astroBase: string;
  knownRoutes: Set<string>;
  persona: 'non-technical' | 'developer';
  spend: SpendStatusDto;
  entries: TranscriptEntryDto[];
  live: LiveRunStateDto;
  input: string;
  onChangeInput: (val: string) => void;
  chips: ElementContext[];
  onRemoveChip: (key: string) => void;
  onClearChips: () => void;
  onFocusChip: (c: ElementContext) => void;
  attachments: StagedAttachment[];
  onRemoveAttachment: (stagedId: string) => void;
  uploading: boolean;
  onTriggerPhotoUpload: () => void;
  /** May resolve to false when the send failed (the draft is kept and an error shown by the parent). */
  onSend: (whenBusy?: 'steer' | 'followUp', overrideText?: string) => void | Promise<boolean>;
  onAbort: () => void;
  onOpenNewPage: () => void;
  onNavigateRouteAndClose: (route: string) => void;
  onRetryPageRequest?: (pageRequestId: string) => Promise<void>;
  onDeletePageRequest?: (route: string) => Promise<void>;
  liveUnlistedByRoute?: Map<string, boolean>;
  pageRequestsMap?: Record<string, import('@halley/shared').PageRequestMetadata>;
  onShowHistory: () => void;
  onClose: () => void;
  notice: MobileNotice | null;
  friendlyToolLabel: (name?: string) => string;
  chipRowRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const chipKeyOf = (c: ElementContext) => `${elementKey(c)}|${c.selectedText ?? ''}`;
const chipLabelOf = (c: ElementContext, persona: 'non-technical' | 'developer') => {
  if (c.selectedText) return `“${c.selectedText}”`;
  const kind = persona === 'developer' ? `<${c.tagName}>` : friendlyElementKind(c.tagName);
  return c.renderedText ? `${kind}: ${c.renderedText}` : kind;
};

export function MobileChatCard({
  open,
  bubblePos,
  canEdit,
  currentRoute,
  astroBase,
  knownRoutes,
  persona,
  spend,
  entries,
  live,
  input,
  onChangeInput,
  chips,
  onRemoveChip,
  onClearChips,
  onFocusChip,
  attachments,
  onRemoveAttachment,
  uploading,
  onTriggerPhotoUpload,
  onSend,
  onAbort,
  onOpenNewPage,
  onNavigateRouteAndClose,
  onRetryPageRequest,
  onDeletePageRequest,
  liveUnlistedByRoute,
  pageRequestsMap,
  onShowHistory,
  onClose,
  notice,
  friendlyToolLabel,
  chipRowRef,
  composerRef,
  textareaRef,
}: Props) {
  const [rendered, setRendered] = useState(open);
  const [pendingSend, setPendingSend] = useState<{
    text: string;
    baselineEntryCount: number;
  } | null>(null);
  const [vvMetrics, setVvMetrics] = useState(() => ({
    height: typeof window !== 'undefined' ? window.visualViewport?.height ?? window.innerHeight : 800,
    offsetBottom: 0,
  }));

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    const timer = setTimeout(() => setRendered(false), 170);
    return () => clearTimeout(timer);
  }, [open]);

  // Clear optimistic pending state once the server starts the turn, fails, or already replied
  useEffect(() => {
    if (!pendingSend) return;
    const hasNewAssistant = entries
      .slice(pendingSend.baselineEntryCount)
      .some((e) => e.role === 'assistant' && !e.isIntermediate && e.text.trim().length > 0);
    if (live.busy || live.runFailure || hasNewAssistant) {
      setPendingSend(null);
    }
  }, [pendingSend, live.busy, live.runFailure, entries]);

  // Auto-grow composer textarea as the user types multiple lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
  }, [input, open, rendered, textareaRef]);

  useEffect(() => {
    const update = () => {
      const vv = window.visualViewport;
      if (!vv) {
        setVvMetrics({ height: window.innerHeight, offsetBottom: 0 });
        return;
      }
      const offsetBottom = Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height)));
      setVvMetrics({ height: Math.round(vv.height), offsetBottom });
    };
    update();
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (!rendered) return null;

  const submitPrompt = (whenBusy?: 'steer' | 'followUp', overrideText?: string) => {
    const raw = (overrideText ?? input).trim();
    if (!raw && attachments.length === 0 && chips.length === 0) return;
    const displayText =
      raw ||
      (attachments.length > 0 && chips.length === 0
        ? 'Use attached photo'
        : chips.length === 1
          ? 'Update selected section'
          : 'Update selected sections');
    if (!live.busy) {
      setPendingSend({ text: displayText, baselineEntryCount: entries.length });
    }
    void Promise.resolve(onSend(whenBusy, overrideText)).then((ok) => {
      if (ok === false) setPendingSend(null);
    });
  };

  // Scope the compact view strictly to the latest turn so older replies never flicker back while working
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const lastUser = lastUserIdx >= 0 ? entries[lastUserIdx]! : null;
  const turnEntries = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
  let lastAssistant: TranscriptEntryDto | null = null;
  let completedToolsInTurn = 0;
  let turnPageRequest = lastUser?.pageRequest ?? null;
  for (let i = 0; i < turnEntries.length; i++) {
    const e = turnEntries[i]!;
    if (e.role === 'tool') {
      completedToolsInTurn += 1;
      if (e.pageRequest) turnPageRequest = e.pageRequest;
    }
    if (e.role === 'assistant' && !e.isIntermediate && e.text.trim()) {
      lastAssistant = e;
    }
  }
  const liveTurnPageRequest = turnPageRequest
    ? (pageRequestsMap?.[turnPageRequest.pageRequestId] ?? turnPageRequest)
    : null;

  const totalBudget = spend.dailyCapUsd + spend.extraGrantedUsd;
  const spendPct = totalBudget > 0 ? Math.round((spend.spentTodayUsd / totalBudget) * 100) : 0;

  const isWorking = live.busy || Boolean(pendingSend);
  const activeTool = live.activeTools[0];
  const stepCount = pendingSend
    ? 0
    : completedToolsInTurn + (live.activeTools.length > 0 ? 1 : 0);
  const displayedUserText = pendingSend
    ? pendingSend.text
    : lastUser
      ? lastUser.pageRequest
        ? `New page: ${lastUser.pageRequest.title} (${lastUser.pageRequest.route})`
        : parseUserMessageDisplay(lastUser.text).body
      : null;

  const isEmpty = !displayedUserText && !lastAssistant && !liveTurnPageRequest && !isWorking;
  const keyboardOpen = vvMetrics.offsetBottom > 80;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 390;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 844;
  const anchorTop = !keyboardOpen && bubblePos.y < winH * 0.35;
  const targetMaxH = Math.max(210, Math.min(Math.round(winH * 0.43), vvMetrics.height - 72));
  const originXPct = Math.max(8, Math.min(92, Math.round(((bubblePos.x + 27) / Math.max(1, winW)) * 100)));

  return (
    <div
      role="dialog"
      aria-label="Halley chat"
      inert={!open || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: 'min(92vw, 360px)',
        maxHeight: `${targetMaxH}px`,
        left: '50%',
        transformOrigin: `${originXPct}% ${anchorTop ? '0%' : '100%'}`,
        ...(anchorTop
          ? { top: '56px' }
          : { bottom: `${vvMetrics.offsetBottom + 12}px` }),
      }}
      className={`fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl ring-1 ring-black/5 ${
        open ? 'halley-card-enter' : 'halley-card-exit pointer-events-none'
      }`}
    >
      {/* Slim Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-100 bg-[#FAF9F7] px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-900 text-amber-400">
            <Sparkles className="h-3 w-3" />
          </div>
          <span className="text-xs font-semibold text-stone-900">Halley</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onShowHistory}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-stone-600 hover:bg-stone-200/60 hover:text-stone-900"
          >
            <History className="h-3 w-3" />
            Show history
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.blur();
              onClose();
            }}
            aria-label="Close chat card"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200/60 hover:text-stone-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* One-line blocking notice */}
      {notice && (
        <div
          className={`flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] ${
            notice.tone === 'teal'
              ? 'border-teal-200 bg-teal-50 text-teal-900'
              : 'border-amber-200 bg-amber-50 text-amber-950'
          }`}
        >
          <span className="flex items-center gap-1.5 truncate">
            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-700" />
            <span className="truncate">{notice.text}</span>
          </span>
          <button
            type="button"
            onClick={notice.onAction}
            className="shrink-0 rounded-md bg-stone-900 px-2 py-0.5 text-[11px] font-semibold text-white"
          >
            {notice.actionLabel}
          </button>
        </div>
      )}

      {/* Compact Body: Starter pills when empty OR latest exchange / calm working state */}
      <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2">
        {isEmpty ? (
          canEdit ? (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={onOpenNewPage}
                className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50/80 px-2.5 py-1 text-[11px] font-medium text-amber-900"
              >
                <FilePlus className="h-3 w-3" />
                Add a new page
              </button>
              <button
                type="button"
                onClick={() => submitPrompt(undefined, `What's on this page (${currentRoute})?`)}
                className="rounded-full border border-stone-200 bg-[#FAF9F7] px-2.5 py-1 text-[11px] font-medium text-stone-700"
              >
                What&apos;s on this page?
              </button>
              <button
                type="button"
                onClick={() => submitPrompt(undefined, 'Add a new upcoming event')}
                className="rounded-full border border-stone-200 bg-[#FAF9F7] px-2.5 py-1 text-[11px] font-medium text-stone-700"
              >
                Add upcoming event
              </button>
            </div>
          ) : (
            <p className="text-xs text-stone-500">No messages in this archive.</p>
          )
        ) : (
          <>
            {displayedUserText && (
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-stone-900 px-3 py-1.5 text-xs leading-relaxed text-white">
                  <p className="line-clamp-3 whitespace-pre-wrap break-words">
                    {displayedUserText}
                  </p>
                </div>
              </div>
            )}

            {liveTurnPageRequest && onRetryPageRequest && onDeletePageRequest && (
              <NewPageCard
                pageRequest={liveTurnPageRequest}
                liveUnlisted={liveUnlistedByRoute?.get(liveTurnPageRequest.route)}
                persona={persona}
                canEdit={canEdit}
                spendCapped={spend.capped}
                onNavigateRoute={onNavigateRouteAndClose}
                onRetry={onRetryPageRequest}
                onDelete={onDeletePageRequest}
              />
            )}

            {isWorking ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200/80 bg-amber-50/60 px-3 py-2 text-xs text-amber-950">
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
                  <span className="truncate font-medium">
                    {activeTool
                      ? `${friendlyToolLabel(activeTool.name)}…`
                      : pendingSend
                        ? 'Sending…'
                        : 'Thinking…'}
                  </span>
                </div>
                {stepCount > 0 && (
                  <span className="shrink-0 rounded-full bg-white/90 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-900 border border-amber-200/80">
                    {stepCount} {stepCount === 1 ? 'step' : 'steps'}
                  </span>
                )}
              </div>
            ) : lastAssistant ? (
              <div className="text-xs leading-relaxed text-stone-800">
                <ChatMessageContent
                  text={lastAssistant.text}
                  onNavigateRoute={onNavigateRouteAndClose}
                  knownRoutes={knownRoutes}
                  astroBase={astroBase}
                />
              </div>
            ) : null}

            {live.runFailure && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">
                <strong>Error:</strong> {live.runFailure.detail || live.runFailure.reason}
              </div>
            )}
          </>
        )}
      </div>

      {/* Compact Composer */}
      {canEdit && (
        <div className="shrink-0 border-t border-stone-100 bg-white px-2.5 py-2 space-y-1.5">
          {spend.capped ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
              Daily AI budget reached. Ask an admin for extra allowance.
            </div>
          ) : spendPct >= 75 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              {spendPct}% of today&apos;s AI editing budget used (${spend.spentTodayUsd.toFixed(2)} / ${totalBudget.toFixed(2)}).
            </div>
          ) : null}

          {chips.length > 0 && (
            <div className="space-y-1">
              <div ref={chipRowRef} className="flex items-center gap-1 overflow-x-auto pb-0.5">
                {chips.map((c) => {
                  const key = chipKeyOf(c);
                  return (
                    <span
                      key={key}
                      data-chip-key={key}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 py-0.5 pl-1 pr-1.5 text-[11px] font-medium text-amber-900"
                    >
                      <button
                        type="button"
                        onClick={() => onFocusChip(c)}
                        className="inline-flex items-center gap-1"
                      >
                        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px] font-bold text-white">
                          {[...new Set(chips.map((x) => elementKey(x)))].indexOf(elementKey(c)) + 1}
                        </span>
                        <span className="max-w-[130px] truncate">{chipLabelOf(c, persona)}</span>
                      </button>
                      <button
                        type="button"
                        aria-label="Remove selection"
                        onClick={() => onRemoveChip(key)}
                        className="text-amber-700 hover:text-red-700"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
                {chips.length > 1 && (
                  <button
                    type="button"
                    onClick={onClearChips}
                    className="shrink-0 text-[10px] font-medium text-stone-500 underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              {!input.trim() && !isWorking && !spend.capped && (
                <div className="flex items-center gap-1 overflow-x-auto">
                  {[
                    {
                      label: 'Rewrite clearer',
                      prompt:
                        chips.length === 1
                          ? 'Rewrite this so it reads more clearly and warmly while keeping all factual details.'
                          : 'Rewrite these selected sections so they read more clearly and warmly while keeping all factual details.',
                    },
                    {
                      label: 'Remove this',
                      prompt:
                        chips.length === 1
                          ? 'Remove this from the page cleanly.'
                          : 'Remove these selected items from the page cleanly.',
                    },
                  ].map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => submitPrompt(undefined, q.prompt)}
                      className="shrink-0 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {attachments.map((a) => (
                <div key={a.stagedId} className="relative shrink-0">
                  {a.thumbnailDataUrl ? (
                    <img
                      src={a.thumbnailDataUrl}
                      alt={a.filename}
                      className="h-9 w-9 rounded-lg border border-stone-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-14 items-center justify-center rounded-lg border border-stone-200 bg-stone-50 px-1 text-[10px] truncate">
                      {a.filename}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => onRemoveAttachment(a.stagedId)}
                    className="absolute -right-1 -top-1 rounded-full bg-stone-900 p-0.5 text-white"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            ref={composerRef}
            className="flex items-end gap-1.5 rounded-xl border border-stone-300 bg-[#FAF9F7] px-2 py-1.5 focus-within:border-amber-600 focus-within:bg-white"
          >
            <button
              type="button"
              disabled={uploading}
              onClick={onTriggerPhotoUpload}
              aria-label="Attach photo"
              title="Attach photo"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200/60 hover:text-stone-900"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="h-4 w-4" />
              )}
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => onChangeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitPrompt(isWorking ? 'followUp' : undefined);
                }
              }}
              placeholder={
                isWorking
                  ? 'Queue next message…'
                  : chips.length > 0
                    ? 'What should Halley change?'
                    : `Ask Halley about ${currentRoute}…`
              }
              className="max-h-[120px] flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm leading-5 text-stone-900 placeholder:text-stone-400 outline-none"
            />

            {isWorking ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setPendingSend(null);
                    onAbort();
                  }}
                  aria-label="Stop"
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-stone-300 bg-white px-2 text-xs font-medium text-stone-700"
                >
                  <Square className="h-3 w-3 fill-current" /> Stop
                </button>
                <button
                  type="button"
                  disabled={spend.capped}
                  onClick={() => submitPrompt('followUp')}
                  aria-label="Send queued message"
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-stone-900 px-2.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  <Send className="h-3 w-3" /> Send
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={spend.capped}
                onClick={() => submitPrompt()}
                aria-label="Send message"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-stone-900 px-2.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                <Send className="h-3 w-3" /> Send
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
