export const EARLY_OBSERVER_SCRIPT = `
(() => {
  if (window.__HALLEY_SOURCE_MAP__) return;
  const st = document.createElement('style');
  st.textContent = 'astro-dev-toolbar{display:none!important;}';
  (document.head || document.documentElement).appendChild(st);
  const map = new WeakMap();
  window.__HALLEY_SOURCE_MAP__ = map;
  const capture = (el) => {
    if (!el || el.nodeType !== 1) return;
    const file = el.getAttribute('data-astro-source-file');
    const loc = el.getAttribute('data-astro-source-loc');
    if (file && loc) map.set(el, { file, loc });
  };
  const scan = (root) => {
    if (!root || root.nodeType !== 1) return;
    capture(root);
    const all = root.querySelectorAll('[data-astro-source-file][data-astro-source-loc]');
    for (let i = 0; i < all.length; i++) capture(all[i]);
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) scan(n);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => scan(document.documentElement), { once: true });
})();
`;

export function buildClientBridgeScript(previewBase: string): string {
  const baseLiteral = JSON.stringify(previewBase === '/' ? '' : previewBase.replace(/\/$/, ''));
  // NOTE: the injected script below avoids backticks and "${" so it can live cleanly
  // inside this template literal without escaping issues.
  return `
(() => {
  const BASE = ${baseLiteral};
  const sourceMap = window.__HALLEY_SOURCE_MAP__ || new WeakMap();

  let mode = 'browse';
  let readOnly = false;
  let persona = 'non-technical';
  let touchLayout = false;
  let workspaceLocked = false;

  // Current selection
  let selEl = null;
  let selMeta = null;
  let selInfo = null;
  let selToken = 0;
  let selSlot = 'above-left'; // 'above-left' | 'above-right' | 'below-left'
  let lastNotifiedSelectionActive = false;

  // Inline editing & stationary format-morph state
  let activeEl = null;
  let activeMeta = null;
  let originalHtml = '';
  let expectedHash = '';
  let expectedFileHash = ''; // sha256 of the file at inspect time (lets the server relocate safely)
  let expectedContentHash = '';
  let cachedRoutes = null;
  let cachedImages = null;
  let savedRange = null;
  let hasHighlightedText = false;
  let manualFormatOpen = false;
  let suppressAutoFormat = false;

  // Popover state
  let linkPopMode = 'inline'; // 'inline' | 'element'
  let imgPopMode = 'replace'; // 'replace' | 'add-block'
  let moreSubmode = 'root'; // 'root' | 'add'
  let openPopover = null; // 'link' | 'image' | 'alt' | 'style' | 'more' | null
  let popoverTriggerEl = null;

  // Client DOM undo/redo stack paired 1:1 with server EditUndoStack
  const clientUndoStack = [];
  const clientRedoStack = [];

  // Elements attached to chat (numbered markers, Edit mode only) + chip-hover highlight
  let pins = [];
  let flashKey = null;
  const knownEls = new Map();

  const SVG = {
    parentUp: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    backLeft: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    chevronRight: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    typeAa: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>',
    sliders: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="10" y1="7" y2="7"/><line x1="14" x2="20" y1="7" y2="7"/><circle cx="12" cy="7" r="2"/><line x1="4" x2="8" y1="17" y2="17"/><line x1="12" x2="20" y1="17" y2="17"/><circle cx="10" cy="17" r="2"/></svg>',
    more: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/></svg>',
    plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    sparkle: '<svg width="13" height="13" viewBox="0 0 24 24" fill="#FBBF24"><path d="M12 2l2.1 6.4L20.5 10.5l-6.4 2.1L12 19l-2.1-6.4L3.5 10.5l6.4-2.1L12 2z"/></svg>',
    close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    bold: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/></svg>',
    italic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/></svg>',
    underline: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/></svg>',
    strike: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/></svg>',
    code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    upload: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    moveUp: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
    moveDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
  };

  const cursorStyle = document.createElement('style');
  cursorStyle.id = '__halley-edit-cursor';
  (document.head || document.documentElement).appendChild(cursorStyle);
  function syncCursorStyle() {
    if (mode === 'edit' && !readOnly) {
      cursorStyle.textContent = 'body { cursor: pointer; } [contenteditable="true"], [contenteditable="true"] * { cursor: text !important; }';
    } else {
      cursorStyle.textContent = '';
    }
  }

  const host = document.createElement('div');
  host.id = '__halley-bridge-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = [
    '<style>',
    '* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }',
    '.sel-box { position: fixed; pointer-events: none; display: none; border: 2px solid #71717A; border-radius: 6px; box-shadow: 0 0 0 1px rgba(11,13,16,0.68), inset 0 0 0 1px rgba(11,13,16,0.20); }',
    '.sel-box.editable { border-color: #F59E0B; }',
    '.flash-box { position: fixed; pointer-events: none; display: none; border: 2px solid #F59E0B; background: rgba(245,158,11,0.12); border-radius: 6px; }',
    '.pin-box { position: fixed; pointer-events: none; border: 1px solid rgba(245,158,11,0.50); border-radius: 4px; }',
    '.pin-badge { position: absolute; top: -9px; left: -9px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #D97706; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #fff; }',
    '.toolbar { position: fixed; display: none; pointer-events: auto; align-items: center; gap: 2px; height: 36px; padding: 4px; background-color: rgb(24,24,27); opacity: 1; border: 1px solid rgba(255,255,255,0.16); border-radius: 9px; box-shadow: 0 0 0 1px rgba(11,13,16,0.78), 0 10px 24px -4px rgba(11,13,16,0.22), 0 3px 8px -2px rgba(11,13,16,0.12); color: #F4F4F5; max-width: calc(100vw - 16px); user-select: none; }',
    '.toolbar.open { display: inline-flex; }',
    '.bar-row { display: inline-flex; align-items: center; gap: 2px; width: 100%; }',
    '.sep { width: 1px; height: 16px; background: rgba(255,255,255,0.13); margin: 0 3px; flex-shrink: 0; }',
    '.label { display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 7px; height: 28px; font-size: 12px; font-weight: 600; color: #FAFAF9; letter-spacing: -0.01em; white-space: nowrap; }',
    '.ctx-pill { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px; background: #27272A; border: 1px solid rgba(255,255,255,0.12); color: #D4D4D8; }',
    '.ctx-pill.warn { background: rgba(245,158,11,0.16); color: #FCD34D; border-color: rgba(245,158,11,0.34); }',
    '.btn { height: 28px; border: 1px solid transparent; background: transparent; color: #E4E4E7; font-size: 12px; font-weight: 500; padding: 0 8px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap; flex-shrink: 0; }',
    '.btn:hover:not(:disabled) { background: #27272A; color: #FFFFFF; }',
    '.btn:disabled { opacity: 0.35; cursor: default; }',
    '.btn.icon-only { width: 28px; padding: 0; }',
    '.btn.muted { color: #A1A1AA; }',
    '.btn.muted:hover:not(:disabled) { color: #F4F4F5; }',
    '.btn.open, .btn.active { background: #2E2E34; border-color: rgba(255,255,255,0.18); color: #FFFFFF; }',
    '.btn.ask { border-color: rgba(245,158,11,0.38); background: rgba(245,158,11,0.13); color: #FEF3C7; font-weight: 600; padding: 0 9px; }',
    '.btn.ask:hover { background: rgba(245,158,11,0.22); color: #FFFFFF; }',
    '.btn.light-primary { background: #F4F4F5; border-color: #F4F4F5; color: #18181B; font-weight: 700; padding: 0 12px; }',
    '.btn.light-primary:hover { background: #FFFFFF; color: #09090B; }',
    '.btn.close { width: 28px; padding: 0; color: #A1A1AA; }',
    '.btn.close:hover { background: #27272A; color: #FFFFFF; }',
    '.hidden { display: none !important; }',
    '.parent-txt { display: none; }',
    '.toolbar:not(.touch) { flex-wrap: nowrap; white-space: nowrap; }',
    '.toolbar:not(.touch) .parent-btn { width: 28px; padding: 0; }',
    '.toolbar:not(.touch) .touch-top-row, .toolbar:not(.touch) .touch-bot-row, .toolbar:not(.touch) .fmt-wrap, .toolbar:not(.touch) .desktop-close-slot { display: inline-flex; align-items: center; gap: 2px; width: auto; }',
    '.block-tools, .fmt-tools { display: inline-flex; align-items: center; gap: 2px; }',
    '.toolbar.format-view .id-wrap, .toolbar.format-view .block-tools { display: none !important; }',
    '.toolbar:not(.format-view) .fmt-wrap { display: none !important; }',
    '.toolbar:not(.touch) .touch-only { display: none !important; }',

    /* Mobile touchLayout (390px) bottom sheet & keyboard bar */
    '.toolbar.touch { left: 0 !important; right: 0; top: auto !important; width: 100%; max-width: 100%; height: auto; border-radius: 16px 16px 0 0; border-left: none; border-right: none; border-bottom: none; padding: 10px 10px calc(12px + env(safe-area-inset-bottom, 0px)); flex-direction: column; align-items: stretch; gap: 8px; box-shadow: 0 -10px 28px rgba(0,0,0,0.35); }',
    '.toolbar.touch .sep { display: none; }',
    '.toolbar.touch .btn { min-height: 44px; height: 44px; padding: 0 9px; font-size: 12px; font-weight: 600; border-radius: 9px; border-color: rgba(255,255,255,0.14); background: #27272A; color: #FAFAF9; }',
    '.toolbar.touch .btn.icon-only { width: 40px; padding: 0; }',
    '.toolbar.touch .btn.close { width: 44px; padding: 0; }',
    '.toolbar.touch .btn.open, .toolbar.touch .btn.active { background: #2E2E34; border-color: rgba(255,255,255,0.28); color: #FFFFFF; }',
    '.toolbar.touch .btn.light-primary { background: #F4F4F5; border-color: #F4F4F5; color: #18181B; font-weight: 700; padding: 0 13px; }',
    '.toolbar.touch .btn.ask { background: rgba(245,158,11,0.14); border-color: rgba(245,158,11,0.40); color: #FEF3C7; padding: 0 9px; }',
    '.toolbar.touch .parent-txt { display: inline; }',
    '.toolbar.touch .desktop-only { display: none !important; }',
    '.toolbar.touch .block-tools { gap: 4px; }',
    '.toolbar.touch .touch-top-row { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px; }',
    '.toolbar.touch .touch-bot-row { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 5px; overflow-x: auto; }',
    '.toolbar.touch:not(.can-edit) .edit-btn { display: none !important; }',
    '.toolbar.touch:not(.editing) .done-btn { display: none !important; }',
    '.toolbar.touch:not(.editing) .fmt-wrap { display: none !important; }',
    '.toolbar.touch.editing { border-radius: 0; padding: 8px 10px; }',
    '.toolbar.touch.editing .touch-top-row, .toolbar.touch.editing .block-tools, .toolbar.touch.editing .ask, .toolbar.touch.editing .edit-btn { display: none !important; }',
    '.toolbar.touch.editing .fmt-wrap { display: inline-flex !important; gap: 5px; }',
    '.toolbar.touch.editing .fmt-back { display: none !important; }',

    /* 100% Opaque Dark Popovers */
    '.popover { position: fixed; display: none; pointer-events: auto; width: 296px; background-color: rgb(24,24,27); opacity: 1; border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; padding: 10px; box-shadow: 0 0 0 1px rgba(11,13,16,0.78), 0 12px 28px -4px rgba(11,13,16,0.24), 0 4px 10px -2px rgba(11,13,16,0.12); color: #F4F4F5; user-select: none; }',
    '.popover.open { display: block; }',
    '.popover.menu-pop { width: 244px; padding: 5px; }',
    '.popover.wide { width: 316px; }',
    '.popover.touch { left: 0 !important; right: 0; top: auto !important; width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; border-left: none; border-right: none; border-bottom: none; padding: 12px 12px calc(14px + env(safe-area-inset-bottom, 0px)); box-shadow: 0 -14px 36px rgba(0,0,0,0.45); }',
    '.pop-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }',
    '.pop-title { font-size: 11.5px; font-weight: 600; color: #A1A1AA; letter-spacing: 0.01em; margin: 0 0 6px; }',
    '.pop-head .pop-title { margin: 0; font-size: 12.5px; color: #F4F4F5; font-weight: 700; }',
    '.pop-close { display: none; width: 36px; height: 36px; border: 1px solid rgba(255,255,255,0.14); background: #27272A; color: #D4D4D8; border-radius: 8px; align-items: center; justify-content: center; cursor: pointer; }',
    '.popover.touch .pop-close { display: inline-flex; }',
    '.pop-ctx-note { font-size: 11px; color: #A1A1AA; padding: 5px 9px 6px; border-bottom: 1px solid #27272A; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.loop-card { font-size: 11.5px; line-height: 1.45; color: #D4D4D8; background: #222226; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; padding: 8px 10px; margin-bottom: 8px; }',
    '.loop-card strong { color: #FCD34D; font-weight: 600; display: block; margin-bottom: 2px; }',
    '.pop-input { width: 100%; height: 34px; background: #09090B; border: 1px solid #3F3F46; border-radius: 6px; padding: 0 9px; font-size: 12.5px; color: #FAFAF9; outline: none; }',
    '.popover.touch .pop-input { height: 42px; font-size: 16px; padding: 0 12px; border-radius: 9px; }',
    '.pop-input:focus { border-color: #F59E0B; }',
    '.pop-check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #D4D4D8; margin-top: 8px; cursor: pointer; }',
    '.route-list { max-height: 156px; overflow-y: auto; margin-top: 8px; padding-top: 6px; border-top: 1px solid #27272A; }',
    '.route-item { width: 100%; text-align: left; border: none; background: transparent; padding: 6px 8px; border-radius: 6px; font-size: 12px; font-weight: 500; color: #E4E4E7; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.popover.touch .route-item { min-height: 42px; font-size: 14px; }',
    '.route-item:hover { background: #27272A; color: #FFFFFF; }',
    '.route-slug { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #A1A1AA; flex-shrink: 0; }',
    '.pop-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid #27272A; gap: 6px; }',
    '.menu-item { width: 100%; min-height: 32px; text-align: left; border: none; background: transparent; padding: 6px 9px; border-radius: 6px; font-size: 12.5px; font-weight: 500; color: #F4F4F5; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; }',
    '.popover.touch .menu-item { min-height: 44px; font-size: 14px; padding: 8px 11px; }',
    '.menu-left { display: inline-flex; align-items: center; gap: 8px; }',
    '.menu-item:hover:not(:disabled) { background: #27272A; }',
    '.menu-item:disabled { opacity: 0.40; cursor: default; }',
    '.menu-item.danger { color: #FCA5A5; }',
    '.menu-item.danger:hover:not(:disabled) { background: rgba(239,68,68,0.14); color: #FECACA; }',
    '.menu-item.danger:disabled { opacity: 1; cursor: not-allowed; color: #FCA5A5; }',
    '.menu-item.danger:disabled .menu-left { opacity: 0.72; }',
    '.reason-tag { font-size: 11px; font-weight: 500; color: #A1A1AA; }',
    '.kbd { font-size: 11px; color: #A1A1AA; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
    '.menu-sep { height: 1px; background: #27272A; margin: 4px 3px; }',
    '.style-group { margin-bottom: 11px; }',
    '.style-group:last-child { margin-bottom: 0; }',
    '.seg-row { display: flex; gap: 3px; background: #09090B; padding: 3px; border-radius: 7px; border: 1px solid #27272A; flex-wrap: wrap; }',
    '.seg-btn { flex: 1 1 auto; min-width: 0; height: 27px; border: 1px solid transparent; background: transparent; color: #A1A1AA; font-size: 11.5px; font-weight: 500; padding: 0 7px; border-radius: 5px; cursor: pointer; text-align: center; white-space: nowrap; }',
    '.popover.touch .seg-btn { height: 38px; font-size: 13px; }',
    '.seg-btn:hover { color: #F4F4F5; }',
    '.seg-btn.active { background: #2E2E34; border-color: rgba(255,255,255,0.18); color: #FFFFFF; font-weight: 600; }',
    '.upload-btn { width: 100%; height: 34px; border: none; border-radius: 7px; background: #F4F4F5; color: #18181B; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; margin-bottom: 8px; }',
    '.popover.touch .upload-btn { height: 42px; font-size: 13.5px; }',
    '.upload-btn:hover { background: #FFFFFF; }',
    '.img-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-height: 204px; overflow-y: auto; margin-top: 8px; }',
    '.img-tile { border: 1px solid rgba(255,255,255,0.10); border-radius: 6px; overflow: hidden; background: #222226; cursor: pointer; padding: 0; text-align: left; display: flex; flex-direction: column; }',
    '.img-tile:hover { border-color: #F59E0B; }',
    '.img-tile img { width: 100%; height: 54px; object-fit: cover; display: block; background: #18181B; }',
    '.img-tile span { font-size: 10.5px; color: #D4D4D8; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; }',
    '.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background-color: rgb(24,24,27); border: 1px solid rgba(255,255,255,0.16); color: #FAFAF9; font-size: 12px; font-weight: 500; padding: 7px 14px; border-radius: 999px; box-shadow: 0 10px 24px rgba(0,0,0,0.32); opacity: 0; transition: opacity 150ms ease; pointer-events: none; display: inline-flex; align-items: center; gap: 10px; }',
    '.toast.visible { opacity: 1; pointer-events: auto; }',
    '.toast-undo { border: 1px solid rgba(245,158,11,0.40); background: rgba(245,158,11,0.16); color: #FCD34D; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; cursor: pointer; display: none; }',
    '.toast-undo:hover { background: rgba(245,158,11,0.26); }',
    '.toast.has-undo .toast-undo { display: inline-block; }',
    '</style>',

    '<div class="sel-box"></div>',
    '<div class="flash-box"></div>',
    '<div class="pins"></div>',

    '<div class="toolbar" role="toolbar" aria-label="Selected element">',
    '  <div class="touch-top-row id-wrap">',
    '    <span class="label"></span>',
    '    <span style="display:inline-flex;align-items:center;gap:6px;">',
    '      <button type="button" class="btn parent-btn muted" data-act="parent" title="Select parent">' + SVG.parentUp + '<span class="parent-txt">Parent</span></button>',
    '      <button type="button" class="btn close touch-only-close" data-act="close" title="Close selection (Esc)" aria-label="Close selection">' + SVG.close + '</button>',
    '    </span>',
    '  </div>',
    '  <div class="touch-bot-row">',
    '    <div class="fmt-wrap">',
    '      <button type="button" class="btn muted fmt-back" data-act="format-back" title="Back to block tools">' + SVG.backLeft + '<span class="fmt-back-lbl">Block</span></button>',
    '      <span class="sep fmt-back"></span>',
    '      <span class="fmt fmt-tools">',
    '        <button type="button" class="btn icon-only" data-cmd="bold" title="Bold (Cmd+B)">' + SVG.bold + '</button>',
    '        <button type="button" class="btn icon-only" data-cmd="italic" title="Italic (Cmd+I)">' + SVG.italic + '</button>',
    '        <button type="button" class="btn icon-only" data-cmd="underline" title="Underline (Cmd+U)">' + SVG.underline + '</button>',
    '        <button type="button" class="btn icon-only" data-cmd="strike" title="Strikethrough">' + SVG.strike + '</button>',
    '        <button type="button" class="btn icon-only" data-cmd="code" title="Inline code">' + SVG.code + '</button>',
    '        <span class="sep desktop-only"></span>',
    '        <button type="button" class="btn" data-cmd="link" title="Add or edit link (Cmd+K)">' + SVG.link + '<span class="desktop-only">Link</span></button>',
    '      </span>',
    '    </div>',
    '    <button type="button" class="btn light-primary touch-only edit-btn" data-act="edit" title="Edit text">Edit text</button>',
    '    <div class="block-tools">',
    '      <span class="sep ctx-sep"></span>',
    '      <button type="button" class="btn desktop-only hidden" data-act="format" title="Text formatting">' + SVG.typeAa + '<span>Format</span></button>',
    '      <button type="button" class="btn hidden" data-act="link-el" title="Edit link destination">' + SVG.link + '<span>Edit link</span></button>',
    '      <button type="button" class="btn hidden" data-act="img-replace" title="Replace photo">' + SVG.image + '<span>Replace</span></button>',
    '      <button type="button" class="btn hidden" data-act="img-alt" title="Edit image alt text"><span>Alt text</span></button>',
    '      <button type="button" class="btn hidden" data-act="style" title="Alignment, photo focus & spacing">' + SVG.sliders + '<span>Style</span></button>',
    '      <button type="button" class="btn icon-only hidden" data-act="more" title="Block actions" aria-label="Block actions">' + SVG.more + '</button>',
    '    </div>',
    '    <span class="sep desktop-only"></span>',
    '    <button type="button" class="btn ask" data-act="ask" title="Ask Halley about this">' + SVG.sparkle + '<span>Ask Halley</span></button>',
    '    <button type="button" class="btn light-primary touch-only done-btn" data-act="done" title="Finish editing">Done</button>',
    '    <span class="desktop-close-slot"></span>',
    '  </div>',
    '</div>',

    '<div class="popover link-pop">',
    '  <div class="pop-head"><div class="pop-title link-pop-title">Page or URL</div><button type="button" class="pop-close" data-pop-close="1" aria-label="Close">' + SVG.close + '</button></div>',
    '  <input class="pop-input link-input" type="text" placeholder="Search pages or paste https://..." />',
    '  <label class="pop-check"><input type="checkbox" class="link-newtab" style="accent-color:#F59E0B;" /> Open in new tab</label>',
    '  <div class="route-list"></div>',
    '  <div class="pop-actions">',
    '    <button type="button" class="btn" data-link="remove" style="color:#FCA5A5;">Remove link</button>',
    '    <button type="button" class="btn light-primary" data-link="apply" style="margin-left:auto;">Apply</button>',
    '  </div>',
    '</div>',

    '<div class="popover wide img-pop">',
    '  <div class="pop-head"><div class="pop-title img-pop-title">Replace photo</div><button type="button" class="pop-close" data-pop-close="1" aria-label="Close">' + SVG.close + '</button></div>',
    '  <button type="button" class="upload-btn" data-img="upload">' + SVG.upload + '<span>Upload photo</span></button>',
    '  <input type="file" class="img-file-input" accept="image/*" style="display:none" />',
    '  <input class="pop-input img-search" type="text" placeholder="Search library photos..." />',
    '  <div class="img-grid"></div>',
    '</div>',

    '<div class="popover alt-pop">',
    '  <div class="pop-head"><div class="pop-title">Image alt text</div><button type="button" class="pop-close" data-pop-close="1" aria-label="Close">' + SVG.close + '</button></div>',
    '  <input class="pop-input alt-input" type="text" placeholder="Describe this photo for screen readers..." />',
    '  <div class="pop-actions">',
    '    <button type="button" class="btn muted" data-alt="cancel">Cancel</button>',
    '    <button type="button" class="btn light-primary" data-alt="save">Save</button>',
    '  </div>',
    '</div>',

    '<div class="popover wide style-pop">',
    '  <div class="pop-head"><div class="pop-title">Style</div><button type="button" class="pop-close" data-pop-close="1" aria-label="Close">' + SVG.close + '</button></div>',
    '  <div class="pop-ctx-note style-ctx-note hidden"></div>',
    '  <div class="style-group" data-sg="align">',
    '    <div class="pop-title">Alignment</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-align="left">Left</button>',
    '      <button type="button" class="seg-btn" data-align="center">Center</button>',
    '      <button type="button" class="seg-btn" data-align="right">Right</button>',
    '    </div>',
    '  </div>',
    '  <div class="style-group" data-sg="focal">',
    '    <div class="pop-title">Photo focus (crop protection)</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-focal="top">Top (faces)</button>',
    '      <button type="button" class="seg-btn" data-focal="center">Center</button>',
    '      <button type="button" class="seg-btn" data-focal="bottom">Bottom</button>',
    '      <button type="button" class="seg-btn" data-focal="left">Left</button>',
    '      <button type="button" class="seg-btn" data-focal="right">Right</button>',
    '    </div>',
    '  </div>',
    '  <div class="style-group" data-sg="spacing">',
    '    <div class="pop-title">Vertical spacing</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-spacing="">Default</button>',
    '      <button type="button" class="seg-btn" data-spacing="tight">Compact</button>',
    '      <button type="button" class="seg-btn" data-spacing="normal">Normal</button>',
    '      <button type="button" class="seg-btn" data-spacing="spacious">Spacious</button>',
    '    </div>',
    '  </div>',
    '</div>',

    '<div class="popover menu-pop more-pop">',
    '  <div class="pop-head touch-only" style="padding:4px 8px 6px;border-bottom:1px solid #27272A;margin-bottom:4px;"><div class="pop-title more-touch-title">Block actions</div><button type="button" class="pop-close" data-pop-close="1" aria-label="Close">' + SVG.close + '</button></div>',
    '  <div class="pop-ctx-note more-shared-note hidden">Shared &middot; updates across all pages</div>',
    '  <div class="more-loop-view hidden" style="padding:4px;">',
    '    <div class="loop-card"><strong>Repeated list item</strong>Text &amp; style changes apply across this list. Adding, moving, or deleting items is managed by Halley.</div>',
    '    <button type="button" class="btn ask" data-more="ask-loop" style="width:100%;height:32px;justify-content:center;">' + SVG.sparkle + '<span>Ask Halley to add or reorder&hellip;</span></button>',
    '  </div>',
    '  <div class="more-root-view">',
    '    <button type="button" class="menu-item" data-more="add-drill"><span class="menu-left">' + SVG.plus + '<span>Add block below</span></span>' + SVG.chevronRight + '</button>',
    '    <button type="button" class="menu-item" data-more="duplicate"><span class="menu-left">' + SVG.copy + '<span>Duplicate</span></span><span class="kbd">&#8984;D</span></button>',
    '    <div class="menu-sep"></div>',
    '    <button type="button" class="menu-item" data-more="move-up"><span class="menu-left">' + SVG.moveUp + '<span>Move up</span></span></button>',
    '    <button type="button" class="menu-item" data-more="move-down"><span class="menu-left">' + SVG.moveDown + '<span>Move down</span></span></button>',
    '    <div class="menu-sep"></div>',
    '    <button type="button" class="menu-item danger" data-more="delete"><span class="menu-left">' + SVG.trash + '<span>Delete</span></span><span class="reason-tag delete-reason"></span></button>',
    '  </div>',
    '  <div class="more-add-view hidden">',
    '    <button type="button" class="menu-item" data-more="add-back" style="color:#A1A1AA;font-size:11.5px;min-height:28px;"><span class="menu-left">' + SVG.backLeft + '<span>Add block below</span></span></button>',
    '    <div class="menu-sep"></div>',
    '    <button type="button" class="menu-item" data-add="paragraph"><span class="menu-left">Paragraph</span></button>',
    '    <button type="button" class="menu-item" data-add="heading"><span class="menu-left">Heading</span></button>',
    '    <button type="button" class="menu-item" data-add="list-item"><span class="menu-left">List item</span></button>',
    '    <button type="button" class="menu-item" data-add="image"><span class="menu-left">Image&hellip;</span></button>',
    '  </div>',
    '</div>',

    '<div class="toast"><span class="toast-msg"></span><button type="button" class="toast-undo" data-act="undo">Undo</button></div>',
  ].join('');

  const pinsLayer = shadow.querySelector('.pins');
  const selBox = shadow.querySelector('.sel-box');
  const flashBox = shadow.querySelector('.flash-box');
  const toolbar = shadow.querySelector('.toolbar');
  const idWrap = shadow.querySelector('.id-wrap');
  const labelEl = shadow.querySelector('.label');
  const parentBtn = shadow.querySelector('[data-act="parent"]');
  const closeBtn = shadow.querySelector('[data-act="close"]');
  const desktopCloseSlot = shadow.querySelector('.desktop-close-slot');
  const touchCloseParent = closeBtn.parentElement;

  const fmtBackLbl = shadow.querySelector('.fmt-back-lbl');
  const formatBtn = shadow.querySelector('[data-act="format"]');
  const linkElBtn = shadow.querySelector('[data-act="link-el"]');
  const imgReplaceBtn = shadow.querySelector('[data-act="img-replace"]');
  const imgAltBtn = shadow.querySelector('[data-act="img-alt"]');
  const styleBtn = shadow.querySelector('[data-act="style"]');
  const moreBtn = shadow.querySelector('[data-act="more"]');
  const ctxSep = shadow.querySelector('.ctx-sep');

  const toastEl = shadow.querySelector('.toast');
  const toastMsg = shadow.querySelector('.toast-msg');
  const toastUndoBtn = shadow.querySelector('.toast-undo');

  const linkPop = shadow.querySelector('.link-pop');
  const linkPopTitle = shadow.querySelector('.link-pop-title');
  const linkInput = shadow.querySelector('.link-input');
  const linkNewTab = shadow.querySelector('.link-newtab');
  const linkRemoveBtn = shadow.querySelector('[data-link="remove"]');
  const routeList = shadow.querySelector('.route-list');

  const imgPop = shadow.querySelector('.img-pop');
  const imgPopTitle = shadow.querySelector('.img-pop-title');
  const imgFileInput = shadow.querySelector('.img-file-input');
  const imgSearch = shadow.querySelector('.img-search');
  const imgGrid = shadow.querySelector('.img-grid');

  const altPop = shadow.querySelector('.alt-pop');
  const altInput = shadow.querySelector('.alt-input');

  const stylePop = shadow.querySelector('.style-pop');
  const styleCtxNote = shadow.querySelector('.style-ctx-note');

  const morePop = shadow.querySelector('.more-pop');
  const moreSharedNote = shadow.querySelector('.more-shared-note');
  const moreLoopView = shadow.querySelector('.more-loop-view');
  const moreRootView = shadow.querySelector('.more-root-view');
  const moreAddView = shadow.querySelector('.more-add-view');
  const deleteReasonEl = shadow.querySelector('.delete-reason');

  const allPopovers = {
    link: linkPop,
    image: imgPop,
    alt: altPop,
    style: stylePop,
    more: morePop,
  };

  function syncCloseButtonSlot() {
    // Keep strictly ONE button[data-act="close"] in DOM, moving it between desktop end-cap and mobile top-row!
    if (touchLayout) {
      if (closeBtn.parentElement !== touchCloseParent) touchCloseParent.appendChild(closeBtn);
    } else {
      if (closeBtn.parentElement !== desktopCloseSlot) desktopCloseSlot.appendChild(closeBtn);
    }
  }

  let toastTimer = null;
  function showToast(msg, withUndo) {
    toastMsg.textContent = String(msg || '').replace(/\\s+in\\s+(?:src|public)\\/\\S+/i, '');
    toastEl.classList.toggle('has-undo', Boolean(withUndo && clientUndoStack.length > 0));
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), withUndo ? 4500 : 2200);
  }

  function syncPopoverTriggerStates() {
    linkElBtn.classList.toggle('open', openPopover === 'link' && linkPopMode === 'element');
    imgReplaceBtn.classList.toggle('open', openPopover === 'image' && imgPopMode === 'replace');
    imgAltBtn.classList.toggle('open', openPopover === 'alt');
    styleBtn.classList.toggle('open', openPopover === 'style');
    moreBtn.classList.toggle('open', openPopover === 'more' || (openPopover === 'image' && imgPopMode === 'add-block'));
  }

  function closePopovers() {
    openPopover = null;
    popoverTriggerEl = null;
    moreSubmode = 'root';
    for (const key of Object.keys(allPopovers)) {
      allPopovers[key].classList.remove('open');
    }
    syncPopoverTriggerStates();
  }

  function showPopover(name, triggerEl) {
    closePopovers();
    const pop = allPopovers[name];
    if (!pop) return;
    openPopover = name;
    popoverTriggerEl = triggerEl || null;
    pop.classList.add('open');
    syncPopoverTriggerStates();
    layout();
  }

  function keyOf(meta) { return meta.file + ':' + meta.loc; }

  function metaOf(el) {
    const meta = sourceMap.get(el);
    if (meta) return meta;
    const file = el.getAttribute && el.getAttribute('data-astro-source-file');
    const loc = el.getAttribute && el.getAttribute('data-astro-source-loc');
    if (file && loc) {
      const m = { file, loc };
      sourceMap.set(el, m);
      return m;
    }
    return null;
  }

  function setElMeta(el, file, loc) {
    const m = { file, loc };
    sourceMap.set(el, m);
    if (el.setAttribute) {
      el.setAttribute('data-astro-source-file', file);
      el.setAttribute('data-astro-source-loc', loc);
    }
    knownEls.set(keyOf(m), el);
  }

  function applySubtreeLocs(rootEl, file, locs) {
    if (!rootEl || !Array.isArray(locs) || locs.length === 0) return;
    let idx = 0;
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      if (idx < locs.length) {
        setElMeta(node, file, locs[idx++]);
      }
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i]);
      }
    };
    walk(rootEl);
  }

  function refreshStylesheets() {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const ts = String(Date.now());
    for (const oldLink of links) {
      const href = oldLink.getAttribute('href');
      if (!href) continue;
      try {
        const u = new URL(href, window.location.href);
        if (u.origin !== window.location.origin) continue;
        u.searchParams.set('__halley_css', ts);
        const nextLink = oldLink.cloneNode(true);
        nextLink.setAttribute('href', u.pathname + u.search);
        nextLink.addEventListener('load', () => {
          if (oldLink.parentNode) oldLink.parentNode.removeChild(oldLink);
        }, { once: true });
        nextLink.addEventListener('error', () => {
          if (nextLink.parentNode) nextLink.parentNode.removeChild(nextLink);
        }, { once: true });
        if (oldLink.parentNode) {
          oldLink.parentNode.insertBefore(nextLink, oldLink.nextSibling);
        }
      } catch (err) {
        console.warn('[halley-dev-edit] refreshing stylesheet failed', err);
      }
    }
  }

  function findMappedElement(target) {
    let cur = target;
    while (cur && cur !== document.documentElement) {
      if (cur === host) return null;
      const meta = cur.nodeType === 1 ? metaOf(cur) : null;
      if (meta) return { el: cur, meta };
      cur = cur.parentElement;
    }
    return null;
  }

  function findByKey(key) {
    const known = knownEls.get(key);
    if (known && known.isConnected) return known;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (let i = 0; i < all.length; i++) {
      const m = metaOf(all[i]);
      if (m && keyOf(m) === key) {
        knownEls.set(key, all[i]);
        return all[i];
      }
    }
    return null;
  }

  function friendlyKind(tag) {
    const t = (tag || '').toLowerCase();
    if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4' || t === 'h5' || t === 'h6') return 'Heading';
    if (t === 'p' || t === 'span' || t === 'strong' || t === 'em' || t === 'small') return 'Text';
    if (t === 'blockquote') return 'Quote';
    if (t === 'a') return 'Link';
    if (t === 'button') return 'Button';
    if (t === 'img' || t === 'picture' || t === 'svg') return 'Image';
    if (t === 'figure' || t === 'figcaption') return 'Caption';
    if (t === 'ul' || t === 'ol') return 'List';
    if (t === 'li') return 'List item';
    if (t === 'nav') return 'Navigation';
    if (t === 'header') return 'Header';
    if (t === 'footer') return 'Footer';
    if (t === 'table' || t === 'tr' || t === 'td' || t === 'th') return 'Table';
    if (t === 'form' || t === 'input' || t === 'textarea' || t === 'select') return 'Form';
    return 'Section';
  }

  function escapeHtmlText(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function currentRoute() {
    const p = window.location.pathname;
    if (BASE && p.startsWith(BASE)) {
      const rest = p.slice(BASE.length);
      return rest.startsWith('/') ? rest : '/' + rest;
    }
    return p || '/';
  }

  function notifyRoute() {
    window.parent.postMessage({
      type: 'halley:route-changed',
      route: currentRoute(),
      fullPath: window.location.pathname + window.location.search,
      title: document.title,
    }, '*');
  }

  // ---------- Collision-Aware Slot Locking & Layout ----------

  function computeLockedSlot(el) {
    if (!el || touchLayout) return 'above-left';
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const estW = 410;
    const estH = 36;
    const clampX = (x) => Math.max(8, Math.min(vw - estW - 8, x));

    const obstacles = [];
    const nodes = document.body ? document.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, img, li, figcaption, label, [class*="eyebrow"], [class*="badge"]') : [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n === el || el.contains(n) || n.contains(el)) continue;
      const nr = n.getBoundingClientRect();
      if (nr.width <= 0 || nr.height <= 0) continue;
      if (nr.bottom < r.top - 64 || nr.top > r.bottom + 64) continue;
      let addedLineRects = false;
      if (n.childNodes.length > 0 && n.tagName !== 'IMG' && getComputedStyle(n).display === 'block') {
        try {
          const rng = document.createRange();
          rng.selectNodeContents(n);
          const rects = rng.getClientRects();
          for (let j = 0; j < rects.length; j++) {
            const lr = rects[j];
            if (lr.width > 0 && lr.height > 0) {
              obstacles.push({ left: lr.left, right: lr.right, top: lr.top, bottom: lr.bottom });
              addedLineRects = true;
            }
          }
        } catch (err) {
          console.warn('[halley-dev-edit] measuring obstacle rects failed', err);
        }
      }
      if (!addedLineRects) {
        obstacles.push({ left: nr.left, right: nr.right, top: nr.top, bottom: nr.bottom });
      }
    }

    const overlapArea = (x, y) => {
      let area = 0;
      for (let i = 0; i < obstacles.length; i++) {
        const ob = obstacles[i];
        const ox = Math.max(0, Math.min(x + estW, ob.right + 4) - Math.max(x, ob.left - 4));
        const oy = Math.max(0, Math.min(y + estH, ob.bottom + 4) - Math.max(y, ob.top - 4));
        area += ox * oy;
      }
      return area;
    };

    const aboveY = r.top - estH - 8;
    const belowY = r.bottom + 8;
    const leftX = clampX(r.left);
    const rightX = clampX(r.right - estW);

    const candidates = [];
    if (aboveY >= 8) {
      candidates.push({ slot: 'above-left', score: overlapArea(leftX, aboveY) + 0 });
      if (r.width > 240) candidates.push({ slot: 'above-right', score: overlapArea(rightX, aboveY) + 1 });
    }
    if (belowY + estH <= vh - 8) {
      candidates.push({ slot: 'below-left', score: overlapArea(leftX, belowY) + 2 });
      if (r.width > 240) candidates.push({ slot: 'below-right', score: overlapArea(rightX, belowY) + 3 });
    }
    if (candidates.length === 0) {
      return aboveY >= 8 ? 'above-left' : 'below-left';
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].slot;
  }

  function place(box, r) {
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function notifySelectionChanged(active) {
    const next = Boolean(active);
    if (next === lastNotifiedSelectionActive) return;
    lastNotifiedSelectionActive = next;
    window.parent.postMessage({ type: 'halley:selection-changed', active: next }, '*');
  }

  function keyboardBottomOffset() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height)));
  }

  function placeToolbar(r) {
    syncCloseButtonSlot();
    toolbar.classList.toggle('touch', touchLayout);
    for (const key of Object.keys(allPopovers)) {
      allPopovers[key].classList.toggle('touch', touchLayout);
    }
    if (touchLayout) {
      const kb = keyboardBottomOffset();
      toolbar.style.left = '0px';
      toolbar.style.top = '';
      toolbar.style.bottom = kb + 'px';
      if (openPopover && allPopovers[openPopover]) {
        const pop = allPopovers[openPopover];
        pop.style.maxHeight = '';
        pop.style.overflowY = '';
        pop.style.left = '0px';
        pop.style.top = '';
        pop.style.bottom = kb + 'px';
      }
      return;
    }

    toolbar.style.bottom = '';
    const tw = toolbar.offsetWidth || 340;
    const th = toolbar.offsetHeight || 36;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampX = (x) => Math.max(8, Math.min(vw - tw - 8, x));

    const isRightSlot = selSlot === 'above-right' || selSlot === 'below-right';
    const isBelowSlot = selSlot === 'below-left' || selSlot === 'below-right';
    let left = isRightSlot ? clampX(r.right - tw) : clampX(r.left);
    let top;
    if (isBelowSlot) {
      top = r.bottom + 8;
      if (top + th > vh - 8 && r.top - th - 8 >= 8) {
        top = r.top - th - 8;
      }
    } else {
      top = r.top - th - 8;
      if (top < 8) {
        top = r.bottom + 8 <= vh - th - 8 ? r.bottom + 8 : 8;
      }
    }
    top = Math.max(8, Math.min(vh - th - 8, top));
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';

    if (openPopover && allPopovers[openPopover]) {
      const pop = allPopovers[openPopover];
      pop.style.bottom = '';
      pop.style.maxHeight = '';
      pop.style.overflowY = '';
      const pw = pop.offsetWidth || 296;
      const ph = pop.offsetHeight || 200;
      const trig = (popoverTriggerEl && popoverTriggerEl.isConnected) ? popoverTriggerEl : toolbar;
      const tr = trig.getBoundingClientRect();
      const alignRight = openPopover === 'more' || (openPopover === 'image' && imgPopMode === 'add-block');
      let pLeft = alignRight ? (tr.right - pw) : tr.left;
      pLeft = Math.max(8, Math.min(vw - pw - 8, pLeft));

      const spaceBelow = vh - 8 - (top + th + 6);
      const spaceAbove = (top - 6) - 8;
      let pTop;
      if (ph <= spaceBelow) {
        pTop = top + th + 6;
      } else if (ph <= spaceAbove) {
        pTop = top - ph - 6;
      } else if (spaceBelow >= spaceAbove) {
        pTop = top + th + 6;
        pop.style.maxHeight = Math.max(140, spaceBelow) + 'px';
        pop.style.overflowY = 'auto';
      } else {
        const clampedH = Math.max(140, spaceAbove);
        pop.style.maxHeight = clampedH + 'px';
        pop.style.overflowY = 'auto';
        pTop = Math.max(8, top - Math.min(ph, clampedH) - 6);
      }
      pop.style.left = pLeft + 'px';
      pop.style.top = pTop + 'px';
    }
  }

  function layout() {
    if (mode === 'edit' && selEl && selEl.isConnected) {
      const r = selEl.getBoundingClientRect();
      selBox.style.display = 'block';
      place(selBox, r);
      toolbar.classList.add('open');
      placeToolbar(r);
      notifySelectionChanged(true);
    } else {
      selBox.style.display = 'none';
      toolbar.classList.remove('open');
      closePopovers();
      notifySelectionChanged(false);
    }
    const flashEl = flashKey ? findByKey(flashKey) : null;
    if (flashEl) {
      flashBox.style.display = 'block';
      place(flashBox, flashEl.getBoundingClientRect());
    } else {
      flashBox.style.display = 'none';
    }
    const boxes = pinsLayer.children;
    for (let i = 0; i < pins.length; i++) {
      const box = boxes[i];
      if (!box) continue;
      if (mode !== 'edit') { box.style.display = 'none'; continue; }
      const el = findByKey(pins[i].key);
      if (!el || el === selEl) { box.style.display = 'none'; continue; }
      box.style.display = 'block';
      place(box, el.getBoundingClientRect());
    }
  }

  let looping = false;
  function needsLoop() { return Boolean(flashKey) || (mode === 'edit' && (selEl || pins.length > 0)); }
  function tick() {
    layout();
    if (needsLoop()) requestAnimationFrame(tick);
    else looping = false;
  }
  function startLoop() {
    if (looping) { layout(); return; }
    looping = true;
    requestAnimationFrame(tick);
  }

  function renderPins() {
    pinsLayer.innerHTML = '';
    for (const p of pins) {
      const box = document.createElement('div');
      box.className = 'pin-box';
      const badge = document.createElement('div');
      badge.className = 'pin-badge';
      badge.textContent = String(p.n);
      box.appendChild(badge);
      pinsLayer.appendChild(box);
    }
    if (needsLoop()) startLoop();
    else layout();
  }

  // ---------- Toolbar & Capabilities ----------

  function mappedParent(el) {
    return el && el.parentElement ? findMappedElement(el.parentElement) : null;
  }

  function basename(f) { const i = f.lastIndexOf('/'); return i >= 0 ? f.slice(i + 1) : f; }

  function syncActiveFormatButtons() {
    const cmds = [
      ['bold', ['strong', 'b']],
      ['italic', ['em', 'i']],
      ['underline', ['u']],
      ['strike', ['s', 'del', 'strike']],
      ['code', ['code']],
      ['link', ['a']],
    ];
    let anchor = null;
    if (activeEl) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && activeEl.contains(sel.anchorNode)) {
        anchor = sel.anchorNode;
      }
    }
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i][0];
      const tags = cmds[i][1];
      const btn = shadow.querySelector('button[data-cmd="' + cmd + '"]');
      if (!btn) continue;
      const isActive = Boolean(anchor && findEnclosingTag(anchor, tags, activeEl));
      btn.classList.toggle('active', isActive);
    }
  }

  function renderToolbar() {
    if (!selEl) return;
    syncCloseButtonSlot();
    const tag = selEl.tagName.toLowerCase();
    const kind = friendlyKind(tag);
    const caps = (selInfo && selInfo.capabilities) || null;
    const ctx = (selInfo && selInfo.context) || null;
    const editable = Boolean(selInfo && selInfo.editability === 'editable-static');

    let pillHtml = '';
    if (ctx && ctx.inLoopOrConditional) {
      pillHtml = ' <span class="ctx-pill warn" title="Repeated list item — text &amp; style edits apply across this list">Repeated</span>';
    } else if (ctx && ctx.isSharedFile) {
      pillHtml = ' <span class="ctx-pill" title="Shared across pages">Shared</span>';
    }

    labelEl.innerHTML = '<span>' + escapeHtmlText(kind) + '</span>' + pillHtml;
    labelEl.title = selMeta
      ? (basename(selMeta.file) + ':' + selMeta.loc + (selInfo && selInfo.reason ? ' — ' + selInfo.reason : ''))
      : '';
    fmtBackLbl.textContent = kind;

    const canDirectMutate = Boolean(selInfo && !workspaceLocked && !readOnly);
    const showFormatBtn = Boolean(canDirectMutate && editable && !touchLayout);
    const showLinkEl = Boolean(canDirectMutate && caps && caps.link && caps.link.canEdit);
    const showImgReplace = Boolean(canDirectMutate && caps && caps.image && caps.image.canEditSrc);
    const showImgAlt = Boolean(canDirectMutate && caps && caps.image && caps.image.canEditAlt);
    const showStyle = Boolean(canDirectMutate && caps && caps.style && caps.style.canEdit);
    const st = caps && caps.structural;
    const hasStruct = Boolean(st && (st.canAddAfter || st.canDuplicate || st.canMoveUp || st.canMoveDown || st.canDelete));
    const showMore = Boolean(canDirectMutate && (hasStruct || (ctx && ctx.inLoopOrConditional)));

    formatBtn.classList.toggle('hidden', !showFormatBtn);
    linkElBtn.classList.toggle('hidden', !showLinkEl);
    imgReplaceBtn.classList.toggle('hidden', !showImgReplace);
    imgAltBtn.classList.toggle('hidden', !showImgAlt);
    styleBtn.classList.toggle('hidden', !showStyle);
    moreBtn.classList.toggle('hidden', !showMore);

    const anyTool = showFormatBtn || showLinkEl || showImgReplace || showImgAlt || showStyle || showMore;
    ctxSep.style.display = (!touchLayout && anyTool) ? '' : 'none';

    const inDesktopFormatView = Boolean(
      !touchLayout &&
      canDirectMutate &&
      editable &&
      (manualFormatOpen || (hasHighlightedText && !suppressAutoFormat))
    );

    toolbar.classList.toggle('touch', touchLayout);
    toolbar.classList.toggle('can-edit', Boolean(editable && !workspaceLocked));
    toolbar.classList.toggle('editing', activeEl === selEl);
    toolbar.classList.toggle('format-view', inDesktopFormatView);

    const anyDirect = editable || showLinkEl || showImgReplace || showImgAlt || showStyle || showMore;
    selBox.classList.toggle('editable', Boolean(anyDirect));
    parentBtn.disabled = !mappedParent(selEl);
    syncActiveFormatButtons();
    syncPopoverTriggerStates();
    startLoop();
  }

  async function inspect(meta) {
    try {
      const res = await fetch(BASE + '/__editor/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: meta.file, loc: meta.loc }),
      });
      const data = await res.json();
      if (data && data.editability) return data;
    } catch (err) {
      console.warn('[halley-dev-edit] inspect request failed', err);
    }
    return { editability: 'dynamic', reason: 'Could not inspect element' };
  }

  function placeCaret(el, point) {
    if (!point) return;
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(point.x, point.y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(point.x, point.y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !el.contains(range.startContainer)) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function beginEditing(el, meta, info, point, initialHtml) {
    activeEl = el;
    activeMeta = meta;
    originalHtml = typeof initialHtml === 'string' ? initialHtml : el.innerHTML;
    expectedHash = (info && info.snapshotHash) || '';
    expectedFileHash = (info && info.fileHash) || '';
    expectedContentHash = (info && info.contentHash) || '';
    el.contentEditable = 'true';
    el.focus();
    placeCaret(el, point);
  }

  async function selectElement(el, meta, opts) {
    if (activeEl && activeEl !== el) await finishEditing(true);
    closePopovers();
    hasHighlightedText = false;
    manualFormatOpen = false;
    suppressAutoFormat = false;
    const preInspectHtml = el.innerHTML;
    meta = metaOf(el) || meta;
    selEl = el;
    selMeta = meta;
    selInfo = null;
    selSlot = computeLockedSlot(el);
    knownEls.set(keyOf(meta), el);
    const token = ++selToken;
    renderToolbar();
    const info = await inspect(meta);
    if (token !== selToken) return;
    selInfo = info;
    if (opts && opts.allowEdit && info.editability === 'editable-static') {
      if (workspaceLocked) showToast('Halley is updating files — you can still ask about this');
      else beginEditing(el, meta, info, opts.point, preInspectHtml);
    }
    renderToolbar();
  }

  async function clearSelection(save) {
    selToken++;
    if (activeEl) await finishEditing(save);
    selEl = null;
    selMeta = null;
    selInfo = null;
    hasHighlightedText = false;
    manualFormatOpen = false;
    suppressAutoFormat = false;
    closePopovers();
    notifySelectionChanged(false);
    layout();
  }

  async function selectParent() {
    const p = mappedParent(selEl);
    if (!p) return;
    await selectElement(p.el, p.meta, { allowEdit: false });
  }

  async function askHalley() {
    if (!selEl || !selMeta) return;
    const el = selEl;
    const meta = selMeta;
    const info = selInfo;
    let selectedText = '';
    let rect = el.getBoundingClientRect();
    const s = window.getSelection();
    if (s && s.rangeCount && !s.isCollapsed && el.contains(s.getRangeAt(0).commonAncestorContainer)) {
      selectedText = s.toString().trim().slice(0, 500);
      const rr = s.getRangeAt(0).getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) rect = rr;
    } else if (savedRange && !savedRange.collapsed && el.contains(savedRange.commonAncestorContainer)) {
      selectedText = savedRange.toString().trim().slice(0, 500);
      const rr = savedRange.getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) rect = rr;
    }
    await clearSelection(true);
    knownEls.set(keyOf(meta), el);
    const imgAlt = el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '';
    window.parent.postMessage({
      type: 'halley:element-context',
      context: {
        file: meta.file,
        loc: meta.loc,
        route: currentRoute(),
        tagName: el.tagName.toLowerCase(),
        renderedText: ((el.innerText || imgAlt || '').trim()).slice(0, 300),
        outerHTML: el.outerHTML.slice(0, 1200),
        reason: info && info.editability === 'editable-static' ? 'selected' : 'dynamic',
        selectedText: selectedText || undefined,
      },
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    }, '*');
  }

  // ---------- Range/Selection Controller ----------

  function handleSelectionChange() {
    if (!activeEl) {
      if (hasHighlightedText) {
        hasHighlightedText = false;
        if (selEl) renderToolbar();
      }
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!activeEl.contains(range.commonAncestorContainer)) return;

    savedRange = range.cloneRange();
    const nextHighlighted = !range.collapsed && range.toString().length > 0;
    if (nextHighlighted !== hasHighlightedText) {
      hasHighlightedText = nextHighlighted;
      if (nextHighlighted) {
        suppressAutoFormat = false;
        if (!touchLayout && openPopover && openPopover !== 'link') {
          closePopovers();
        }
      }
    }
    if (selEl) renderToolbar();
  }

  function restoreSelection() {
    if (!savedRange) return null;
    const sel = window.getSelection();
    if (!sel) return null;
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return savedRange;
  }

  function unwrapNode(node) {
    const parent = node.parentNode;
    if (!parent) return;
    const first = node.firstChild;
    const last = node.lastChild;
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
    if (first && last) {
      const r = document.createRange();
      r.setStartBefore(first);
      r.setEndAfter(last);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(r); }
      savedRange = r.cloneRange();
    }
  }

  function findEnclosingTag(node, tagNames, root) {
    if (!node || !root) return null;
    let cur = node.nodeType === 1 ? node : node.parentElement;
    while (cur && cur !== root && root.contains(cur)) {
      if (tagNames.includes(cur.tagName.toLowerCase())) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function toggleInlineTag(tagName, aliases) {
    if (!activeEl) return;
    activeEl.focus();
    const range = restoreSelection() || (window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null);
    if (!range || !activeEl.contains(range.commonAncestorContainer)) return;

    const matchTags = [tagName].concat(aliases || []);
    const existing = findEnclosingTag(range.commonAncestorContainer, matchTags, activeEl);
    if (existing) {
      unwrapNode(existing);
      syncActiveFormatButtons();
      return;
    }
    if (range.collapsed) return;

    const wrapper = document.createElement(tagName);
    const frag = range.extractContents();
    wrapper.appendChild(frag);
    range.insertNode(wrapper);

    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(nextRange); }
    savedRange = nextRange.cloneRange();
    syncActiveFormatButtons();
  }

  function applyInlineLink(rawHref, openNewTab) {
    if (!activeEl) return;
    activeEl.focus();
    const range = restoreSelection() || (window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null);
    if (!range || !activeEl.contains(range.commonAncestorContainer)) return;
    const href = rawHref.startsWith('/') && !rawHref.startsWith('//') ? (BASE + rawHref) : rawHref;

    const existing = findEnclosingTag(range.commonAncestorContainer, ['a'], activeEl);
    if (existing) {
      existing.setAttribute('href', href);
      if (openNewTab) {
        existing.setAttribute('target', '_blank');
        existing.setAttribute('rel', 'noopener noreferrer');
      } else {
        existing.removeAttribute('target');
        existing.removeAttribute('rel');
      }
      syncActiveFormatButtons();
      return;
    }
    if (range.collapsed) return;

    const a = document.createElement('a');
    a.setAttribute('href', href);
    if (openNewTab) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    a.appendChild(range.extractContents());
    range.insertNode(a);

    const nextRange = document.createRange();
    nextRange.selectNodeContents(a);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(nextRange); }
    savedRange = nextRange.cloneRange();
    syncActiveFormatButtons();
  }

  function removeInlineLink() {
    if (!activeEl) return;
    activeEl.focus();
    const range = restoreSelection() || (window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null);
    if (!range || !activeEl.contains(range.commonAncestorContainer)) return;
    const existing = findEnclosingTag(range.commonAncestorContainer, ['a'], activeEl);
    if (existing) unwrapNode(existing);
    syncActiveFormatButtons();
  }

  function insertLineBreakAtCaret() {
    if (!activeEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!activeEl.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    const next = document.createRange();
    next.setStartAfter(br);
    next.collapse(true);
    sel.removeAllRanges();
    sel.addRange(next);
    savedRange = next.cloneRange();
  }

  const PASTE_ALLOWED = {
    strong: 'strong', b: 'strong',
    em: 'em', i: 'em',
    u: 'u',
    s: 's', del: 's', strike: 's',
    code: 'code', small: 'small', sup: 'sup', sub: 'sub',
    br: 'br', a: 'a',
  };

  function sanitizePastedNode(node) {
    if (node.nodeType === 3) {
      return document.createTextNode(node.nodeValue || '');
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      return null;
    }
    const mapped = PASTE_ALLOWED[tag];
    if (mapped === 'br') return document.createElement('br');
    if (mapped) {
      const el = document.createElement(mapped);
      if (mapped === 'a') {
        const href = (node.getAttribute('href') || '').trim();
        const lower = href.toLowerCase();
        if (href && !lower.startsWith('javascript:') && !lower.startsWith('data:') && !lower.startsWith('vbscript:')) {
          el.setAttribute('href', href);
        }
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        const clean = sanitizePastedNode(node.childNodes[i]);
        if (clean) el.appendChild(clean);
      }
      return el;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < node.childNodes.length; i++) {
      const clean = sanitizePastedNode(node.childNodes[i]);
      if (clean) frag.appendChild(clean);
    }
    if ((tag === 'p' || tag === 'div' || tag === 'li') && node.nextSibling) {
      frag.appendChild(document.createElement('br'));
    }
    return frag;
  }

  document.addEventListener('paste', (e) => {
    if (!activeEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!activeEl.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt) return;
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    const frag = document.createDocumentFragment();
    if (html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      for (let i = 0; i < tpl.content.childNodes.length; i++) {
        const clean = sanitizePastedNode(tpl.content.childNodes[i]);
        if (clean) frag.appendChild(clean);
      }
    } else if (text) {
      const lines = text.split(/\\r?\\n/);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(lines[i]));
      }
    }
    range.deleteContents();
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const next = document.createRange();
      next.setStartAfter(last);
      next.collapse(true);
      sel.removeAllRanges();
      sel.addRange(next);
      savedRange = next.cloneRange();
    }
  });

  // ---------- Routes & Images Loaders ----------

  function displayRouteTitle(item) {
    const rawLabel = String(item.label || '').trim();
    const suffix = ' (' + item.route + ')';
    if (rawLabel && rawLabel !== item.route) {
      return rawLabel.endsWith(suffix) ? rawLabel.slice(0, -suffix.length) : rawLabel;
    }
    if (item.route === '/') return 'Home';
    const seg = item.route.split('/').filter(Boolean).pop() || item.route;
    if (seg.toLowerCase() === 'im-new') return "I'm New";
    return seg
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function humanizeImageName(filename) {
    const dot = filename.lastIndexOf('.');
    const stem = (dot > 0 ? filename.slice(0, dot) : filename)
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!stem) return filename;
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }

  async function loadRoutes() {
    if (cachedRoutes) return cachedRoutes;
    try {
      const res = await fetch(BASE + '/__editor/routes');
      const data = await res.json();
      cachedRoutes = Array.isArray(data.routes) ? data.routes : [];
    } catch (err) {
      console.warn('[halley-dev-edit] loading routes for the link picker failed', err);
      cachedRoutes = [];
    }
    return cachedRoutes;
  }

  function renderRoutes(filter) {
    const q = (filter || '').toLowerCase().trim();
    const items = (cachedRoutes || []).filter((r) =>
      r.route.toLowerCase().includes(q) || String(r.label || '').toLowerCase().includes(q)
    ).slice(0, 8);
    routeList.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'route-item';
      btn.type = 'button';
      const titleSpan = document.createElement('span');
      titleSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      titleSpan.textContent = displayRouteTitle(item);
      const slugSpan = document.createElement('span');
      slugSpan.className = 'route-slug';
      slugSpan.textContent = item.route;
      btn.appendChild(titleSpan);
      btn.appendChild(slugSpan);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        linkInput.value = item.route;
        applyLinkFromPop();
      });
      routeList.appendChild(btn);
    }
  }

  async function loadImages(force) {
    if (cachedImages && !force) return cachedImages;
    try {
      const res = await fetch(BASE + '/__editor/images');
      const data = await res.json();
      cachedImages = Array.isArray(data.images) ? data.images : [];
    } catch (err) {
      console.warn('[halley-dev-edit] loading site images failed', err);
      cachedImages = [];
    }
    return cachedImages;
  }

  function renderImageGrid(filter) {
    const q = (filter || '').toLowerCase().trim();
    const items = (cachedImages || []).filter((img) =>
      img.path.toLowerCase().includes(q) || img.filename.toLowerCase().includes(q)
    ).slice(0, 30);
    imgGrid.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'grid-column:1/-1;font-size:11.5px;color:#A1A1AA;padding:8px 2px;';
      empty.textContent = 'No matching photos found in library';
      imgGrid.appendChild(empty);
      return;
    }
    for (const item of items) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'img-tile';
      tile.title = item.path;
      const im = document.createElement('img');
      im.src = BASE + item.path;
      im.alt = humanizeImageName(item.filename);
      im.loading = 'lazy';
      const cap = document.createElement('span');
      cap.textContent = humanizeImageName(item.filename);
      tile.appendChild(im);
      tile.appendChild(cap);
      tile.addEventListener('click', () => {
        void handleChosenImage(item.path, '');
      });
      imgGrid.appendChild(tile);
    }
  }

  // ---------- Source Map Shifting & Undo Helper ----------

  function snapshotFileLocs(targetFile) {
    const entries = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (let i = 0; i < all.length; i++) {
      const m = metaOf(all[i]);
      if (m && m.file === targetFile) {
        entries.push({ el: all[i], loc: m.loc });
      }
    }
    return entries;
  }

  function restoreFileLocs(targetFile, entries) {
    for (const item of entries) {
      if (item.el) setElMeta(item.el, targetFile, item.loc);
    }
  }

  function shiftSourceMapLines(
    targetFile,
    topLineDelta,
    afterLine,
    afterLineDelta,
    sameLineEndCol,
    sameLineByteDelta,
    skipSet,
  ) {
    if (!topLineDelta && !afterLineDelta && !sameLineByteDelta) return;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const remapLoc = (loc) => {
      const parts = String(loc || '').split(':');
      const line = parseInt(parts[0], 10);
      const col = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
      if (Number.isNaN(line)) return loc;
      let nextLine = line;
      let nextCol = col;
      if (line === afterLine && !Number.isNaN(col) && sameLineEndCol > 0 && col > sameLineEndCol) {
        nextCol = Math.max(1, col + sameLineByteDelta);
        if (afterLineDelta) nextLine += afterLineDelta;
      } else if (afterLineDelta && line > afterLine) {
        nextLine += afterLineDelta;
      }
      if (topLineDelta) nextLine += topLineDelta;
      if (!Number.isNaN(nextCol)) {
        const rest = parts.length > 2 ? ':' + parts.slice(2).join(':') : '';
        return nextLine + ':' + nextCol + rest;
      }
      return nextLine + (parts.length > 1 ? ':' + parts.slice(1).join(':') : '');
    };
    const nextKnown = new Map();
    for (let i = 0; i < all.length; i++) {
      const node = all[i];
      if (skipSet && skipSet.has(node)) continue;
      const m = metaOf(node);
      if (!m || m.file !== targetFile) continue;
      const nextLoc = remapLoc(m.loc);
      if (nextLoc !== m.loc) {
        const updated = { file: m.file, loc: nextLoc };
        sourceMap.set(node, updated);
        if (node.hasAttribute && node.hasAttribute('data-astro-source-loc')) {
          node.setAttribute('data-astro-source-loc', nextLoc);
        }
        nextKnown.set(keyOf(updated), node);
      }
    }
    if (selMeta && selMeta.file === targetFile && (!skipSet || !skipSet.has(selEl))) {
      selMeta = { file: selMeta.file, loc: remapLoc(selMeta.loc) };
    }
    for (const [k, v] of nextKnown.entries()) {
      knownEls.set(k, v);
    }
  }

  function pushClientUndo(entry) {
    clientUndoStack.push(entry);
    if (clientUndoStack.length > 40) clientUndoStack.shift();
    clientRedoStack.length = 0;
  }

  async function performUndo() {
    if (workspaceLocked || readOnly) return;
    if (activeEl) await finishEditing(true);
    try {
      const res = await fetch(BASE + '/__editor/undo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Nothing to undo');
        return;
      }
      const entry = clientUndoStack.pop();
      if (entry) {
        entry.undoDom();
        clientRedoStack.push(entry);
      }
      closePopovers();
      if (selEl && !selEl.isConnected) {
        selEl = null; selMeta = null; selInfo = null;
      } else if (selEl && selMeta) {
        selMeta = metaOf(selEl) || selMeta;
        selInfo = await inspect(selMeta);
        renderToolbar();
      }
      layout();
      showToast('Undid: ' + (data.summary || 'last edit'));
      window.parent.postMessage({
        type: 'halley:patch-saved',
        file: data.relFile || '',
        loc: '',
        summary: 'Undid ' + (data.summary || 'edit'),
      }, window.location.origin);
    } catch (err) {
      console.warn('[halley-dev-edit] undo request failed', err);
      showToast('Could not undo');
    }
  }

  async function performRedo() {
    if (workspaceLocked || readOnly) return;
    if (activeEl) await finishEditing(true);
    try {
      const res = await fetch(BASE + '/__editor/redo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Nothing to redo');
        return;
      }
      const entry = clientRedoStack.pop();
      if (entry) {
        entry.redoDom();
        clientUndoStack.push(entry);
      }
      closePopovers();
      if (selEl && !selEl.isConnected) {
        selEl = null; selMeta = null; selInfo = null;
      } else if (selEl && selMeta) {
        selMeta = metaOf(selEl) || selMeta;
        selInfo = await inspect(selMeta);
        renderToolbar();
      }
      layout();
      showToast('Redid: ' + (data.summary || 'edit'), true);
      window.parent.postMessage({
        type: 'halley:patch-saved',
        file: data.relFile || '',
        loc: '',
        summary: 'Redid ' + (data.summary || 'edit'),
      }, window.location.origin);
    } catch (err) {
      console.warn('[halley-dev-edit] redo request failed', err);
      showToast('Could not redo');
    }
  }

  // ---------- Server Mutations ----------

  async function runMutation(mutation) {
    if (activeEl) await finishEditing(true);
    if (!selEl || !selMeta || !selInfo) return null;
    if (workspaceLocked || readOnly) return null;
    const el = selEl;
    const meta = selMeta;
    const expectedOuterHash = selInfo.outerSnapshotHash || selInfo.snapshotHash || '';

    const beforeLocs = snapshotFileLocs(meta.file);

    try {
      const res = await fetch(BASE + '/__editor/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: meta.file,
          loc: meta.loc,
          expectedOuterHash,
          fileHash: selInfo.fileHash || undefined,
          mutation,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not apply change');
        window.parent.postMessage({ type: 'halley:edit-error', message: data.error || 'Mutation failed' }, window.location.origin);
        return null;
      }

      const file = meta.file;
      if (mutation.kind === 'set-link') {
        const prevHref = el.getAttribute('href');
        const prevTarget = el.getAttribute('target');
        const prevRel = el.getAttribute('rel');
        const applyDom = () => {
          if (data.resolvedHref !== undefined) el.setAttribute('href', data.resolvedHref);
          if (data.appliedTarget) {
            el.setAttribute('target', data.appliedTarget);
            el.setAttribute('rel', data.appliedRel || 'noopener noreferrer');
          } else if (mutation.openInNewTab === false) {
            el.removeAttribute('target');
            el.removeAttribute('rel');
          }
        };
        applyDom();
        shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0));
        if (data.newLoc) setElMeta(el, file, data.newLoc); // the opening tag changed: re-point this element
        const afterLocs = snapshotFileLocs(file);
        pushClientUndo({
          summary: data.summary,
          undoDom: () => {
            if (prevHref === null) el.removeAttribute('href'); else el.setAttribute('href', prevHref);
            if (prevTarget === null) el.removeAttribute('target'); else el.setAttribute('target', prevTarget);
            if (prevRel === null) el.removeAttribute('rel'); else el.setAttribute('rel', prevRel);
            restoreFileLocs(file, beforeLocs);
          },
          redoDom: () => { applyDom(); restoreFileLocs(file, afterLocs); },
        });
      } else if (mutation.kind === 'set-image') {
        const prevSrc = el.getAttribute('src');
        const prevAlt = el.getAttribute('alt');
        const applyDom = () => {
          if (data.resolvedSrc !== undefined) el.setAttribute('src', data.resolvedSrc);
          if (data.appliedAlt !== undefined) el.setAttribute('alt', data.appliedAlt);
        };
        applyDom();
        shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0));
        if (data.newLoc) setElMeta(el, file, data.newLoc); // the opening tag changed: re-point this element
        const afterLocs = snapshotFileLocs(file);
        pushClientUndo({
          summary: data.summary,
          undoDom: () => {
            if (prevSrc === null) el.removeAttribute('src'); else el.setAttribute('src', prevSrc);
            if (prevAlt === null) el.removeAttribute('alt'); else el.setAttribute('alt', prevAlt);
            restoreFileLocs(file, beforeLocs);
          },
          redoDom: () => { applyDom(); restoreFileLocs(file, afterLocs); },
        });
      } else if (mutation.kind === 'set-style') {
        const prevClass = el.getAttribute('class');
        const applyDom = () => {
          if (data.appliedClass) el.setAttribute('class', data.appliedClass);
          else el.removeAttribute('class');
          refreshStylesheets();
        };
        applyDom();
        shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0));
        if (data.newLoc) setElMeta(el, file, data.newLoc); // the opening tag changed: re-point this element
        const afterLocs = snapshotFileLocs(file);
        pushClientUndo({
          summary: data.summary,
          undoDom: () => {
            if (prevClass === null) el.removeAttribute('class'); else el.setAttribute('class', prevClass);
            restoreFileLocs(file, beforeLocs);
            refreshStylesheets();
          },
          redoDom: () => { applyDom(); restoreFileLocs(file, afterLocs); },
        });
      } else if (mutation.kind === 'duplicate') {
        const parent = el.parentNode;
        const clone = el.cloneNode(true);
        if (clone.removeAttribute) clone.removeAttribute('id');
        const idNodes = clone.querySelectorAll ? clone.querySelectorAll('[id]') : [];
        for (let i = 0; i < idNodes.length; i++) idNodes[i].removeAttribute('id');
        if (parent) parent.insertBefore(clone, el.nextSibling);
        const skipSet = new Set([clone]);
        const cloneDesc = clone.querySelectorAll ? clone.querySelectorAll('*') : [];
        for (let i = 0; i < cloneDesc.length; i++) skipSet.add(cloneDesc[i]);
        shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0), skipSet);
        applySubtreeLocs(clone, file, data.subtreeLocs || [data.newLoc]);
        const afterLocs = snapshotFileLocs(file);
        pushClientUndo({
          summary: data.summary,
          undoDom: () => {
            if (clone.parentNode) clone.parentNode.removeChild(clone);
            restoreFileLocs(file, beforeLocs);
          },
          redoDom: () => {
            if (parent) parent.insertBefore(clone, el.nextSibling);
            restoreFileLocs(file, afterLocs);
          },
        });
        await selectElement(clone, { file, loc: data.newLoc }, { allowEdit: false });
      } else if (mutation.kind === 'delete') {
        const parent = el.parentNode;
        const nextSib = el.nextSibling;
        if (parent) parent.removeChild(el);
        shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0));
        const afterLocs = snapshotFileLocs(file);
        pushClientUndo({
          summary: data.summary,
          undoDom: () => {
            if (parent) parent.insertBefore(el, nextSib);
            restoreFileLocs(file, beforeLocs);
          },
          redoDom: () => {
            if (el.parentNode) el.parentNode.removeChild(el);
            restoreFileLocs(file, afterLocs);
          },
        });
        selEl = null; selMeta = null; selInfo = null;
        closePopovers();
        layout();
      } else if (mutation.kind === 'move') {
        const parent = el.parentNode;
        const sib = mutation.direction === 'up' ? el.previousElementSibling : el.nextElementSibling;
        if (parent && sib) {
          if (mutation.direction === 'up') {
            parent.insertBefore(el, sib);
          } else {
            parent.insertBefore(sib, el);
          }
          applySubtreeLocs(el, file, data.subtreeLocs || [data.newLoc]);
          if (data.swappedSubtreeLocs) applySubtreeLocs(sib, file, data.swappedSubtreeLocs);
          const afterLocs = snapshotFileLocs(file);
          pushClientUndo({
            summary: data.summary,
            undoDom: () => {
              if (mutation.direction === 'up') parent.insertBefore(sib, el);
              else parent.insertBefore(el, sib);
              restoreFileLocs(file, beforeLocs);
            },
            redoDom: () => {
              if (mutation.direction === 'up') parent.insertBefore(el, sib);
              else parent.insertBefore(sib, el);
              restoreFileLocs(file, afterLocs);
            },
          });
          selMeta = { file, loc: data.newLoc };
        }
      } else if (mutation.kind === 'add-block') {
        const parent = el.parentNode;
        const tpl = document.createElement('template');
        tpl.innerHTML = data.insertedHtml || '';
        const inserted = tpl.content.firstElementChild;
        if (parent && inserted) {
          parent.insertBefore(inserted, el.nextSibling);
          const skipSet = new Set([inserted]);
          shiftSourceMapLines(file, Number(data.topLineDelta || 0), Number(data.afterLine || 0), Number(data.afterLineDelta || 0), Number(data.sameLineEndCol || 0), Number(data.sameLineByteDelta || 0), skipSet);
          applySubtreeLocs(inserted, file, data.subtreeLocs || [data.newLoc]);
          refreshStylesheets();
          const afterLocs = snapshotFileLocs(file);
          pushClientUndo({
            summary: data.summary,
            undoDom: () => {
              if (inserted.parentNode) inserted.parentNode.removeChild(inserted);
              restoreFileLocs(file, beforeLocs);
            },
            redoDom: () => {
              if (parent) parent.insertBefore(inserted, el.nextSibling);
              restoreFileLocs(file, afterLocs);
              refreshStylesheets();
            },
          });
          const allowEdit = !touchLayout && mutation.blockKind !== 'image';
          await selectElement(inserted, { file, loc: data.newLoc }, { allowEdit });
        }
      }

      if (selEl === el && selMeta) {
        selMeta = metaOf(el) || selMeta;
        selInfo = await inspect(selMeta);
        renderToolbar();
      }
      showToast('Saved', true);
      window.parent.postMessage({
        type: 'halley:patch-saved',
        file,
        loc: data.newLoc || meta.loc,
        summary: data.summary || ('Edited ' + file),
      }, window.location.origin);
      return data;
    } catch (err) {
      console.warn('[halley-dev-edit] saving element change failed', err);
      showToast('Network error while saving');
      return null;
    }
  }

  // ---------- Popover Openers & Handlers ----------

  async function openLinkPopover(modeKind, triggerEl) {
    linkPopMode = modeKind;
    await loadRoutes();
    let existingHref = '';
    let existingNewTab = false;
    if (modeKind === 'element' && selInfo && selInfo.capabilities && selInfo.capabilities.link) {
      existingHref = selInfo.capabilities.link.href || '';
      existingNewTab = selInfo.capabilities.link.target === '_blank';
      linkPopTitle.textContent = 'Page or URL';
      linkRemoveBtn.style.display = 'none';
    } else {
      linkPopTitle.textContent = 'Page or URL';
      linkRemoveBtn.style.display = '';
      const sel = window.getSelection();
      if (sel && sel.anchorNode && activeEl) {
        const a = findEnclosingTag(sel.anchorNode, ['a'], activeEl);
        if (a) {
          existingHref = a.getAttribute('href') || '';
          if (BASE && existingHref.startsWith(BASE)) existingHref = existingHref.slice(BASE.length) || '/';
          existingNewTab = a.getAttribute('target') === '_blank';
        }
      }
    }
    linkInput.value = existingHref;
    linkNewTab.checked = existingNewTab;
    renderRoutes('');
    showPopover('link', triggerEl);
    setTimeout(() => linkInput.focus(), 10);
  }

  function applyLinkFromPop() {
    const raw = linkInput.value.trim();
    const openNewTab = Boolean(linkNewTab.checked);
    closePopovers();
    if (!raw) return;
    if (linkPopMode === 'element') {
      void runMutation({ kind: 'set-link', href: raw, openInNewTab: openNewTab });
    } else {
      applyInlineLink(raw, openNewTab);
    }
  }

  async function openImagePopover(modeKind, triggerEl) {
    imgPopMode = modeKind;
    imgPopTitle.textContent = modeKind === 'add-block' ? 'Insert photo' : 'Replace photo';
    imgSearch.value = '';
    showPopover('image', triggerEl);
    await loadImages(false);
    renderImageGrid('');
  }

  async function handleChosenImage(publicPath, altText) {
    closePopovers();
    if (imgPopMode === 'add-block') {
      await runMutation({ kind: 'add-block', blockKind: 'image', imageSrc: publicPath, imageAlt: altText || '' });
    } else {
      await runMutation({ kind: 'set-image', src: publicPath });
    }
  }

  async function handleUploadFile(file) {
    if (!file) return;
    showToast('Uploading photo…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (selInfo && selInfo.capabilities && selInfo.capabilities.image && selInfo.capabilities.image.src) {
        fd.append('existingSrc', selInfo.capabilities.image.src);
      }
      const res = await fetch(BASE + '/__editor/upload-image', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.publicPath) {
        showToast(data.error || 'Photo upload failed');
        return;
      }
      cachedImages = null;
      await handleChosenImage(data.publicPath, '');
    } catch (err) {
      console.warn('[halley-dev-edit] uploading image failed', err);
      showToast('Network error uploading photo');
    }
  }

  function openAltPopover(triggerEl) {
    const curAlt = (selInfo && selInfo.capabilities && selInfo.capabilities.image && selInfo.capabilities.image.alt) || (selEl && selEl.getAttribute('alt')) || '';
    altInput.value = curAlt;
    showPopover('alt', triggerEl);
    setTimeout(() => altInput.focus(), 10);
  }

  function openStylePopover(triggerEl) {
    const st = selInfo && selInfo.capabilities && selInfo.capabilities.style;
    const ctx = (selInfo && selInfo.context) || null;
    if (!st || !st.canEdit) return;
    if (ctx && ctx.inLoopOrConditional) {
      styleCtxNote.textContent = 'Applies across all items in this repeated list';
      styleCtxNote.classList.remove('hidden');
    } else if (ctx && ctx.isSharedFile) {
      styleCtxNote.textContent = 'Shared · style updates across all pages';
      styleCtxNote.classList.remove('hidden');
    } else {
      styleCtxNote.classList.add('hidden');
    }

    stylePop.querySelector('[data-sg="align"]').style.display = st.supportsAlign ? '' : 'none';
    stylePop.querySelector('[data-sg="focal"]').style.display = st.supportsFocal ? '' : 'none';
    stylePop.querySelector('[data-sg="spacing"]').style.display = st.supportsSpacing ? '' : 'none';
    const alignBtns = stylePop.querySelectorAll('[data-align]');
    for (let i = 0; i < alignBtns.length; i++) {
      alignBtns[i].classList.toggle('active', alignBtns[i].getAttribute('data-align') === st.align);
    }
    const focalBtns = stylePop.querySelectorAll('[data-focal]');
    for (let i = 0; i < focalBtns.length; i++) {
      focalBtns[i].classList.toggle('active', focalBtns[i].getAttribute('data-focal') === st.objectPosition);
    }
    const spacingBtns = stylePop.querySelectorAll('[data-spacing]');
    for (let i = 0; i < spacingBtns.length; i++) {
      const val = spacingBtns[i].getAttribute('data-spacing') || null;
      spacingBtns[i].classList.toggle('active', val === st.spacing);
    }
    showPopover('style', triggerEl);
  }

  function syncMoreSubmode() {
    const ctx = (selInfo && selInfo.context) || null;
    const st = (selInfo && selInfo.capabilities && selInfo.capabilities.structural) || null;
    const isLoop = Boolean(ctx && ctx.inLoopOrConditional);
    const isShared = Boolean(ctx && ctx.isSharedFile && !isLoop);

    moreSharedNote.classList.toggle('hidden', !isShared);
    moreLoopView.classList.toggle('hidden', !isLoop);
    moreRootView.classList.toggle('hidden', isLoop || moreSubmode !== 'root');
    moreAddView.classList.toggle('hidden', isLoop || moreSubmode !== 'add');

    if (!isLoop && st) {
      morePop.querySelector('[data-more="add-drill"]').disabled = !st.canAddAfter;
      morePop.querySelector('[data-more="duplicate"]').disabled = !st.canDuplicate;
      morePop.querySelector('[data-more="move-up"]').disabled = !st.canMoveUp;
      morePop.querySelector('[data-more="move-down"]').disabled = !st.canMoveDown;
      morePop.querySelector('[data-more="delete"]').disabled = !st.canDelete;
      const tag = selEl ? selEl.tagName.toLowerCase() : '';
      deleteReasonEl.textContent = (!st.canDelete && tag === 'h1') ? 'Required page title' : '';
    }
  }

  function openMorePopover(triggerEl) {
    moreSubmode = 'root';
    syncMoreSubmode();
    showPopover('more', triggerEl);
  }

  // ---------- Toolbar & Popover Events ----------

  toolbar.addEventListener('pointerdown', (e) => { e.preventDefault(); });
  toolbar.addEventListener('click', (e) => {
    const act = e.target.closest && e.target.closest('button[data-act]');
    if (!act || act.disabled) return;
    const which = act.getAttribute('data-act');
    if (which === 'ask') void askHalley();
    else if (which === 'parent') void selectParent();
    else if (which === 'edit') {
      if (selEl && selMeta && selInfo && selInfo.editability === 'editable-static' && !workspaceLocked) {
        beginEditing(selEl, selMeta, selInfo, null, selEl.innerHTML);
        renderToolbar();
      }
    } else if (which === 'format') {
      if (selEl && selMeta && selInfo && selInfo.editability === 'editable-static' && !workspaceLocked) {
        closePopovers();
        if (!activeEl) beginEditing(selEl, selMeta, selInfo, null, selEl.innerHTML);
        manualFormatOpen = true;
        suppressAutoFormat = false;
        renderToolbar();
      }
    } else if (which === 'format-back') {
      closePopovers();
      manualFormatOpen = false;
      suppressAutoFormat = true;
      renderToolbar();
    } else if (which === 'done' || which === 'close') void clearSelection(true);
    else if (which === 'link-el') {
      if (openPopover === 'link' && linkPopMode === 'element') closePopovers();
      else void openLinkPopover('element', linkElBtn);
    } else if (which === 'img-replace') {
      if (openPopover === 'image' && imgPopMode === 'replace') closePopovers();
      else void openImagePopover('replace', imgReplaceBtn);
    } else if (which === 'img-alt') {
      if (openPopover === 'alt') closePopovers();
      else openAltPopover(imgAltBtn);
    } else if (which === 'style') {
      if (openPopover === 'style') closePopovers();
      else openStylePopover(styleBtn);
    } else if (which === 'more') {
      if (openPopover === 'more') closePopovers();
      else openMorePopover(moreBtn);
    }
  });

  shadow.addEventListener('click', (e) => {
    const closePop = e.target.closest && e.target.closest('button[data-pop-close]');
    if (closePop) {
      e.preventDefault();
      closePopovers();
    }
  });

  toastUndoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void performUndo();
  });

  shadow.querySelector('.fmt').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-cmd]');
    if (!btn || !activeEl) return;
    const cmd = btn.getAttribute('data-cmd');
    if (cmd === 'bold') toggleInlineTag('strong', ['b']);
    else if (cmd === 'italic') toggleInlineTag('em', ['i']);
    else if (cmd === 'underline') toggleInlineTag('u');
    else if (cmd === 'strike') toggleInlineTag('s', ['del', 'strike']);
    else if (cmd === 'code') toggleInlineTag('code');
    else if (cmd === 'link') void openLinkPopover('inline', btn);
  });

  linkInput.addEventListener('input', () => renderRoutes(linkInput.value));
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLinkFromPop(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePopovers(); if (activeEl) activeEl.focus(); }
  });
  shadow.querySelector('[data-link="apply"]').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    applyLinkFromPop();
  });
  linkRemoveBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    closePopovers();
    removeInlineLink();
  });

  shadow.querySelector('[data-img="upload"]').addEventListener('click', () => {
    imgFileInput.value = '';
    imgFileInput.click();
  });
  imgFileInput.addEventListener('change', () => {
    const f = imgFileInput.files && imgFileInput.files[0];
    if (f) void handleUploadFile(f);
  });
  imgSearch.addEventListener('input', () => renderImageGrid(imgSearch.value));

  altInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = altInput.value;
      closePopovers();
      void runMutation({ kind: 'set-image', alt: val });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopovers();
    }
  });
  shadow.querySelector('[data-alt="save"]').addEventListener('click', () => {
    const val = altInput.value;
    closePopovers();
    void runMutation({ kind: 'set-image', alt: val });
  });
  shadow.querySelector('[data-alt="cancel"]').addEventListener('click', () => closePopovers());

  stylePop.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button.seg-btn');
    if (!btn) return;
    const st = selInfo && selInfo.capabilities && selInfo.capabilities.style;
    if (!st) return;
    if (btn.hasAttribute('data-align')) {
      const val = btn.getAttribute('data-align');
      closePopovers();
      void runMutation({ kind: 'set-style', align: st.align === val ? null : val });
    } else if (btn.hasAttribute('data-focal')) {
      const val = btn.getAttribute('data-focal');
      closePopovers();
      void runMutation({ kind: 'set-style', objectPosition: st.objectPosition === val ? null : val });
    } else if (btn.hasAttribute('data-spacing')) {
      const raw = btn.getAttribute('data-spacing');
      closePopovers();
      void runMutation({ kind: 'set-style', spacing: raw ? raw : null });
    }
  });
  stylePop.addEventListener('pointerdown', (e) => { e.preventDefault(); });
  morePop.addEventListener('pointerdown', (e) => { e.preventDefault(); });

  morePop.addEventListener('click', (e) => {
    const addBtnEl = e.target.closest && e.target.closest('button[data-add]');
    if (addBtnEl) {
      const kind = addBtnEl.getAttribute('data-add');
      if (kind === 'image') {
        void openImagePopover('add-block', moreBtn);
        return;
      }
      closePopovers();
      void runMutation({ kind: 'add-block', blockKind: kind });
      return;
    }

    const btn = e.target.closest && e.target.closest('button[data-more]');
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute('data-more');
    if (act === 'add-drill') {
      moreSubmode = 'add';
      syncMoreSubmode();
      layout();
      return;
    }
    if (act === 'add-back') {
      moreSubmode = 'root';
      syncMoreSubmode();
      layout();
      return;
    }
    if (act === 'ask-loop') {
      closePopovers();
      void askHalley();
      return;
    }
    closePopovers();
    if (act === 'duplicate') void runMutation({ kind: 'duplicate' });
    else if (act === 'move-up') void runMutation({ kind: 'move', direction: 'up' });
    else if (act === 'move-down') void runMutation({ kind: 'move', direction: 'down' });
    else if (act === 'delete') void runMutation({ kind: 'delete' });
  });

  // ---------- Inline Text Save ----------

  async function finishEditing(save) {
    if (!activeEl || !activeMeta) return;
    const el = activeEl;
    const meta = activeMeta;
    const prevHtml = originalHtml;
    const newHtml = el.innerHTML;
    el.contentEditable = 'false';
    activeEl = null;
    activeMeta = null;
    savedRange = null;
    hasHighlightedText = false;
    manualFormatOpen = false;
    suppressAutoFormat = false;
    closePopovers();
    if (selEl === el) renderToolbar();

    if (!save || newHtml === prevHtml) {
      if (!save) el.innerHTML = prevHtml;
      return;
    }

    const beforeLocs = snapshotFileLocs(meta.file);
    try {
      const res = await fetch(BASE + '/__editor/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: meta.file,
          loc: meta.loc,
          expectedHash,
          fileHash: expectedFileHash || undefined,
          contentHash: expectedContentHash || undefined,
          newHtml,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        // Stale snapshot: the file (or the element's position) changed since inspect, so this
        // element's source loc may now point elsewhere. Never retry with the old loc — reload to
        // get fresh locs; the next click re-inspects.
        el.innerHTML = prevHtml;
        if (selEl === el) selInfo = null;
        showToast('This text changed on disk — refreshing…');
        window.parent.postMessage({ type: 'halley:edit-error', message: data.error || 'Edit conflict' }, window.location.origin);
        setTimeout(() => {
          if (activeEl) return; // user started another edit; the next save will 409 again if stale
          try {
            sessionStorage.setItem('__halley_scroll_y', String(window.scrollY));
          } catch (storageErr) {
            if (!(storageErr instanceof DOMException)) console.warn('[halley-dev-edit] saving scroll position failed', storageErr);
          }
          window.location.reload();
        }, 1200);
        return;
      }
      if (!res.ok) {
        el.innerHTML = prevHtml;
        showToast(data.error || 'Could not save edit');
        window.parent.postMessage({ type: 'halley:edit-error', message: data.error || 'Save failed' }, window.location.origin);
        return;
      }
      if (data.newHash) {
        expectedHash = data.newHash;
        expectedFileHash = data.newFileHash || '';
        expectedContentHash = data.newContentHash || '';
        if (selEl === el && selInfo) {
          selInfo = Object.assign({}, selInfo, {
            snapshotHash: data.newHash,
            fileHash: data.newFileHash,
            contentHash: data.newContentHash,
            outerSnapshotHash: data.newOuterHash || selInfo.outerSnapshotHash,
          });
        }
      }
      if (data.relocated && data.newLoc) {
        // The file changed under us and the server found this element elsewhere: the page's
        // other locs are stale relative to disk anyway (HMR refreshes them), so only re-point
        // this element instead of shifting everything by deltas computed on the new file.
        const updated = { file: meta.file, loc: data.newLoc };
        sourceMap.set(el, updated);
        if (el.hasAttribute && el.hasAttribute('data-astro-source-loc')) el.setAttribute('data-astro-source-loc', data.newLoc);
        knownEls.set(keyOf(updated), el);
        if (selEl === el) selMeta = updated;
      } else {
        shiftSourceMapLines(
          meta.file,
          Number(data.topLineDelta || 0),
          Number(data.afterLine || 0),
          Number(data.afterLineDelta || 0),
          Number(data.sameLineEndCol || 0),
          Number(data.sameLineByteDelta || 0),
        );
      }
      const afterLocs = snapshotFileLocs(meta.file);
      pushClientUndo({
        summary: 'Edited ' + meta.file,
        undoDom: () => {
          el.innerHTML = prevHtml;
          restoreFileLocs(meta.file, beforeLocs);
        },
        redoDom: () => {
          el.innerHTML = newHtml;
          restoreFileLocs(meta.file, afterLocs);
        },
      });
      showToast('Saved', true);
      window.parent.postMessage({
        type: 'halley:patch-saved',
        file: meta.file,
        loc: data.newLoc || meta.loc,
        summary: 'Edited ' + meta.file,
      }, window.location.origin);
    } catch (err) {
      console.warn('[halley-dev-edit] saving inline edit failed', err);
      el.innerHTML = prevHtml;
      showToast('Network error while saving');
    }
  }

  // ---------- Pointer & Keyboard Handling ----------

  document.addEventListener('pointerdown', () => {
    window.parent.postMessage({ type: 'halley:preview-pointerdown' }, window.location.origin);
  }, { capture: true, passive: true });

  document.addEventListener('click', (e) => {
    if (mode !== 'edit' || readOnly) return;
    if (e.target === host || host.contains(e.target)) return;
    if (!touchLayout && (e.metaKey || e.ctrlKey) && e.target.closest && e.target.closest('a[href]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (activeEl && activeEl.contains(e.target)) {
      if (openPopover) closePopovers();
      return;
    }
    if (!touchLayout && selEl && selEl === e.target && selInfo && selInfo.editability === 'editable-static' && !activeEl && !workspaceLocked) {
      closePopovers();
      beginEditing(selEl, selMeta, selInfo, { x: e.clientX, y: e.clientY }, selEl.innerHTML);
      renderToolbar();
      return;
    }
    const found = findMappedElement(e.target);
    if (!found) { void clearSelection(true); return; }
    void selectElement(found.el, found.meta, { allowEdit: !touchLayout, point: { x: e.clientX, y: e.clientY } });
  }, true);

  document.addEventListener('selectionchange', handleSelectionChange);

  document.addEventListener('keydown', (e) => {
    if (mode !== 'edit') return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (e.key === 'Escape') {
      if (openPopover) {
        e.preventDefault();
        closePopovers();
        if (activeEl) activeEl.focus();
        return;
      }
      if (manualFormatOpen) {
        e.preventDefault();
        manualFormatOpen = false;
        suppressAutoFormat = true;
        renderToolbar();
        return;
      }
      if (!selEl) return;
      e.preventDefault();
      void clearSelection(true);
      return;
    }

    // Duplicate shortcut (Cmd+D) when an element is selected
    if (mod && k === 'd' && selEl && selInfo && selInfo.capabilities && selInfo.capabilities.structural && selInfo.capabilities.structural.canDuplicate && !shadow.activeElement) {
      e.preventDefault();
      closePopovers();
      void runMutation({ kind: 'duplicate' });
      return;
    }

    // Global Edit Mode Undo/Redo when not actively typing inside contentEditable or an input
    if (!activeEl && !shadow.activeElement && mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) void performRedo();
      else void performUndo();
      return;
    }
    if (!activeEl && !shadow.activeElement && mod && k === 'y') {
      e.preventDefault();
      void performRedo();
      return;
    }

    if (!activeEl) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      insertLineBreakAtCaret();
      return;
    }
    if (mod && k === 's') {
      e.preventDefault();
      void finishEditing(true);
    } else if (mod && k === 'b') {
      e.preventDefault();
      toggleInlineTag('strong', ['b']);
    } else if (mod && k === 'i') {
      e.preventDefault();
      toggleInlineTag('em', ['i']);
    } else if (mod && k === 'u') {
      e.preventDefault();
      toggleInlineTag('u');
    } else if (mod && k === 'k') {
      e.preventDefault();
      const linkBtn = shadow.querySelector('button[data-cmd="link"]');
      void openLinkPopover('inline', linkBtn);
    }
  });

  document.addEventListener('focusout', () => {
    if (!activeEl) return;
    setTimeout(() => {
      if (!activeEl || openPopover) return;
      const focused = document.activeElement;
      if (focused === activeEl || activeEl.contains(focused) || focused === host || shadow.activeElement) return;
      void finishEditing(true);
    }, 120);
  });

  window.addEventListener('resize', () => layout());
  window.addEventListener('scroll', () => layout(), { capture: true, passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => layout());
    window.visualViewport.addEventListener('scroll', () => layout());
  }

  window.addEventListener('message', (e) => {
    if (e.source && e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'halley:set-mode') {
      readOnly = Boolean(msg.readOnly);
      if (msg.persona) persona = msg.persona;
      if (typeof msg.touchLayout === 'boolean') touchLayout = msg.touchLayout;
      const next = readOnly ? 'browse' : (msg.mode === 'select' ? 'edit' : (msg.mode || 'browse'));
      mode = next;
      syncCursorStyle();
      if (mode === 'browse') void clearSelection(true);
      else if (selEl) {
        selSlot = computeLockedSlot(selEl);
        renderToolbar();
      }
      if (needsLoop()) startLoop(); else layout();
    } else if (msg.type === 'halley:lock') {
      workspaceLocked = Boolean(msg.locked);
      if (workspaceLocked && activeEl) {
        void finishEditing(false);
        showToast('Halley is editing this page…');
      }
      if (workspaceLocked) {
        clientUndoStack.length = 0;
        clientRedoStack.length = 0;
      }
      if (selEl) renderToolbar();
    } else if (msg.type === 'halley:pins') {
      pins = Array.isArray(msg.pins) ? msg.pins : [];
      renderPins();
    } else if (msg.type === 'halley:highlight') {
      flashKey = msg.key || null;
      if (flashKey) {
        const el = findByKey(flashKey);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      if (needsLoop()) startLoop(); else layout();
    } else if (msg.type === 'halley:page-progress') {
      const statusEl = document.querySelector('[data-halley-placeholder-status]');
      if (statusEl && typeof msg.message === 'string' && msg.message.trim()) {
        statusEl.textContent = msg.message;
      }
    } else if (msg.type === 'halley:reload') {
      if (activeEl && !msg.force) return;
      try {
        sessionStorage.setItem('__halley_scroll_y', String(window.scrollY));
      } catch (err) {
        // Expected when storage is blocked (sandbox / privacy mode / quota): scroll is not restored.
        if (!(err instanceof DOMException)) console.warn('[halley-dev-edit] saving scroll position failed', err);
      }
      window.location.reload();
    }
  });

  window.addEventListener('popstate', notifyRoute);
  document.addEventListener('astro:page-load', notifyRoute);
  notifyRoute();
  try {
    const savedY = sessionStorage.getItem('__halley_scroll_y');
    if (savedY !== null) {
      sessionStorage.removeItem('__halley_scroll_y');
      const y = parseInt(savedY, 10);
      if (!Number.isNaN(y) && y > 0) {
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    }
  } catch (err) {
    // Expected when storage is blocked (sandbox / privacy mode): nothing to restore.
    if (!(err instanceof DOMException)) console.warn('[halley-dev-edit] restoring scroll position failed', err);
  }
  window.parent.postMessage({ type: 'halley:ready', route: currentRoute() }, '*');
})();
`;
}
