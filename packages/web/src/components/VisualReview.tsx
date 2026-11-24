import type { ChangeCardDto, VisualDiffHighlightDto, VisualDiffPageDto } from '@halley/shared';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  Loader2,
  Monitor,
  RotateCcw,
  Smartphone,
  ZoomIn,
} from 'lucide-react';
import { useState } from 'react';
import { ImageLightbox } from './ImageLightbox.js';

interface Props {
  cards: ChangeCardDto[];
  pages: VisualDiffPageDto[];
  isUndoMode: boolean;
  defaultShowTechnical?: boolean;
  excludedPaths: Record<string, boolean>;
  onToggleInclude?: (filePath: string, included: boolean) => void;
  onRevertFile?: (filePath: string) => void;
  onRequestScreenshots?: () => void;
  loadingScreenshots?: boolean;
  screenshotViewport?: 'mobile' | 'desktop';
  onSelectScreenshotViewport?: (vp: 'mobile' | 'desktop') => void;
  screenshotsEnabled?: boolean;
}

export function VisualReview({
  cards,
  pages,
  isUndoMode,
  defaultShowTechnical = false,
  excludedPaths,
  onToggleInclude,
  onRevertFile,
  onRequestScreenshots,
  loadingScreenshots = false,
  screenshotViewport = 'desktop',
  onSelectScreenshotViewport,
  screenshotsEnabled = false,
}: Props) {
  const [expandedDiff, setExpandedDiff] = useState<Record<string, boolean>>({});
  const [showAllCode, setShowAllCode] = useState(defaultShowTechnical);
  const [lightbox, setLightbox] = useState<{
    src: string;
    alt: string;
    title: string;
    highlights?: VisualDiffHighlightDto[];
  } | null>(null);

  const showViewportToggle = Boolean(onSelectScreenshotViewport) && (screenshotsEnabled || pages.length > 0 || loadingScreenshots);

  return (
    <div className="space-y-5">
      {/* Layer 1: Live vs Draft visual page comparison with dual-color highlights (Q4, Q15) */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Live vs Draft
            </h4>
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-800">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> Your draft
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-teal-800">
              <span className="h-2 w-2 rounded-full bg-teal-500" /> Merged from Live
            </span>
          </div>

          {showViewportToggle ? (
            <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5 text-xs">
              {(
                [
                  { id: 'mobile', label: 'Mobile', Icon: Smartphone },
                  { id: 'desktop', label: 'Desktop', Icon: Monitor },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelectScreenshotViewport?.(id)}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    screenshotViewport === id
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
          ) : (
            pages.length === 0 &&
            onRequestScreenshots && (
              <button
                type="button"
                disabled={loadingScreenshots}
                onClick={onRequestScreenshots}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                <Eye className="h-3.5 w-3.5" />
                {loadingScreenshots ? 'Capturing screenshots…' : 'Show visual screenshots'}
              </button>
            )
          )}
        </div>

        {loadingScreenshots && pages.length === 0 && (
          <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-4 text-xs text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
            <span>
              Capturing {screenshotViewport === 'mobile' ? 'mobile' : 'desktop'} preview screenshots…
            </span>
          </div>
        )}

        {pages.length > 0 && (
          <div className="mt-2.5 space-y-3">
            {pages.map((p) => {
              const shot = p.shots?.[screenshotViewport];
              const liveUrl =
                shot?.liveScreenshotDataUrl ??
                (screenshotViewport === 'mobile'
                  ? p.mobileLiveScreenshotDataUrl
                  : p.liveScreenshotDataUrl);
              const draftUrl =
                shot?.draftScreenshotDataUrl ??
                (screenshotViewport === 'mobile'
                  ? p.mobileDraftScreenshotDataUrl
                  : p.draftScreenshotDataUrl);
              const highlights = shot?.highlights ?? p.highlights ?? [];
              const hasLive = Boolean(liveUrl);

              return (
                <div key={`${p.route}-${screenshotViewport}`} className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="font-semibold text-stone-800 truncate">
                      {p.title} ({p.route})
                    </span>
                    <span className="text-[11px] text-stone-500">
                      {hasLive ? `Live as of ${p.liveTimestamp}` : 'Draft preview'}
                    </span>
                  </div>
                  <div className={`grid gap-3 ${hasLive ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                    {hasLive && liveUrl && (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-[11px] font-medium text-stone-500">Live</p>
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-stone-400">
                            <ZoomIn className="h-3 w-3" /> Tap to zoom
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setLightbox({
                              src: liveUrl,
                              alt: `Live ${p.route}`,
                              title: `Live · ${p.route} (${screenshotViewport})`,
                            })
                          }
                          className="block w-full overflow-hidden rounded-lg border border-stone-200 bg-white text-left focus:outline-none focus:ring-2 focus:ring-amber-500"
                        >
                          <img
                            src={liveUrl}
                            alt={`Live ${p.route}`}
                            className="block w-full"
                          />
                        </button>
                      </div>
                    )}
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-[11px] font-medium text-stone-500">Draft</p>
                        {draftUrl && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-stone-400">
                            <ZoomIn className="h-3 w-3" /> Tap to zoom
                          </span>
                        )}
                      </div>
                      {draftUrl ? (
                        <button
                          type="button"
                          onClick={() =>
                            setLightbox({
                              src: draftUrl,
                              alt: `Draft ${p.route}`,
                              title: `Draft · ${p.route} (${screenshotViewport})`,
                              highlights,
                            })
                          }
                          className="relative block w-full overflow-hidden rounded-lg border border-stone-200 bg-white text-left focus:outline-none focus:ring-2 focus:ring-amber-500"
                        >
                          <img
                            src={draftUrl}
                            alt={`Draft ${p.route}`}
                            className="w-full block"
                          />
                          {highlights.map((h, idx) => (
                            <div
                              key={idx}
                              title={h.warning || h.file}
                              style={{
                                left: `${h.x}%`,
                                top: `${h.y}%`,
                                width: `${h.width}%`,
                                height: `${h.height}%`,
                              }}
                              className={`pointer-events-none absolute rounded border-2 ${
                                h.kind === 'merged_from_live'
                                  ? 'border-teal-500 bg-teal-500/15'
                                  : 'border-amber-500 bg-amber-500/15'
                              }`}
                            />
                          ))}
                        </button>
                      ) : (
                        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-stone-300 bg-white text-[11px] text-stone-400">
                          Draft screenshot unavailable
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Layer 2: Plain-language Change Cards */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            What changed ({cards.length})
          </h4>
          <button
            type="button"
            onClick={() => setShowAllCode((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-900"
          >
            <Code2 className="h-3 w-3" />
            {showAllCode ? 'Hide technical details' : 'Show technical details'}
          </button>
        </div>

        {cards.length === 0 ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-6 text-center text-xs text-stone-500">
            No unpublished changes yet.
          </div>
        ) : (
          <div className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
            {cards.map((card) => {
              const isOpen = showAllCode || Boolean(expandedDiff[card.path]);
              const included = !excludedPaths[card.path];
              return (
                <div key={card.id} className={`p-3.5 text-xs ${!included ? 'opacity-50' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      {/* Include/exclude checkboxes ONLY during Undo a publication (Q16) */}
                      {isUndoMode && onToggleInclude && (
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(e) => onToggleInclude(card.path, e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-stone-300"
                          title="Include in undo"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-stone-900">{card.title}</span>
                          {card.conflictBadge === 'auto_resolved' && (
                            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-800 border border-teal-200">
                              Combined automatically
                            </span>
                          )}
                          {card.conflictBadge === 'needs_review' && (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                              Please double-check
                            </span>
                          )}
                          {card.conflictBadge === 'chosen' && (
                            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-700">
                              Your choice
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-stone-500">
                          {card.summary} · {card.attribution}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedDiff((p) => ({ ...p, [card.path]: !p[card.path] }))
                        }
                        className="inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-[11px] text-stone-500 hover:text-stone-900"
                      >
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        Code
                      </button>
                      {!isUndoMode && onRevertFile && (
                        <button
                          type="button"
                          onClick={() => onRevertFile(card.path)}
                          title="Discard changes to this file"
                          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-stone-500 hover:bg-stone-100 hover:text-red-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Undo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Upstream overwrite safety-net warning */}
                  {card.overwriteWarning && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <span>{card.overwriteWarning}</span>
                    </div>
                  )}

                  {/* Word-level inline diff */}
                  {card.wordDiff && card.wordDiff.length > 0 && (
                    <div className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-800 break-words">
                      {card.wordDiff.map((tok, i) =>
                        tok.type === 'del' ? (
                          <span
                            key={i}
                            className="mx-0.5 rounded bg-red-100 px-1 text-red-800 line-through"
                          >
                            {tok.value}
                          </span>
                        ) : tok.type === 'add' ? (
                          <span
                            key={i}
                            className="mx-0.5 rounded bg-emerald-100 px-1 font-medium text-emerald-900"
                          >
                            {tok.value}
                          </span>
                        ) : (
                          <span key={i}> {tok.value} </span>
                        ),
                      )}
                    </div>
                  )}

                  {/* Sermon / content JSON field table */}
                  {card.jsonFields && card.jsonFields.length > 0 && (
                    <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200">
                      <table className="w-full min-w-[320px] text-left text-[11px]">
                        <thead className="bg-stone-50 text-stone-500">
                          <tr>
                            <th className="px-2.5 py-1.5 font-medium">Field</th>
                            <th className="px-2.5 py-1.5 font-medium">Live</th>
                            <th className="px-2.5 py-1.5 font-medium">Draft</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100">
                          {card.jsonFields.map((row) => (
                            <tr key={row.field}>
                              <td className="px-2.5 py-1.5 font-medium text-stone-700">
                                {row.field}
                              </td>
                              <td className="px-2.5 py-1.5 text-stone-500 line-through">
                                {row.before || '—'}
                              </td>
                              <td className="px-2.5 py-1.5 font-medium text-emerald-800">
                                {row.after || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Layer 3: Collapsed technical code diff */}
                  {isOpen && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-stone-950 p-3 font-mono text-[11px] leading-relaxed text-stone-200">
                      {card.diff}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          title={lightbox.title}
          highlights={lightbox.highlights}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
