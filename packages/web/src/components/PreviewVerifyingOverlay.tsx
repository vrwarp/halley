import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Props {
  reason?: string;
}

const VERIFY_PHASES = [
  'Checking templates, links & assets',
  'Running TypeScript & Astro checks',
  'Building production site & search index',
  'Verifying SEO & metadata',
];

export function PreviewVerifyingOverlay({ reason }: Props) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Advance cosmetic phase indicator smoothly over ~45s so the user sees live momentum
  const activePhase = Math.min(VERIFY_PHASES.length - 1, Math.floor(elapsedSec / 12));

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex items-center justify-center bg-[#FAF9F7]/92 px-6 backdrop-blur-[3px] transition-opacity duration-300"
    >
      <div className="w-full max-w-sm rounded-2xl border border-[#E7E5E4] bg-white/95 p-7 text-center shadow-sm">
        <div className="relative mx-auto flex h-14 w-14 items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-amber-500/10 animate-ping" style={{ animationDuration: '2.4s' }} />
          <div className="absolute inset-0 rounded-full border-2 border-stone-200" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-amber-600" />
          <ShieldCheck className="h-5 w-5 text-amber-700" />
        </div>

        <h2 className="mt-5 font-serif text-xl text-stone-900">
          {reason || 'Running pre-publish checks…'}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-stone-500">
          Live preview is briefly paused so the production build gets full memory. It will return automatically.
        </p>

        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
          <div
            className="h-full rounded-full bg-amber-600 transition-all duration-1000 ease-out"
            style={{ width: `${Math.min(92, 14 + elapsedSec * 2)}%` }}
          />
        </div>

        <ol className="mt-5 space-y-2 border-t border-stone-100 pt-4 text-left">
          {VERIFY_PHASES.map((label, idx) => {
            const done = idx < activePhase;
            const active = idx === activePhase;
            return (
              <li key={label} className="flex items-center gap-2.5 text-xs">
                {done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" />
                ) : (
                  <span className="mx-0.5 h-2.5 w-2.5 shrink-0 rounded-full border border-stone-300 bg-stone-50" />
                )}
                <span
                  className={
                    active
                      ? 'font-medium text-stone-900'
                      : done
                        ? 'text-stone-500'
                        : 'text-stone-400'
                  }
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 font-mono text-[11px] text-stone-400">
          Elapsed {elapsedSec}s
        </p>
      </div>
    </div>
  );
}
