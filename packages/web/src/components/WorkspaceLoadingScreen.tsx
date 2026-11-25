import type { BootProgressDto, BootStage, EditorSessionDto } from '@halley/shared';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Props {
  session: EditorSessionDto;
  bootProgress: BootProgressDto | null;
  onRetry: () => void;
  onBack: () => void;
}

interface StepDef {
  id: string;
  label: string;
  stages: BootStage[];
}

const COLD_STEPS: StepDef[] = [
  {
    id: 'repo',
    label: 'Sync latest website repository',
    stages: ['queued', 'syncing_repo'],
  },
  {
    id: 'deps',
    label: 'Prepare workspace files & packages',
    stages: ['checking_image', 'pulling_image', 'creating_container', 'starting_container', 'cloning_repo', 'installing_deps'],
  },
  {
    id: 'preview',
    label: 'Start live Astro preview & AI assistant',
    stages: ['starting_preview', 'starting_ai'],
  },
];

const WARM_STEPS: StepDef[] = [
  {
    id: 'reserve',
    label: 'Reserve pre-warmed workspace',
    stages: ['queued'],
  },
  {
    id: 'claim',
    label: 'Sync latest changes & connect workspace',
    stages: ['claiming_warm', 'syncing_repo'],
  },
];

function getStepIndex(steps: StepDef[], stage: BootStage | undefined): number {
  if (!stage) return 0;
  if (stage === 'ready') return steps.length;
  const idx = steps.findIndex((s) => s.stages.includes(stage));
  return idx === -1 ? 0 : idx;
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function WorkspaceLoadingScreen({ session, bootProgress, onRetry, onBack }: Props) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [showMobileDetails, setShowMobileDetails] = useState(false);

  const isError = session.status === 'error' || bootProgress?.stage === 'error';
  const isWarmFastPath =
    Boolean(bootProgress?.warmHit) &&
    (bootProgress?.stage === 'claiming_warm' || bootProgress?.stage === 'syncing_repo');

  useEffect(() => {
    if (isError) return;
    const originMs = bootProgress?.startedAt
      ? new Date(bootProgress.startedAt).getTime()
      : Date.now();
    const update = () => {
      const diff = Math.max(0, Math.floor((Date.now() - originMs) / 1000));
      setElapsedSec(diff);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [bootProgress?.startedAt, isError]);

  const steps = isWarmFastPath ? WARM_STEPS : COLD_STEPS;
  const currentStepIdx = isWarmFastPath
    ? 1
    : getStepIndex(steps, bootProgress?.stage);
  const clampedStepIdx = Math.min(steps.length - 1, Math.max(0, currentStepIdx));
  const currentStepLabel = steps[clampedStepIdx]?.label ?? 'Starting workspace';

  const isCrashLoop = Boolean(bootProgress?.crashLoop);
  const isOom = Boolean(bootProgress?.oom);

  const heading = isError
    ? isOom
      ? 'Workspace ran out of memory'
      : isCrashLoop
        ? 'Workspace paused after repeated crashes'
        : 'Couldn’t start your workspace'
    : isWarmFastPath
      ? 'Connecting to ready workspace…'
      : session.status === 'sleeping'
        ? 'Waking up your workspace…'
        : 'Setting up your workspace…';

  const mobileHeading = isError
    ? isOom
      ? 'Out of memory'
      : isCrashLoop
        ? 'Workspace paused'
        : 'Couldn’t start'
    : isWarmFastPath
      ? 'Connecting…'
      : session.status === 'sleeping'
        ? 'Waking workspace…'
        : 'Starting workspace…';

  const activeMessage =
    bootProgress?.message ||
    (session.status === 'sleeping'
      ? 'Resuming your saved draft container…'
      : 'Starting isolated workspace container…');

  const errorSubtitle = isOom
    ? 'The workspace container hit its memory limit and auto-restart was paused. Your saved edits are safe.'
    : isCrashLoop
      ? 'Auto-restart was paused to prevent a crash loop. Your saved edits are safe.'
      : 'Something went wrong while booting this edit environment.';

  const errorDetail = bootProgress?.detail || session.publishError;
  const pct = Math.min(95, Math.round(((clampedStepIdx + 0.4) / steps.length) * 100));

  return (
    <div className="flex flex-1 items-center justify-center bg-[#FAF9F7] px-4 py-6 sm:px-6 sm:py-12">
      <div className="w-full max-w-md rounded-2xl border border-[#E7E5E4] bg-white p-5 shadow-xs sm:p-8">
        <div className="flex flex-col items-center text-center">
          {isError ? (
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-200 bg-red-50 text-red-600 sm:h-12 sm:w-12">
              <AlertCircle className="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
          ) : (
            <div className="relative flex h-11 w-11 items-center justify-center sm:h-12 sm:w-12">
              <div className="absolute inset-0 rounded-full border-2 border-stone-200" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-amber-600" />
              <Sparkles className="h-4 w-4 text-amber-700" />
            </div>
          )}

          <h1 className="mt-4 font-serif text-xl text-stone-900 sm:mt-5 sm:text-2xl">
            <span className="sm:hidden">{mobileHeading}</span>
            <span className="hidden sm:inline">{heading}</span>
          </h1>
          <p className="mt-1 hidden text-sm text-stone-600 sm:block">
            {isError ? errorSubtitle : activeMessage}
          </p>

          {!isError && (
            <div className="mt-1.5 inline-flex items-center gap-2 text-xs text-stone-400 sm:mt-2">
              <span className="sm:hidden text-stone-600 font-medium">
                Step {clampedStepIdx + 1}/{steps.length} · {currentStepLabel}
              </span>
              <span className="font-mono">{formatElapsed(elapsedSec)}</span>
              {bootProgress?.warmHit && (
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="hidden text-amber-700 font-medium sm:inline">Hot standby</span>
                </>
              )}
            </div>
          )}
        </div>

        {isError ? (
          <div className="mt-4 space-y-3 sm:mt-6 sm:space-y-4">
            <p className="text-center text-xs text-stone-600 sm:hidden">
              {isOom || isCrashLoop ? 'Your saved edits are safe.' : 'Something went wrong while starting.'}
            </p>
            {errorDetail && (
              <>
                <div className="sm:hidden text-center">
                  <button
                    type="button"
                    onClick={() => setShowMobileDetails((v) => !v)}
                    className="text-xs font-medium text-stone-500 underline"
                  >
                    {showMobileDetails ? 'Hide details' : 'Show details'}
                  </button>
                </div>
                <pre
                  className={`max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-red-200 bg-red-50/70 p-3 font-mono text-[11px] text-red-800 ${
                    showMobileDetails ? 'block' : 'hidden sm:block'
                  }`}
                >
                  {errorDetail}
                </pre>
              </>
            )}
            <div className="flex items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onBack}
                className="min-h-[40px] rounded-xl border border-stone-200 bg-white px-4 py-2 text-xs font-medium text-stone-700 hover:bg-stone-50"
              >
                Back to edits
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-xs font-semibold text-white hover:bg-stone-800"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {isCrashLoop ? 'Restart workspace' : 'Try again'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-stone-100 sm:hidden">
              <div
                className="h-full rounded-full bg-amber-600 transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-3 text-center sm:hidden">
              <button
                type="button"
                onClick={() => setShowMobileDetails((v) => !v)}
                className="text-[11px] font-medium text-stone-500 underline"
              >
                {showMobileDetails ? 'Hide steps' : 'Details'}
              </button>
            </div>

            <ol
              className={`mt-4 space-y-2.5 border-t border-stone-100 pt-4 sm:mt-7 sm:space-y-3 sm:pt-6 ${
                showMobileDetails ? 'block' : 'hidden sm:block'
              }`}
            >
              {steps.map((step, idx) => {
                const isDone = idx < currentStepIdx;
                const isActive = idx === currentStepIdx;
                return (
                  <li key={step.id} className="flex items-start gap-3 text-left">
                    <div className="mt-0.5 shrink-0">
                      {isDone ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : isActive ? (
                        <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                      ) : (
                        <div className="m-0.5 h-3 w-3 rounded-full border border-stone-300 bg-stone-50" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-xs ${
                          isActive
                            ? 'font-semibold text-stone-900'
                            : isDone
                              ? 'text-stone-500'
                              : 'text-stone-400'
                        }`}
                      >
                        {step.label}
                      </p>
                      {isActive && bootProgress?.message && bootProgress.message !== step.label && (
                        <p className="mt-0.5 text-[11px] text-amber-800/80">{bootProgress.message}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            <p className="mt-6 hidden text-center text-[11px] text-stone-400 sm:block">
              Your edits run in a private sandbox and won&apos;t affect the live site until you publish.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
