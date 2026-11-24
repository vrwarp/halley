import type { PreviewRect } from '@halley/shared';

/**
 * "Fly to chat" affordance for the preview's "Ask Halley…" button.
 *
 * A ghost starts as an outline over the selected element (in parent-page
 * coordinates), then morphs into the chip's shape while gliding to the chip's
 * spot in the composer. Once it lands, the real chip pops in and the composer
 * pulses, so the user can see where their selection went and start typing.
 *
 * With prefers-reduced-motion, the flight is skipped and only the land pop and
 * composer pulse run.
 */
export function flyToChip(opts: {
  from: PreviewRect | null;
  chipEl: HTMLElement;
  composerEl: HTMLElement | null;
  label: string;
  onLanded?: () => void;
}) {
  const { from, chipEl, composerEl, label, onLanded } = opts;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const land = () => {
    chipEl.style.opacity = '';
    chipEl.animate(
      [
        { transform: 'scale(0.85)', boxShadow: '0 0 0 0 rgba(217,119,6,0.45)' },
        { transform: 'scale(1.08)', boxShadow: '0 0 0 6px rgba(217,119,6,0.18)', offset: 0.45 },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(217,119,6,0)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    composerEl?.animate(
      [
        { boxShadow: '0 0 0 0 rgba(217,119,6,0)' },
        { boxShadow: '0 0 0 4px rgba(217,119,6,0.22)', offset: 0.3 },
        { boxShadow: '0 0 0 0 rgba(217,119,6,0)' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
    onLanded?.();
  };

  const to = chipEl.getBoundingClientRect();
  if (reduceMotion || !from || to.width === 0) {
    land();
    return;
  }

  chipEl.style.opacity = '0';
  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'pointer-events:none',
    'overflow:hidden',
    'display:flex',
    'align-items:center',
    'padding:0 10px',
    'border:1.5px solid #d97706',
    'color:#78350f',
    'font-size:11px',
    'font-weight:500',
    'white-space:nowrap',
    'box-shadow:0 12px 32px rgba(0,0,0,0.18)',
  ].join(';');
  const text = document.createElement('span');
  text.textContent = label;
  text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;opacity:0';
  ghost.appendChild(text);
  document.body.appendChild(ghost);

  const duration = 520;
  const easing = 'cubic-bezier(.3,.7,.15,1)';
  // A slight upward arc reads as "picked up and dropped" instead of a flat slide.
  const midTop = Math.min(from.top, to.top) - 24;
  const midLeft = (from.left + to.left) / 2;
  const midW = (from.width + to.width) / 2;
  const midH = (from.height + to.height) / 2;
  const anim = ghost.animate(
    [
      {
        left: `${from.left}px`,
        top: `${from.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        borderRadius: '4px',
        background: 'rgba(217,119,6,0.10)',
        opacity: 1,
      },
      {
        left: `${midLeft}px`,
        top: `${midTop}px`,
        width: `${midW}px`,
        height: `${midH}px`,
        borderRadius: '14px',
        background: 'rgba(255,251,235,0.95)',
        opacity: 1,
        offset: 0.55,
      },
      {
        left: `${to.left}px`,
        top: `${to.top}px`,
        width: `${to.width}px`,
        height: `${to.height}px`,
        borderRadius: '999px',
        background: 'rgb(255,251,235)',
        opacity: 1,
      },
    ],
    { duration, easing, fill: 'forwards' },
  );
  text.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration, fill: 'forwards' });

  anim.onfinish = () => {
    land();
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).onfinish = () =>
      ghost.remove();
  };
  anim.oncancel = () => {
    ghost.remove();
    chipEl.style.opacity = '';
  };
}
