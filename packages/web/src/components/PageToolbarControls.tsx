import {
  slugifyPagePath,
  validateNewPageRoute,
  type PageCreationOptionsDto,
  type SiteRouteEntryDto,
} from '@halley/shared';
import { Eye, EyeOff, Loader2, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { reportIgnored } from '../lib/retry.js';

interface Props {
  sessionId: string;
  currentRoute: string;
  currentRouteEntry?: SiteRouteEntryDto;
  canEdit: boolean;
  viewport?: 'desktop' | 'tablet' | 'mobile';
  inlineMobile?: boolean;
  onVisibilityChanged: (route: string, unlisted: boolean) => Promise<void>;
  onRenamed: (newRoute: string) => Promise<void>;
}

export function PageToolbarControls({
  sessionId,
  currentRoute,
  currentRouteEntry,
  canEdit,
  viewport,
  inlineMobile = false,
  onVisibilityChanged,
  onRenamed,
}: Props) {
  const [openPopover, setOpenPopover] = useState<'visibility' | 'rename' | null>(null);
  const [options, setOptions] = useState<PageCreationOptionsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [toSection, setToSection] = useState('/');
  const [toSlug, setToSlug] = useState('');

  // Close popovers whenever the active route changes
  useEffect(() => {
    setOpenPopover(null);
    setError(null);
  }, [currentRoute]);

  const isUnlisted = Boolean(currentRouteEntry?.unlisted);

  const openRenamePopover = async () => {
    if (openPopover === 'rename') {
      setOpenPopover(null);
      return;
    }
    setError(null);
    const clean = currentRoute.replace(/\/+$/, '');
    const lastSlash = clean.lastIndexOf('/');
    const curSec = lastSlash > 0 ? clean.slice(0, lastSlash) : '/';
    const curLeaf = clean.slice(lastSlash + 1);
    setToSection(curSec);
    setToSlug(curLeaf);
    setOpenPopover('rename');
    try {
      const opts = await api.getPageOptions(sessionId);
      setOptions(opts);
    } catch (err) {
      // The rename popover still works with free-form section/slug input.
      reportIgnored(err, 'page options unavailable for rename popover');
    }
  };

  const validation = useMemo(() => {
    if (openPopover !== 'rename') return null;
    if (!toSlug.trim()) {
      return {
        valid: false,
        route: toSection === '/' ? '/' : `${toSection}/`,
        normalizedSlug: '',
        error: 'Enter a URL slug.',
      };
    }
    const existingRoutes = (options?.routes ?? [])
      .map((r) => r.route)
      .filter((r) => r !== currentRoute);
    const res = validateNewPageRoute({
      section: toSection,
      slug: toSlug,
      existingRoutes,
      dynamicPatterns: options?.dynamicPatterns ?? [],
      generatedRoutes: options?.generatedRoutes ?? [],
    });
    if (res.valid && res.route === currentRoute) {
      return {
        ...res,
        valid: false,
        error: 'Enter a different path than the current URL.',
      };
    }
    return res;
  }, [openPopover, toSection, toSlug, options, currentRoute]);

  if (!canEdit || currentRoute === '/') {
    return null;
  }

  const handleToggleVisibility = async () => {
    setBusy(true);
    setError(null);
    try {
      const nextUnlisted = !isUnlisted;
      await api.setPageVisibility(sessionId, currentRoute, nextUnlisted, viewport);
      setOpenPopover(null);
      await onVisibilityChanged(currentRoute, nextUnlisted);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update page visibility');
    } finally {
      setBusy(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validation?.valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.renamePage(sessionId, currentRoute, toSection, validation.normalizedSlug);
      setOpenPopover(null);
      await onRenamed(res.toRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change page URL');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={inlineMobile ? 'space-y-2.5' : 'relative flex items-center gap-1'}>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* 1. Change hidden / unlisted status */}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            setOpenPopover((v) => (v === 'visibility' ? null : 'visibility'));
          }}
          title={isUnlisted ? 'Page is unlisted — click to change visibility' : 'Page is public — click to hide/unlist'}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
            isUnlisted
              ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
              : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:text-stone-900'
          } ${inlineMobile ? 'min-h-[38px]' : 'px-2 py-1 text-[11px]'}`}
        >
          {isUnlisted ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          <span className={inlineMobile ? '' : 'hidden md:inline'}>
            {isUnlisted ? 'Unlisted' : 'Public'}
          </span>
        </button>

        {/* 2. Change page URL / path */}
        <button
          type="button"
          disabled={busy}
          onClick={() => void openRenamePopover()}
          title="Change page URL"
          aria-label="Change page URL"
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
            openPopover === 'rename'
              ? 'border-amber-400 bg-amber-50 text-amber-900'
              : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:text-stone-900'
          } ${inlineMobile ? 'min-h-[38px]' : 'px-2 py-1 text-[11px]'}`}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className={inlineMobile ? '' : 'hidden lg:inline'}>Rename URL</span>
        </button>
      </div>

      {openPopover === 'visibility' && (
        <div
          className={
            inlineMobile
              ? 'rounded-xl border border-stone-200 bg-white p-3 space-y-2.5'
              : 'absolute left-0 top-9 z-40 w-72 rounded-xl border border-stone-200 bg-white p-3 shadow-lg space-y-2.5'
          }
        >
          <div>
            <p className="text-xs font-semibold text-stone-900">
              {isUnlisted ? 'This page is currently unlisted' : 'This page is currently public'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
              {isUnlisted
                ? 'Visitors can only reach it with the direct link, and search engines will not index it.'
                : 'Hiding this page marks it noindex so search engines skip it and keeps it out of menus and the sitemap.'}
            </p>
          </div>
          {error && <p className="text-[11px] text-red-700">{error}</p>}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpenPopover(null)}
              className="rounded-lg px-2.5 py-1.5 text-xs text-stone-500 hover:bg-stone-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleToggleVisibility()}
              className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {isUnlisted ? 'Make public' : 'Make unlisted'}
            </button>
          </div>
        </div>
      )}

      {openPopover === 'rename' && (
        <form
          onSubmit={handleRenameSubmit}
          className={
            inlineMobile
              ? 'rounded-xl border border-stone-200 bg-white p-3 space-y-2.5'
              : 'absolute left-0 top-9 z-40 w-80 rounded-xl border border-stone-200 bg-white p-3 shadow-lg space-y-2.5'
          }
        >
          <p className="text-xs font-semibold text-stone-900">Change page URL</p>
          <div className="space-y-2">
            <div>
              <label className="block text-[11px] font-medium text-stone-600 mb-0.5" htmlFor="rename-section">
                Section
              </label>
              <select
                id="rename-section"
                value={toSection}
                onChange={(e) => setToSection(e.target.value)}
                className="w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-800 outline-none focus:border-amber-600"
              >
                {(options?.sections ?? [{ section: '/', label: 'Top level (/)' }]).map((s) => (
                  <option key={s.section} value={s.section}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-stone-600 mb-0.5" htmlFor="rename-slug">
                URL slug
              </label>
              <input
                id="rename-slug"
                type="text"
                value={toSlug}
                onChange={(e) => setToSlug(e.target.value)}
                onBlur={() => setToSlug((v) => slugifyPagePath(v))}
                placeholder="spring-retreat"
                className="w-full rounded-lg border border-stone-300 px-2.5 py-1.5 font-mono text-xs text-stone-900 outline-none focus:border-amber-600"
              />
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-[#FAF9F7] px-2.5 py-1.5 font-mono text-[11px] text-stone-600 truncate">
            {currentRoute} → <span className="font-semibold text-stone-900">{validation?.route || '/'}</span>
          </div>

          {(validation?.error || error) && (
            <p className="text-[11px] text-red-700">{error || validation?.error}</p>
          )}

          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpenPopover(null)}
              className="rounded-lg px-2.5 py-1.5 text-xs text-stone-500 hover:bg-stone-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!validation?.valid || busy}
              className="inline-flex items-center gap-1 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Update URL
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
