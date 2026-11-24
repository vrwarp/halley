import { Check, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

export interface BubblePos {
  x: number;
  y: number;
}

interface Props {
  pos: BubblePos;
  onChangePos: (pos: BubblePos) => void;
  onTap: () => void;
  busy: boolean;
  chipCount: number;
  needsAttention: boolean;
  entryPulse: boolean;
  completionToast: string | null;
  onTapToast: () => void;
}

export const BUBBLE_SIZE = 54;
const MARGIN = 14;
const DRAG_THRESHOLD_PX = 8;

export function clampBubblePos(x: number, y: number): BubblePos {
  const w = typeof window !== 'undefined' ? window.innerWidth : 390;
  const h = typeof window !== 'undefined' ? window.innerHeight : 844;
  return {
    x: Math.max(MARGIN, Math.min(w - BUBBLE_SIZE - MARGIN, x)),
    y: Math.max(56, Math.min(h - BUBBLE_SIZE - MARGIN, y)),
  };
}

export function defaultBubblePos(): BubblePos {
  const w = typeof window !== 'undefined' ? window.innerWidth : 390;
  const h = typeof window !== 'undefined' ? window.innerHeight : 844;
  return clampBubblePos(w - BUBBLE_SIZE - 16, h - BUBBLE_SIZE - 20);
}

export function MobileChatBubble({
  pos,
  onChangePos,
  onTap,
  busy,
  chipCount,
  needsAttention,
  entryPulse,
  completionToast,
  onTapToast,
}: Props) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const onResize = () => {
      onChangePos(clampBubblePos(pos.x, pos.y));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pos.x, pos.y, onChangePos]);

  const isOnRightHalf =
    typeof window !== 'undefined' ? pos.x + BUBBLE_SIZE / 2 >= window.innerWidth / 2 : true;

  return (
    <div
      className="fixed z-40 select-none"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        touchAction: 'none',
      }}
    >
      {completionToast && (
        <button
          type="button"
          onClick={onTapToast}
          style={
            isOnRightHalf
              ? { right: `${BUBBLE_SIZE + 10}px`, top: '50%', transform: 'translateY(-50%)' }
              : { left: `${BUBBLE_SIZE + 10}px`, top: '50%', transform: 'translateY(-50%)' }
          }
          className="absolute flex max-w-[220px] items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-2 text-left text-xs font-medium text-stone-800 shadow-lg"
        >
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="truncate">{completionToast}</span>
        </button>
      )}

      <button
        type="button"
        aria-label="Open Halley chat"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            origX: pos.x,
            origY: pos.y,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || d.pointerId !== e.pointerId) return;
          const dx = e.clientX - d.startX;
          const dy = e.clientY - d.startY;
          if (!d.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            d.moved = true;
          }
          if (d.moved) {
            onChangePos(clampBubblePos(d.origX + dx, d.origY + dy));
          }
        }}
        onPointerUp={(e) => {
          const d = dragRef.current;
          dragRef.current = null;
          if (!d || d.pointerId !== e.pointerId) return;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          if (!d.moved) {
            onTap();
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        className={`relative flex h-[54px] w-[54px] items-center justify-center rounded-full bg-stone-900 text-amber-400 shadow-lg ring-1 ring-black/10 active:scale-95 transition-transform ${
          entryPulse ? 'halley-bubble-pulse' : ''
        }`}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
        ) : completionToast ? (
          <Check className="h-5 w-5 text-emerald-400" />
        ) : (
          <Sparkles className="h-5 w-5" />
        )}

        {needsAttention && (
          <span
            aria-label="Action needed"
            className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-500"
          />
        )}

        {chipCount > 0 && !needsAttention && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-amber-600 px-1 text-[10px] font-bold text-white">
            {chipCount}
          </span>
        )}
      </button>
    </div>
  );
}
