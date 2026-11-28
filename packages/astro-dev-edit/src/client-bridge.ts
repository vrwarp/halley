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
  // NOTE: the injected script below avoids backticks, "${" and backslashes so it
  // can live inside this template literal without escaping.
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
  let lastNotifiedSelectionActive = false;

  // Inline editing (only ever the selected element)
  let activeEl = null;
  let activeMeta = null;
  let originalHtml = '';
  let expectedHash = '';
  let cachedRoutes = null;
  let cachedImages = null;
  let savedRange = null;

  // Popover mode state
  let linkPopMode = 'inline'; // 'inline' | 'element'
  let imgPopMode = 'replace'; // 'replace' | 'add-block'
  let openPopover = null; // 'link' | 'image' | 'alt' | 'style' | 'add' | 'more' | null

  // Client DOM undo/redo stack paired 1:1 with server EditUndoStack
  const clientUndoStack = [];
  const clientRedoStack = [];

  // Elements attached to chat (numbered markers, Edit mode only) + chip-hover highlight
  let pins = [];
  let flashKey = null;
  const knownEls = new Map();

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
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = [
    '<style>',
    '* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.sel-box { position: fixed; pointer-events: none; display: none; border: 2px solid #57534e; border-radius: 4px; box-shadow: 0 0 0 4px rgba(28,25,23,0.08); }',
    '.sel-box.editable { border-color: #d97706; box-shadow: 0 0 0 4px rgba(217,119,6,0.14); }',
    '.flash-box { position: fixed; pointer-events: none; display: none; border: 2px solid #d97706; background: rgba(217,119,6,0.10); border-radius: 4px; }',
    '.pin-box { position: fixed; pointer-events: none; border: 1px solid rgba(217,119,6,0.45); border-radius: 3px; }',
    '.pin-badge { position: absolute; top: -9px; left: -9px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #d97706; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #fff; }',
    '.toolbar { position: fixed; display: none; pointer-events: auto; align-items: center; gap: 2px; padding: 3px; background: #fff; border: 1px solid #e7e5e4; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06); max-width: calc(100vw - 16px); flex-wrap: nowrap; }',
    '.toolbar.open { display: flex; }',
    '.toolbar.touch { left: 0 !important; right: 0; top: auto !important; width: 100%; max-width: 100%; border-radius: 14px 14px 0 0; border-left: none; border-right: none; border-bottom: none; padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px)); gap: 6px; justify-content: space-between; box-shadow: 0 -8px 28px rgba(0,0,0,0.14); overflow-x: auto; }',
    '.toolbar.touch .btn { min-height: 38px; padding: 6px 10px; font-size: 13px; border-radius: 8px; }',
    '.toolbar.touch .label { flex: 1; min-width: 0; max-width: none; font-size: 12px; padding: 0 4px; }',
    '.toolbar.touch .sep { display: none; }',
    '.toolbar.touch.editing .label, .toolbar.touch.editing .touch-select-only { display: none !important; }',
    '.toolbar:not(.touch) .touch-only { display: none !important; }',
    '.toolbar.touch:not(.editing) .done-btn { display: none !important; }',
    '.toolbar.touch .edit-btn { display: none; background: #fef3c7; color: #92400e; }',
    '.toolbar.touch.can-edit:not(.editing) .edit-btn { display: inline-flex; }',
    '.label { font-size: 11px; color: #57534e; padding: 0 6px; max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-flex; align-items: center; gap: 5px; }',
    '.label b { font-weight: 600; color: #1c1917; }',
    '.label code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; font-weight: 600; color: #1c1917; }',
    '.ctx-badge { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px; line-height: 1.4; }',
    '.ctx-badge.warn { background: #fef3c7; color: #92400e; }',
    '.ctx-badge.info { background: #f5f5f4; color: #57534e; }',
    '.fmt { display: none; align-items: center; gap: 1px; }',
    '.toolbar.editing .fmt { display: inline-flex; }',
    '.toolbar.touch.editing .fmt { gap: 4px; }',
    '.ctx-acts { display: inline-flex; align-items: center; gap: 2px; }',
    '.toolbar.touch.editing .ctx-acts { display: none; }',
    '.btn { border: none; background: transparent; color: #1c1917; font-size: 12px; font-weight: 600; padding: 5px 7px; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; }',
    '.btn:hover { background: #f5f5f4; }',
    '.btn.active { background: #fef3c7; color: #92400e; }',
    '.btn:disabled { opacity: 0.35; cursor: default; background: transparent; }',
    '.btn.primary { background: #1c1917; color: #fff; }',
    '.btn.primary:hover { background: #292524; }',
    '.btn.danger { color: #b91c1c; }',
    '.btn.danger:hover { background: #fef2f2; }',
    '.btn.close { color: #78716c; padding: 5px 6px; font-size: 14px; line-height: 1; }',
    '.btn.close:hover { color: #1c1917; background: #f5f5f4; }',
    '.btn.hidden { display: none !important; }',
    '.sep { width: 1px; height: 16px; background: #e7e5e4; margin: 0 2px; flex-shrink: 0; }',
    '.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: #1c1917; color: #fafaf9; font-size: 12px; font-weight: 500; padding: 7px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); opacity: 0; transition: opacity 150ms ease; pointer-events: none; display: inline-flex; align-items: center; gap: 10px; }',
    '.toast.visible { opacity: 1; pointer-events: auto; }',
    '.toast-undo { border: none; background: rgba(255,255,255,0.16); color: #fcd34d; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; cursor: pointer; display: none; }',
    '.toast-undo:hover { background: rgba(255,255,255,0.25); }',
    '.toast.has-undo .toast-undo { display: inline-block; }',
    '.popover { position: fixed; display: none; pointer-events: auto; width: 300px; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,0.15); padding: 10px; }',
    '.popover.open { display: block; }',
    '.popover.compact { width: 210px; padding: 6px; }',
    '.popover.wide { width: 340px; }',
    '.popover.touch { left: 0 !important; right: 0; top: auto !important; width: 100%; border-radius: 14px 14px 0 0; border-left: none; border-right: none; border-bottom: none; padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px)); box-shadow: 0 -12px 36px rgba(0,0,0,0.18); }',
    '.pop-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #78716c; margin: 0 0 6px; }',
    '.pop-input { width: 100%; border: 1px solid #d6d3d1; border-radius: 6px; padding: 6px 8px; font-size: 12px; color: #1c1917; outline: none; }',
    '.popover.touch .pop-input { font-size: 16px; padding: 10px 12px; border-radius: 10px; }',
    '.pop-input:focus { border-color: #d97706; }',
    '.pop-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #44403c; margin-top: 8px; cursor: pointer; user-select: none; }',
    '.route-list { max-height: 150px; overflow-y: auto; margin-top: 6px; }',
    '.route-item { width: 100%; text-align: left; border: none; background: transparent; padding: 5px 8px; border-radius: 5px; font-size: 12px; color: #292524; cursor: pointer; display: flex; justify-content: space-between; }',
    '.popover.touch .route-item { padding: 10px; font-size: 14px; }',
    '.route-item:hover { background: #f5f5f4; }',
    '.pop-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid #f5f5f4; gap: 6px; }',
    '.menu-item { width: 100%; text-align: left; border: none; background: transparent; padding: 7px 9px; border-radius: 6px; font-size: 12px; font-weight: 500; color: #1c1917; cursor: pointer; display: flex; align-items: center; justify-content: space-between; }',
    '.menu-item:hover:not(:disabled) { background: #f5f5f4; }',
    '.menu-item:disabled { opacity: 0.35; cursor: default; }',
    '.menu-item.danger { color: #b91c1c; }',
    '.menu-item.danger:hover:not(:disabled) { background: #fef2f2; }',
    '.menu-sep { height: 1px; background: #f5f5f4; margin: 4px 0; }',
    '.style-group { margin-bottom: 10px; }',
    '.style-group:last-child { margin-bottom: 0; }',
    '.seg-row { display: flex; gap: 4px; flex-wrap: wrap; }',
    '.seg-btn { flex: 1; min-width: 52px; border: 1px solid #e7e5e4; background: #fafaf9; color: #292524; font-size: 11px; font-weight: 600; padding: 5px 6px; border-radius: 6px; cursor: pointer; text-align: center; }',
    '.seg-btn:hover { background: #f5f5f4; }',
    '.seg-btn.active { background: #1c1917; color: #fff; border-color: #1c1917; }',
    '.img-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-height: 200px; overflow-y: auto; margin-top: 8px; }',
    '.img-tile { border: 1px solid #e7e5e4; border-radius: 6px; overflow: hidden; background: #fafaf9; cursor: pointer; padding: 0; text-align: left; display: flex; flex-direction: column; }',
    '.img-tile:hover { border-color: #d97706; }',
    '.img-tile img { width: 100%; height: 56px; object-fit: cover; display: block; background: #e7e5e4; }',
    '.img-tile span { font-size: 10px; color: #57534e; padding: 3px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; }',
    '.upload-btn { width: 100%; justify-content: center; background: #fef3c7; color: #92400e; padding: 7px 10px; border-radius: 7px; font-size: 12px; font-weight: 600; border: 1px solid #fde68a; cursor: pointer; margin-bottom: 8px; }',
    '.upload-btn:hover { background: #fde68a; }',
    '</style>',
    '<div class="sel-box"></div>',
    '<div class="flash-box"></div>',
    '<div class="pins"></div>',
    '<div class="toolbar" role="toolbar" aria-label="Selected element">',
    '  <span class="label"></span>',
    '  <span class="fmt">',
    '    <span class="sep"></span>',
    '    <button class="btn" data-cmd="bold" title="Bold (Cmd+B)"><strong>B</strong></button>',
    '    <button class="btn" data-cmd="italic" title="Italic (Cmd+I)"><em>I</em></button>',
    '    <button class="btn" data-cmd="underline" title="Underline (Cmd+U)"><u>U</u></button>',
    '    <button class="btn" data-cmd="strike" title="Strikethrough"><s>S</s></button>',
    '    <button class="btn" data-cmd="code" title="Inline code">&lt;/&gt;</button>',
    '    <button class="btn" data-cmd="link" title="Link (Cmd+K)">Link</button>',
    '  </span>',
    '  <span class="ctx-acts">',
    '    <span class="sep ctx-sep"></span>',
    '    <button class="btn hidden" data-act="link-el" title="Edit link URL">URL</button>',
    '    <button class="btn hidden" data-act="img-replace" title="Replace image">Replace</button>',
    '    <button class="btn hidden" data-act="img-alt" title="Edit alt text">Alt</button>',
    '    <button class="btn hidden" data-act="style" title="Alignment, focal point & spacing">Style</button>',
    '    <button class="btn hidden" data-act="add" title="Add block after">+ Add</button>',
    '    <button class="btn hidden" data-act="more" title="Duplicate, move, or delete">&hellip;</button>',
    '  </span>',
    '  <span class="sep"></span>',
    '  <button class="btn touch-only edit-btn" data-act="edit" title="Edit text">Edit text</button>',
    '  <button class="btn touch-select-only" data-act="parent" title="Select the surrounding block">&#8593; Parent</button>',
    '  <button class="btn primary touch-select-only" data-act="ask" title="Attach this to the chat box">Ask Halley&hellip;</button>',
    '  <button class="btn primary touch-only done-btn" data-act="done" title="Finish editing">Done</button>',
    '  <button class="btn close touch-select-only" data-act="close" title="Close selection (Esc)" aria-label="Close selection">&times;</button>',
    '</div>',
    '<div class="popover link-pop">',
    '  <div class="pop-title link-pop-title">Link URL</div>',
    '  <input class="pop-input link-input" type="text" placeholder="Search site pages or paste https://..." />',
    '  <label class="pop-check"><input type="checkbox" class="link-newtab" /> Open in new tab</label>',
    '  <div class="route-list"></div>',
    '  <div class="pop-actions">',
    '    <button class="btn danger" data-link="remove">Remove link</button>',
    '    <button class="btn primary" data-link="apply">Apply</button>',
    '  </div>',
    '</div>',
    '<div class="popover wide img-pop">',
    '  <div class="pop-title img-pop-title">Replace Image</div>',
    '  <button type="button" class="upload-btn" data-img="upload">Upload new image (auto-WebP)</button>',
    '  <input type="file" class="img-file-input" accept="image/*" style="display:none" />',
    '  <input class="pop-input img-search" type="text" placeholder="Search existing site images..." />',
    '  <div class="img-grid"></div>',
    '</div>',
    '<div class="popover alt-pop">',
    '  <div class="pop-title">Image Alt Text</div>',
    '  <input class="pop-input alt-input" type="text" placeholder="Describe this image for accessibility..." />',
    '  <div class="pop-actions">',
    '    <button class="btn" data-alt="cancel">Cancel</button>',
    '    <button class="btn primary" data-alt="save">Save Alt</button>',
    '  </div>',
    '</div>',
    '<div class="popover style-pop">',
    '  <div class="style-group" data-sg="align">',
    '    <div class="pop-title">Alignment</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-align="left">Left</button>',
    '      <button type="button" class="seg-btn" data-align="center">Center</button>',
    '      <button type="button" class="seg-btn" data-align="right">Right</button>',
    '    </div>',
    '  </div>',
    '  <div class="style-group" data-sg="focal">',
    '    <div class="pop-title">Image Focal Point</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-focal="top">Top</button>',
    '      <button type="button" class="seg-btn" data-focal="center">Center</button>',
    '      <button type="button" class="seg-btn" data-focal="bottom">Bottom</button>',
    '      <button type="button" class="seg-btn" data-focal="left">Left</button>',
    '      <button type="button" class="seg-btn" data-focal="right">Right</button>',
    '    </div>',
    '  </div>',
    '  <div class="style-group" data-sg="spacing">',
    '    <div class="pop-title">Vertical Spacing</div>',
    '    <div class="seg-row">',
    '      <button type="button" class="seg-btn" data-spacing="tight">Tight</button>',
    '      <button type="button" class="seg-btn" data-spacing="normal">Normal</button>',
    '      <button type="button" class="seg-btn" data-spacing="spacious">Spacious</button>',
    '      <button type="button" class="seg-btn" data-spacing="">Default</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="popover compact add-pop">',
    '  <div class="pop-title" style="padding:2px 6px;">Add block after</div>',
    '  <button type="button" class="menu-item" data-add="paragraph">Paragraph</button>',
    '  <button type="button" class="menu-item" data-add="heading">Heading</button>',
    '  <button type="button" class="menu-item" data-add="list-item">List item</button>',
    '  <button type="button" class="menu-item" data-add="image">Image&hellip;</button>',
    '</div>',
    '<div class="popover compact more-pop">',
    '  <button type="button" class="menu-item" data-more="duplicate">Duplicate</button>',
    '  <button type="button" class="menu-item" data-more="move-up">Move up</button>',
    '  <button type="button" class="menu-item" data-more="move-down">Move down</button>',
    '  <div class="menu-sep"></div>',
    '  <button type="button" class="menu-item danger" data-more="delete">Delete</button>',
    '</div>',
    '<div class="toast"><span class="toast-msg"></span><button type="button" class="toast-undo" data-act="undo">Undo</button></div>',
  ].join('');

  const pinsLayer = shadow.querySelector('.pins');
  const selBox = shadow.querySelector('.sel-box');
  const flashBox = shadow.querySelector('.flash-box');
  const toolbar = shadow.querySelector('.toolbar');
  const labelEl = shadow.querySelector('.label');
  const parentBtn = shadow.querySelector('[data-act="parent"]');
  const linkElBtn = shadow.querySelector('[data-act="link-el"]');
  const imgReplaceBtn = shadow.querySelector('[data-act="img-replace"]');
  const imgAltBtn = shadow.querySelector('[data-act="img-alt"]');
  const styleBtn = shadow.querySelector('[data-act="style"]');
  const addBtn = shadow.querySelector('[data-act="add"]');
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
  const addPop = shadow.querySelector('.add-pop');
  const morePop = shadow.querySelector('.more-pop');

  const allPopovers = {
    link: linkPop,
    image: imgPop,
    alt: altPop,
    style: stylePop,
    add: addPop,
    more: morePop,
  };

  let toastTimer = null;
  function showToast(msg, withUndo) {
    toastMsg.textContent = msg;
    toastEl.classList.toggle('has-undo', Boolean(withUndo && clientUndoStack.length > 0));
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), withUndo ? 4500 : 2200);
  }

  function closePopovers() {
    openPopover = null;
    for (const key of Object.keys(allPopovers)) {
      allPopovers[key].classList.remove('open');
    }
  }

  function showPopover(name) {
    closePopovers();
    const pop = allPopovers[name];
    if (!pop) return;
    openPopover = name;
    pop.classList.add('open');
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
      } catch {}
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

  // ---------- Layout ----------

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
    toolbar.classList.toggle('touch', touchLayout);
    for (const key of Object.keys(allPopovers)) {
      allPopovers[key].classList.toggle('touch', touchLayout);
    }
    if (touchLayout) {
      const kb = keyboardBottomOffset();
      toolbar.style.bottom = kb + 'px';
      if (openPopover && allPopovers[openPopover]) {
        allPopovers[openPopover].style.bottom = kb + 'px';
      }
      return;
    }
    toolbar.style.bottom = '';
    const tw = toolbar.offsetWidth || 320;
    const th = toolbar.offsetHeight || 34;
    let top = r.top - th - 8;
    if (top < 8) {
      top = r.bottom + 8 <= window.innerHeight - th - 8 ? r.bottom + 8 : 8;
    }
    top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left));
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';

    if (openPopover && allPopovers[openPopover]) {
      const pop = allPopovers[openPopover];
      pop.style.bottom = '';
      const pw = pop.offsetWidth || 300;
      const ph = pop.offsetHeight || 200;
      const pLeft = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
      let pTop = top + th + 6;
      if (pTop + ph > window.innerHeight - 8) {
        pTop = Math.max(8, top - ph - 6);
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

  function renderToolbar() {
    if (!selEl) return;
    const tag = selEl.tagName.toLowerCase();
    const kind = friendlyKind(tag);
    const caps = (selInfo && selInfo.capabilities) || null;
    const ctx = (selInfo && selInfo.context) || null;
    const editable = Boolean(selInfo && selInfo.editability === 'editable-static');

    let badgeHtml = '';
    if (ctx && ctx.inLoopOrConditional) {
      badgeHtml = '<span class="ctx-badge warn" title="Inside a loop or conditional — text/attribute edits apply to repeated items; structural actions are disabled">Repeated</span>';
    } else if (ctx && ctx.isSharedFile) {
      badgeHtml = '<span class="ctx-badge info" title="Shared component or layout — edits appear across pages">Shared</span>';
    }

    let hint;
    if (!selInfo) hint = 'checking&hellip;';
    else if (activeEl === selEl) hint = 'editing';
    else if (workspaceLocked) hint = 'paused while Halley works';
    else if (editable) hint = 'click text to edit';
    else if (caps && caps.image && (caps.image.canEditSrc || caps.image.canEditAlt)) hint = 'image';
    else if (caps && caps.link && caps.link.canEdit) hint = 'link';
    else if (kind === 'Image') hint = 'ask Halley to replace';
    else hint = 'ask Halley to edit';

    const titleHtml = persona === 'developer'
      ? '<code>&lt;' + tag + '&gt;</code>'
      : '<b>' + kind + '</b>';
    labelEl.innerHTML = touchLayout ? (titleHtml + badgeHtml) : (titleHtml + badgeHtml + ' &middot; ' + hint);
    labelEl.title = selMeta ? (basename(selMeta.file) + (selInfo && selInfo.reason ? ' — ' + selInfo.reason : '')) : '';

    const canDirectMutate = Boolean(selInfo && !workspaceLocked && !readOnly);
    const showLinkEl = Boolean(canDirectMutate && caps && caps.link && caps.link.canEdit);
    const showImgReplace = Boolean(canDirectMutate && caps && caps.image && caps.image.canEditSrc);
    const showImgAlt = Boolean(canDirectMutate && caps && caps.image && caps.image.canEditAlt);
    const showStyle = Boolean(canDirectMutate && caps && caps.style && caps.style.canEdit);
    const st = caps && caps.structural;
    const showAdd = Boolean(canDirectMutate && st && st.canAddAfter);
    const showMore = Boolean(canDirectMutate && st && (st.canDuplicate || st.canMoveUp || st.canMoveDown || st.canDelete));

    linkElBtn.classList.toggle('hidden', !showLinkEl);
    imgReplaceBtn.classList.toggle('hidden', !showImgReplace);
    imgAltBtn.classList.toggle('hidden', !showImgAlt);
    styleBtn.classList.toggle('hidden', !showStyle);
    addBtn.classList.toggle('hidden', !showAdd);
    moreBtn.classList.toggle('hidden', !showMore);
    ctxSep.style.display = (showLinkEl || showImgReplace || showImgAlt || showStyle || showAdd || showMore) ? '' : 'none';

    const anyDirect = editable || showLinkEl || showImgReplace || showImgAlt || showStyle || showAdd || showMore;
    toolbar.classList.toggle('touch', touchLayout);
    toolbar.classList.toggle('can-edit', Boolean(editable && !workspaceLocked));
    toolbar.classList.toggle('editing', activeEl === selEl);
    selBox.classList.toggle('editable', Boolean(anyDirect));
    parentBtn.disabled = !mappedParent(selEl);
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
    } catch {}
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

  function beginEditing(el, meta, hash, point, initialHtml) {
    activeEl = el;
    activeMeta = meta;
    originalHtml = typeof initialHtml === 'string' ? initialHtml : el.innerHTML;
    expectedHash = hash;
    el.contentEditable = 'true';
    el.focus();
    placeCaret(el, point);
  }

  async function selectElement(el, meta, opts) {
    if (activeEl && activeEl !== el) await finishEditing(true);
    closePopovers();
    const preInspectHtml = el.innerHTML;
    meta = metaOf(el) || meta;
    selEl = el;
    selMeta = meta;
    selInfo = null;
    knownEls.set(keyOf(meta), el);
    const token = ++selToken;
    renderToolbar();
    const info = await inspect(meta);
    if (token !== selToken) return;
    selInfo = info;
    if (opts && opts.allowEdit && info.editability === 'editable-static') {
      if (workspaceLocked) showToast('Halley is updating files — you can still ask about this');
      else beginEditing(el, meta, info.snapshotHash, opts.point, preInspectHtml);
    }
    renderToolbar();
  }

  async function clearSelection(save) {
    selToken++;
    if (activeEl) await finishEditing(save);
    selEl = null;
    selMeta = null;
    selInfo = null;
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

  function rememberRange() {
    if (!activeEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (activeEl.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
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
    let cur = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
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
  }

  function removeInlineLink() {
    if (!activeEl) return;
    activeEl.focus();
    const range = restoreSelection() || (window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null);
    if (!range || !activeEl.contains(range.commonAncestorContainer)) return;
    const existing = findEnclosingTag(range.commonAncestorContainer, ['a'], activeEl);
    if (existing) unwrapNode(existing);
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

  async function loadRoutes() {
    if (cachedRoutes) return cachedRoutes;
    try {
      const res = await fetch(BASE + '/__editor/routes');
      const data = await res.json();
      cachedRoutes = Array.isArray(data.routes) ? data.routes : [];
    } catch {
      cachedRoutes = [];
    }
    return cachedRoutes;
  }

  function renderRoutes(filter) {
    const q = (filter || '').toLowerCase().trim();
    const items = (cachedRoutes || []).filter((r) =>
      r.route.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)
    ).slice(0, 8);
    routeList.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'route-item';
      btn.type = 'button';
      btn.textContent = item.route;
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
    } catch {
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
      empty.style.cssText = 'grid-column:1/-1;font-size:11px;color:#78716c;padding:8px 2px;';
      empty.textContent = 'No matching images found in public/images/';
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
      im.alt = item.filename;
      im.loading = 'lazy';
      const cap = document.createElement('span');
      cap.textContent = item.filename;
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
    } catch {
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
    } catch {
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
    } catch {
      showToast('Network error while saving');
      return null;
    }
  }

  // ---------- Popover Openers & Handlers ----------

  async function openLinkPopover(modeKind) {
    linkPopMode = modeKind;
    await loadRoutes();
    let existingHref = '';
    let existingNewTab = false;
    if (modeKind === 'element' && selInfo && selInfo.capabilities && selInfo.capabilities.link) {
      existingHref = selInfo.capabilities.link.href || '';
      existingNewTab = selInfo.capabilities.link.target === '_blank';
      linkPopTitle.textContent = 'Edit Link Destination';
      linkRemoveBtn.style.display = 'none';
    } else {
      linkPopTitle.textContent = 'Inline Link';
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
    showPopover('link');
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

  async function openImagePopover(modeKind) {
    imgPopMode = modeKind;
    imgPopTitle.textContent = modeKind === 'add-block' ? 'Insert Image Block' : 'Replace Image';
    imgSearch.value = '';
    showPopover('image');
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
    showToast('Uploading & optimizing image…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (selInfo && selInfo.capabilities && selInfo.capabilities.image && selInfo.capabilities.image.src) {
        fd.append('existingSrc', selInfo.capabilities.image.src);
      }
      const res = await fetch(BASE + '/__editor/upload-image', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.publicPath) {
        showToast(data.error || 'Image upload failed');
        return;
      }
      cachedImages = null;
      await handleChosenImage(data.publicPath, '');
    } catch {
      showToast('Network error uploading image');
    }
  }

  function openAltPopover() {
    const curAlt = (selInfo && selInfo.capabilities && selInfo.capabilities.image && selInfo.capabilities.image.alt) || (selEl && selEl.getAttribute('alt')) || '';
    altInput.value = curAlt;
    showPopover('alt');
    setTimeout(() => altInput.focus(), 10);
  }

  function openStylePopover() {
    const st = selInfo && selInfo.capabilities && selInfo.capabilities.style;
    if (!st || !st.canEdit) return;
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
    showPopover('style');
  }

  function openMorePopover() {
    const st = selInfo && selInfo.capabilities && selInfo.capabilities.structural;
    if (!st) return;
    morePop.querySelector('[data-more="duplicate"]').disabled = !st.canDuplicate;
    morePop.querySelector('[data-more="move-up"]').disabled = !st.canMoveUp;
    morePop.querySelector('[data-more="move-down"]').disabled = !st.canMoveDown;
    morePop.querySelector('[data-more="delete"]').disabled = !st.canDelete;
    showPopover('more');
  }

  // ---------- Toolbar & Popover Events ----------

  toolbar.addEventListener('pointerdown', (e) => { e.preventDefault(); });
  toolbar.addEventListener('click', (e) => {
    const act = e.target.closest && e.target.closest('button[data-act]');
    if (!act) return;
    const which = act.getAttribute('data-act');
    if (which === 'ask') void askHalley();
    else if (which === 'parent') void selectParent();
    else if (which === 'edit') {
      if (selEl && selMeta && selInfo && selInfo.editability === 'editable-static' && !workspaceLocked) {
        beginEditing(selEl, selMeta, selInfo.snapshotHash, null);
        renderToolbar();
      }
    } else if (which === 'done' || which === 'close') void clearSelection(true);
    else if (which === 'link-el') {
      if (openPopover === 'link') closePopovers();
      else void openLinkPopover('element');
    } else if (which === 'img-replace') {
      if (openPopover === 'image') closePopovers();
      else void openImagePopover('replace');
    } else if (which === 'img-alt') {
      if (openPopover === 'alt') closePopovers();
      else openAltPopover();
    } else if (which === 'style') {
      if (openPopover === 'style') closePopovers();
      else openStylePopover();
    } else if (which === 'add') {
      if (openPopover === 'add') closePopovers();
      else showPopover('add');
    } else if (which === 'more') {
      if (openPopover === 'more') closePopovers();
      else openMorePopover();
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
    else if (cmd === 'link') void openLinkPopover('inline');
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

  addPop.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-add]');
    if (!btn) return;
    const kind = btn.getAttribute('data-add');
    if (kind === 'image') {
      void openImagePopover('add-block');
      return;
    }
    closePopovers();
    void runMutation({ kind: 'add-block', blockKind: kind });
  });

  morePop.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-more]');
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute('data-more');
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
        body: JSON.stringify({ file: meta.file, loc: meta.loc, expectedHash, newHtml }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.innerHTML = prevHtml;
        showToast(data.error || 'Could not save edit');
        window.parent.postMessage({ type: 'halley:edit-error', message: data.error || 'Save failed' }, window.location.origin);
        return;
      }
      if (data.newHash) {
        expectedHash = data.newHash;
        if (selEl === el && selInfo) {
          selInfo = Object.assign({}, selInfo, {
            snapshotHash: data.newHash,
            outerSnapshotHash: data.newOuterHash || selInfo.outerSnapshotHash,
          });
        }
      }
      shiftSourceMapLines(
        meta.file,
        Number(data.topLineDelta || 0),
        Number(data.afterLine || 0),
        Number(data.afterLineDelta || 0),
        Number(data.sameLineEndCol || 0),
        Number(data.sameLineByteDelta || 0),
      );
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
    } catch {
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
    if (activeEl && activeEl.contains(e.target)) return;
    if (!touchLayout && selEl && selEl === e.target && selInfo && selInfo.editability === 'editable-static' && !activeEl && !workspaceLocked) {
      closePopovers();
      beginEditing(selEl, selMeta, selInfo.snapshotHash, { x: e.clientX, y: e.clientY });
      renderToolbar();
      return;
    }
    const found = findMappedElement(e.target);
    if (!found) { void clearSelection(true); return; }
    void selectElement(found.el, found.meta, { allowEdit: !touchLayout, point: { x: e.clientX, y: e.clientY } });
  }, true);

  document.addEventListener('selectionchange', rememberRange);

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
      if (!selEl) return;
      e.preventDefault();
      void clearSelection(true);
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
      void openLinkPopover('inline');
    }
  });

  document.addEventListener('focusout', () => {
    if (!activeEl) return;
    setTimeout(() => {
      if (!activeEl) return;
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
      else if (selEl) renderToolbar();
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
      } catch {}
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
  } catch {}
  window.parent.postMessage({ type: 'halley:ready', route: currentRoute() }, '*');
})();
`;
}
