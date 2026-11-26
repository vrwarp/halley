import {
  slugifyPagePath,
  validateNewPageRoute,
  type CreatePageResultDto,
  type EditorContext,
  type PageCreationOptionsDto,
  type StagedAttachment,
} from '@halley/shared';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  FilePlus,
  ImagePlus,
  Loader2,
  Pencil,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

interface Props {
  sessionId: string;
  initialTitle?: string;
  currentRoute: string;
  editorContext: EditorContext;
  isBusy: boolean;
  spendCapped: boolean;
  onClose: () => void;
  onCreated: (result: CreatePageResultDto) => void;
  onOpenExistingRoute: (route: string) => void;
}

export function NewPageModal({
  sessionId,
  initialTitle = '',
  currentRoute,
  editorContext,
  isBusy,
  spendCapped,
  onClose,
  onCreated,
  onOpenExistingRoute,
}: Props) {
  const [options, setOptions] = useState<PageCreationOptionsDto | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [title, setTitle] = useState(initialTitle);
  const [slug, setSlug] = useState(() => slugifyPagePath(initialTitle));
  const [slugEditedManually, setSlugEditedManually] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);

  const [section, setSection] = useState('/');
  const [purpose, setPurpose] = useState('');

  const [showMore, setShowMore] = useState(false);
  const [styleLikeRoute, setStyleLikeRoute] = useState<string>('');
  const [navMode, setNavMode] = useState<'none' | 'group'>('none');
  const [navGroup, setNavGroup] = useState('');
  const [unlisted, setUnlisted] = useState(false);
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [uploading, setUploading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const initialRouteRef = useRef(currentRoute);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    const initialRoute = initialRouteRef.current;
    setLoadingOptions(true);
    void api
      .getPageOptions(sessionId)
      .then((opts) => {
        if (!active) return;
        setOptions(opts);
        // Default section to the current route's section if it's a known section folder
        const currentSec =
          initialRoute !== '/' && opts.sections.some((s) => s.section === initialRoute)
            ? initialRoute
            : (() => {
                const idx = initialRoute.lastIndexOf('/');
                const parent = idx > 0 ? initialRoute.slice(0, idx) : '/';
                return opts.sections.some((s) => s.section === parent) ? parent : '/';
              })();
        setSection(currentSec);
        const secMeta = opts.sections.find((s) => s.section === currentSec);
        setStyleLikeRoute(secMeta?.defaultStyleRoute || '__blank__');
        if (opts.navGroups.length > 0) {
          setNavGroup(opts.navGroups[0]!);
        }
      })
      .catch(() => {
        // fallback gracefully
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  // Keep slug synced to title until user edits slug manually
  useEffect(() => {
    if (!slugEditedManually) {
      setSlug(slugifyPagePath(title));
    }
  }, [title, slugEditedManually]);

  // Update default style-like page when section changes
  const handleSectionChange = (nextSection: string) => {
    setSection(nextSection);
    const secMeta = options?.sections.find((s) => s.section === nextSection);
    setStyleLikeRoute(secMeta?.defaultStyleRoute || '__blank__');
  };

  // Unlisted forces navMode = 'none'
  const handleUnlistedChange = (next: boolean) => {
    setUnlisted(next);
    if (next) {
      setNavMode('none');
    }
  };

  const validation = useMemo(() => {
    if (!slug.trim()) {
      return {
        valid: false,
        route: section === '/' ? '/' : `${section}/`,
        normalizedSlug: '',
        error: undefined as string | undefined,
        collisionRoute: undefined as string | undefined,
      };
    }
    return validateNewPageRoute({
      section,
      slug,
      existingRoutes: (options?.routes ?? []).map((r) => r.route),
      dynamicPatterns: options?.dynamicPatterns ?? [],
      generatedRoutes: options?.generatedRoutes ?? [],
    });
  }, [section, slug, options]);

  const effectiveCapped = spendCapped || Boolean(options?.capped);

  const handlePhotoSelect = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    setUploading(true);
    setServerError(null);
    try {
      const staged = await api.uploadImage(sessionId, file);
      setAttachment(staged);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Failed to upload photo');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !validation.valid || submitting || uploading) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.createPage(sessionId, {
        title: title.trim(),
        slug: validation.normalizedSlug,
        section,
        purpose: purpose.trim() || undefined,
        styleLikeRoute: styleLikeRoute || undefined,
        nav:
          !unlisted && navMode === 'group' && navGroup
            ? { mode: 'group', group: navGroup }
            : { mode: 'none' },
        unlisted,
        attachment: attachment ?? undefined,
        editorContext,
      });
      onCreated(result);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Failed to create page');
    } finally {
      setSubmitting(false);
    }
  };

  const siblingRoutes = useMemo(
    () => (options?.routes ?? []).filter((r) => r.section === section),
    [options, section],
  );
  const otherRoutes = useMemo(
    () => (options?.routes ?? []).filter((r) => r.section !== section),
    [options, section],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 sm:p-4 backdrop-blur-[1px]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-page-modal-title"
        className="flex h-dvh w-full flex-col overflow-hidden bg-white sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-2xl sm:border sm:border-stone-200 sm:shadow-2xl"
      >
        <div
          className="flex shrink-0 items-center justify-between border-b border-stone-100 px-4 py-3 sm:px-5 sm:py-3.5"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-2">
            <FilePlus className="h-4 w-4 text-amber-700" />
            <h2 id="new-page-modal-title" className="text-sm font-semibold text-stone-900">
              Create a new page
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 sm:max-h-[82vh] sm:px-5">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1" htmlFor="new-page-title">
              Page title <span className="text-amber-700">*</span>
            </label>
            <input
              ref={titleInputRef}
              id="new-page-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Spring Retreat"
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-500/15"
            />
          </div>

          {/* Section + Live URL preview */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1" htmlFor="new-page-section">
                Section
              </label>
              <select
                id="new-page-section"
                value={section}
                onChange={(e) => handleSectionChange(e.target.value)}
                disabled={loadingOptions}
                className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-xs text-stone-800 outline-none focus:border-amber-600"
              >
                {(options?.sections ?? [{ section: '/', label: 'Top level (/)' }]).map((s) => (
                  <option key={s.section} value={s.section}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-stone-700">Page URL</span>
                <button
                  type="button"
                  onClick={() => setEditingSlug((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800 hover:underline"
                >
                  <Pencil className="h-2.5 w-2.5" />
                  {editingSlug ? 'Done' : 'Edit'}
                </button>
              </div>
              {editingSlug ? (
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => {
                    setSlugEditedManually(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="spring-retreat"
                  aria-label="URL slug"
                  className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 font-mono text-xs text-stone-900 outline-none focus:border-amber-600"
                />
              ) : (
                <div className="flex min-h-[34px] items-center rounded-lg border border-stone-200 bg-[#FAF9F7] px-2.5 py-1.5 font-mono text-xs text-stone-700 truncate">
                  {validation.route || '/'}
                </div>
              )}
            </div>
          </div>

          {validation.error && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <span>{validation.error}</span>
              {validation.collisionRoute && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenExistingRoute(validation.collisionRoute!);
                    onClose();
                  }}
                  className="shrink-0 rounded bg-white px-2 py-0.5 font-semibold text-red-900 underline decoration-red-300 hover:bg-red-100"
                >
                  Open existing page
                </button>
              )}
            </div>
          )}

          {/* Purpose */}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1" htmlFor="new-page-purpose">
              What&apos;s this page for? <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <textarea
              id="new-page-purpose"
              rows={3}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Dates, who it's for, key details, registration links, or anything you'd like Halley to include…"
              className="w-full resize-none rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs leading-relaxed text-stone-900 outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-500/15"
            />
          </div>

          {/* Progressive disclosure: More options */}
          <div className="rounded-xl border border-stone-200 bg-[#FAF9F7]">
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-stone-700 hover:text-stone-900"
            >
              <span className="inline-flex items-center gap-1.5">
                {showMore ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                More options
                <span className="font-normal text-stone-400">
                  (style, menu, unlisted, hero photo)
                </span>
              </span>
              {unlisted && (
                <span className="inline-flex items-center gap-1 rounded-full bg-stone-200/80 px-2 py-0.5 text-[10px] font-medium text-stone-700">
                  <EyeOff className="h-2.5 w-2.5" /> Unlisted
                </span>
              )}
            </button>

            {showMore && (
              <div className="border-t border-stone-200/80 px-3.5 py-3 space-y-3.5 bg-white rounded-b-xl">
                {/* Style like */}
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1" htmlFor="new-page-style">
                    Style like
                  </label>
                  <select
                    id="new-page-style"
                    value={styleLikeRoute}
                    onChange={(e) => setStyleLikeRoute(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-800 outline-none focus:border-amber-600"
                  >
                    {siblingRoutes.length > 0 && (
                      <optgroup label={`In ${section}`}>
                        {siblingRoutes.map((r) => (
                          <option key={r.route} value={r.route}>
                            {r.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {otherRoutes.length > 0 && (
                      <optgroup label="Other pages">
                        {otherRoutes.map((r) => (
                          <option key={r.route} value={r.route}>
                            {r.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="__blank__">Blank page (site layout only)</option>
                  </select>
                </div>

                {/* Unlisted toggle */}
                <label className="flex items-start gap-2.5 text-xs text-stone-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={unlisted}
                    onChange={(e) => handleUnlistedChange(e.target.checked)}
                    className="mt-0.5 rounded border-stone-300"
                  />
                  <span>
                    <span className="font-medium text-stone-900">Keep unlisted</span>
                    <span className="block text-[11px] text-stone-500">
                      Hidden from navigation menus, search engines, and sitemap. Only people with the link can visit it.
                    </span>
                  </span>
                </label>

                {/* Menu placement */}
                <div className={unlisted ? 'opacity-50' : ''}>
                  <span className="block text-xs font-medium text-stone-700 mb-1">Navigation menu</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Menu placement"
                      disabled={unlisted}
                      value={navMode}
                      onChange={(e) => setNavMode(e.target.value as 'none' | 'group')}
                      className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-800 outline-none focus:border-amber-600 disabled:bg-stone-100"
                    >
                      <option value="none">Don&apos;t add to menu</option>
                      {(options?.navGroups?.length ?? 0) > 0 && (
                        <option value="group">Add to menu under…</option>
                      )}
                    </select>
                    {!unlisted && navMode === 'group' && (options?.navGroups?.length ?? 0) > 0 && (
                      <select
                        aria-label="Navigation group"
                        value={navGroup}
                        onChange={(e) => setNavGroup(e.target.value)}
                        className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs text-stone-800 outline-none focus:border-amber-600"
                      >
                        {options!.navGroups.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* Hero photo */}
                <div>
                  <span className="block text-xs font-medium text-stone-700 mb-1">
                    Hero photo <span className="font-normal text-stone-400">(optional)</span>
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void handlePhotoSelect(e.target.files)}
                  />
                  {attachment ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-[#FAF9F7] px-2.5 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {attachment.thumbnailDataUrl && (
                          <img
                            src={attachment.thumbnailDataUrl}
                            alt=""
                            className="h-8 w-8 rounded object-cover shrink-0"
                          />
                        )}
                        <span className="truncate text-xs text-stone-700">{attachment.filename}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAttachment(null)}
                        className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
                        aria-label="Remove photo"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-[#FAF9F7] px-3 py-3 text-xs font-medium text-stone-600 hover:border-amber-500 hover:bg-amber-50/40 hover:text-amber-900"
                    >
                      {uploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ImagePlus className="h-3.5 w-3.5" />
                      )}
                      {uploading ? 'Uploading photo…' : 'Upload a hero photo'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {effectiveCapped && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
              <span>
                Daily AI budget reached — Halley will still create the starter page right away, and content can be added later or by asking an admin.
              </span>
            </div>
          )}

          {isBusy && !effectiveCapped && (
            <div className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-700">
              <Clock className="h-4 w-4 shrink-0 mt-0.5 text-stone-500" />
              <span>
                Halley is finishing another task — your starter page will open right away and content writing will be queued next.
              </span>
            </div>
          )}

          {serverError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {serverError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-stone-100 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || !validation.valid || submitting || uploading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create page
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
