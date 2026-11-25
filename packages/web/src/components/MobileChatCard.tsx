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
  onSend: (whenBusy?: 'followUp', overrideText?: string) => void;
  onAbort: () => void;
  onOpenNewPage: () => void;
  onNavigateRouteAndClose: (route: string) => void;
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
  onShowHistory,
  onClose,
  notice,
  friendlyToolLabel,
  chipRowRef,
  composerRef,
  textareaRef,
}: Props) {
  const [rendered, setRendered] = useState(open);
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

  // Latest exchange: last user message + last final assistant reply after (or overall)
  let lastUser: TranscriptEntryDto | null = null;
  let lastAssistant: TranscriptEntryDto | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!lastAssistant && e.role === 'assistant' && !e.isIntermediate && e.text.trim()) {
      lastAssistant = e;
    }
    if (!lastUser && e.role === 'user') {
      lastUser = e;
    }
    if (lastUser && lastAssistant) break;
  }

  const isEmpty = !lastUser && !lastAssistant && !live.busy && !live.streamingText;
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
      aria-hidden={!open}
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
            {live.busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
          </div>
          <span className="text-xs font-semibold text-stone-900">Halley</span>
          {live.busy && (
            <span className="truncate text-[11px] text-amber-800">
              · {live.activeTools[0] ? friendlyToolLabel(live.activeTools[0].name) : 'Working…'}
            </span>
          )}
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
            onClick={onClose}
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

      {/* Compact Body: Starter pills when empty OR latest exchange */}
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
                onClick={() => onSend(undefined, `What's on this page (${currentRoute})?`)}
                className="rounded-full border border-stone-200 bg-[#FAF9F7] px-2.5 py-1 text-[11px] font-medium text-stone-700"
              >
                What&apos;s on this page?
              </button>
              <button
                type="button"
                onClick={() => onSend(undefined, 'Add a new upcoming event')}
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
            {lastUser && (
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-stone-900 px-3 py-1.5 text-xs text-white line-clamp-2 whitespace-pre-wrap">
                  {lastUser.pageRequest
                    ? `New page: ${lastUser.pageRequest.title} (${lastUser.pageRequest.route})`
                    : parseUserMessageDisplay(lastUser.text).body}
                </div>
              </div>
            )}

            {live.streamingText ? (
              <div className="text-xs leading-relaxed text-stone-800">
                <ChatMessageContent
                  text={live.streamingText}
                  onNavigateRoute={onNavigateRouteAndClose}
                  knownRoutes={knownRoutes}
                  astroBase={astroBase}
                />
                <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-amber-600 align-middle" />
              </div>
            ) : live.busy && live.activeTools.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200/70 bg-amber-50/50 px-2.5 py-1.5 text-xs text-amber-900">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
                <span className="truncate">{friendlyToolLabel(live.activeTools[0]!.name)}…</span>
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
          {spend.capped && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
              Daily AI budget reached. Ask an admin for extra allowance.
            </div>
          )}

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
                          {chips.findIndex((x) => elementKey(x) === elementKey(c)) + 1}
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
              {!input.trim() && !live.busy && !spend.capped && (
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
                      onClick={() => onSend(undefined, q.prompt)}
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
                  onSend(live.busy ? 'followUp' : undefined);
                }
              }}
              placeholder={
                live.busy
                  ? 'Queue next message…'
                  : chips.length > 0
                    ? 'What should Halley change?'
                    : `Ask Halley about ${currentRoute}…`
              }
              className="max-h-20 flex-1 resize-none bg-transparent py-1 text-sm text-stone-900 placeholder:text-stone-400 outline-none"
            />

            {live.busy ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={onAbort}
                  aria-label="Stop"
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-stone-300 bg-white px-2 text-xs font-medium text-stone-700"
                >
                  <Square className="h-3 w-3 fill-current" /> Stop
                </button>
                <button
                  type="button"
                  disabled={spend.capped}
                  onClick={() => onSend('followUp')}
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
                onClick={() => onSend()}
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
