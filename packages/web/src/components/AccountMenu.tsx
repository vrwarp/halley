import type { SpendStatusDto, UserDto } from '@halley/shared';
import { ChevronDown, Download, LogOut, PlusSquare, Settings, Share, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePwaInstall } from '../pwa/usePwaInstall.js';

interface AccountMenuProps {
  user: UserDto;
  spend: SpendStatusDto;
  onOpenAdmin: () => void;
  onOpenOptimize?: () => void;
  onLogout: () => void;
}

export function getUserInitials(name: string, email: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  const fallback = (parts[0] || email.split('@')[0] || 'U').trim();
  return fallback.slice(0, 2).toUpperCase();
}

/**
 * Unified 44px avatar/account menu popover for Halley's Dashboard header.
 * Keeps the sticky header calm by housing rare/admin/account actions cleanly
 * on a single vertical text axis with ≥44px touch targets.
 */
export function AccountMenu({
  user,
  spend,
  onOpenAdmin,
  onOpenOptimize,
  onLogout,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [showIosTip, setShowIosTip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isStandalone, canPromptInstall, isIosSafari, triggerInstall } = usePwaInstall();

  const showInstallItem = !isStandalone && (canPromptInstall || isIosSafari);
  const initials = getUserInitials(user.name, user.email);
  const totalBudget = spend.dailyCapUsd + spend.extraGrantedUsd;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowIosTip(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setShowIosTip(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleInstallClick = () => {
    if (canPromptInstall) {
      setOpen(false);
      void triggerInstall();
    } else if (isIosSafari) {
      setShowIosTip((prev) => !prev);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          if (open) setShowIosTip(false);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border pl-1.5 pr-2.5 text-[13px] font-medium text-stone-800 transition sm:gap-2 sm:pr-3 ${
          open
            ? 'border-stone-300 bg-[#FAF9F7]'
            : 'border-[#E7E5E4] bg-white hover:border-stone-300 hover:bg-[#FAF9F7]/60'
        }`}
      >
        <span
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-full text-[11px] font-bold tracking-wide ${
            user.isAdmin ? 'bg-[#1C1917] text-amber-200' : 'bg-stone-600 text-[#FAF9F7]'
          }`}
        >
          {initials}
        </span>
        <span className="hidden max-w-[140px] truncate sm:inline">{user.name}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-stone-500 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account and workspace options"
          className="absolute right-0 z-30 mt-2 w-[264px] overflow-hidden rounded-2xl border border-[#E7E5E4] bg-white shadow-xl"
        >
          {/* Identity header */}
          <div className="px-4 pt-3.5 pb-3">
            <p className="truncate text-sm font-semibold text-stone-900">{user.name}</p>
            <p className="mt-0.5 truncate text-xs text-stone-500">{user.email}</p>
          </div>

          {/* Full-width telemetry band aligned to the single left text axis */}
          <div className="flex items-center justify-between border-y border-[#F0EEEB] bg-[#FAF9F7] px-4 py-2.5 text-xs text-stone-600 tabular-nums">
            <span>Daily AI budget</span>
            <strong className="font-semibold text-stone-900">
              ${spend.spentTodayUsd.toFixed(2)} / ${totalBudget.toFixed(0)}
            </strong>
          </div>

          {/* Admin group */}
          {user.isAdmin && (
            <>
              <div className="p-2">
                <p className="px-2 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-stone-400">
                  Admin
                </p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenAdmin();
                  }}
                  className="flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[13px] font-medium text-stone-800 transition hover:bg-stone-100/80"
                >
                  <Settings className="h-4 w-4 shrink-0 text-stone-500" />
                  <span>Admin &amp; team</span>
                </button>
                {onOpenOptimize && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onOpenOptimize();
                    }}
                    className="flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[13px] font-medium text-stone-800 transition hover:bg-stone-100/80"
                  >
                    <Zap className="h-4 w-4 shrink-0 text-amber-700" />
                    <span>Optimize Astro</span>
                  </button>
                )}
              </div>
              <div className="h-px bg-[#F0EEEB]" />
            </>
          )}

          {/* PWA install fallback */}
          {showInstallItem && (
            <>
              <div className="p-2">
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleInstallClick}
                  className="flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[13px] font-medium text-stone-800 transition hover:bg-stone-100/80"
                >
                  <Download className="h-4 w-4 shrink-0 text-stone-500" />
                  <span>Install Halley app</span>
                </button>
                {showIosTip && (
                  <ol className="mx-2 mt-1 mb-1.5 space-y-1.5 rounded-xl bg-[#FAF9F7] p-3 text-xs text-stone-600">
                    <li className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-200/80 text-[10px] font-semibold text-stone-700">
                        1
                      </span>
                      <span className="flex items-center gap-1">
                        Tap <Share className="inline h-3.5 w-3.5 text-stone-800" /> <strong>Share</strong>
                      </span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-200/80 text-[10px] font-semibold text-stone-700">
                        2
                      </span>
                      <span className="flex items-center gap-1">
                        Choose <PlusSquare className="inline h-3.5 w-3.5 text-stone-800" />{' '}
                        <strong>Add to Home Screen</strong>
                      </span>
                    </li>
                  </ol>
                )}
              </div>
              <div className="h-px bg-[#F0EEEB]" />
            </>
          )}

          {/* Sign out */}
          <div className="p-2">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[13px] font-medium text-red-800 transition hover:bg-red-50/70"
            >
              <LogOut className="h-4 w-4 shrink-0 text-red-700" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
