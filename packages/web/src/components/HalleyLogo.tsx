import { useId } from 'react';

interface HalleyLogoProps {
  className?: string;
}

/**
 * Halley's Comet / Spark brand mark — matches the PWA app icon & favicon.
 */
export function HalleyLogo({ className = 'h-8 w-8' }: HalleyLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bgId = `halley-bg-${uid}`;
  const tailMainId = `halley-tail-main-${uid}`;
  const tailSubId = `halley-tail-sub-${uid}`;
  const starId = `halley-star-${uid}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={bgId} cx="66%" cy="34%" r="65%">
          <stop offset="0%" stopColor="#332A22" />
          <stop offset="55%" stopColor="#1C1917" />
          <stop offset="100%" stopColor="#141210" />
        </radialGradient>
        <linearGradient id={tailMainId} x1="336" y1="176" x2="108" y2="404" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FDE68A" stopOpacity="0.95" />
          <stop offset="35%" stopColor="#F59E0B" stopOpacity="0.82" />
          <stop offset="75%" stopColor="#D97706" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#B45309" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={tailSubId} x1="312" y1="158" x2="136" y2="338" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FCD34D" stopOpacity="0.65" />
          <stop offset="60%" stopColor="#D97706" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#B45309" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={starId} x1="256" y1="96" x2="392" y2="256" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FEF3C7" />
          <stop offset="48%" stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>

      <rect width="512" height="512" rx="112" fill={`url(#${bgId})`} />
      <path
        d="M316 158 C246 196 184 246 132 316 C182 272 246 226 326 184 Z"
        fill={`url(#${tailSubId})`}
      />
      <path
        d="M326 172 C244 228 170 302 100 398 C188 330 264 264 342 192 Z"
        fill={`url(#${tailMainId})`}
      />
      <path
        d="M336 92 C343 145 367 169 420 176 C367 183 343 207 336 260 C329 207 305 183 252 176 C305 169 329 145 336 92 Z"
        fill={`url(#${starId})`}
      />
      <circle cx="336" cy="176" r="18" fill="#FFFBEB" fillOpacity="0.92" />
      <path
        d="M196 154 C198.5 169 205 175.5 220 178 C205 180.5 198.5 187 196 202 C193.5 187 187 180.5 172 178 C187 175.5 193.5 169 196 154 Z"
        fill="#FDE68A"
        fillOpacity="0.8"
      />
    </svg>
  );
}
