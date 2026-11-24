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

  // Two modes:
  //  - 'browse': the real site; Halley draws nothing and intercepts nothing.
  //  - 'edit':   zero hover boxes; a click *selects* an element and pins an action
  //              toolbar to it. Editable static text also gets an inline caret right
  //              away. Nothing is attached to chat until "Ask Halley…" is pressed.
  let mode = 'browse';
  let readOnly = false;
  let persona = 'non-technical';
  let workspaceLocked = false;

  // Current selection
  let selEl = null;
  let selMeta = null;
  let selInfo = null; // inspect result, null while inspecting
  let selToken = 0;

  // Inline editing (only ever the selected element)
  let activeEl = null;
  let activeMeta = null;
  let originalHtml = '';
  let expectedHash = '';
  let cachedRoutes = null;
  let savedRange = null;

  // Elements attached to chat (numbered markers, Edit mode only) + chip-hover highlight
  let pins = []; // [{ key, n }]
  let flashKey = null;
  const knownEls = new Map(); // key -> element

  // Edit-mode cursor stylesheet (pointer on mapped elements, text on active editable)
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
    '.toolbar { position: fixed; display: none; pointer-events: auto; align-items: center; gap: 2px; padding: 3px; background: #fff; border: 1px solid #e7e5e4; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06); }',
    '.toolbar.open { display: flex; }',
    '.label { font-size: 11px; color: #57534e; padding: 0 6px; max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.label b { font-weight: 600; color: #1c1917; }',
    '.label code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; font-weight: 600; color: #1c1917; }',
    '.fmt { display: none; align-items: center; gap: 2px; }',
    '.toolbar.editing .fmt { display: inline-flex; }',
    '.btn { border: none; background: transparent; color: #1c1917; font-size: 12px; font-weight: 600; padding: 5px 8px; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }',
    '.btn:hover { background: #f5f5f4; }',
    '.btn:disabled { opacity: 0.35; cursor: default; background: transparent; }',
    '.btn.primary { background: #1c1917; color: #fff; }',
    '.btn.primary:hover { background: #292524; }',
    '.btn.close { color: #78716c; padding: 5px 6px; font-size: 14px; line-height: 1; }',
    '.btn.close:hover { color: #1c1917; background: #f5f5f4; }',
    '.sep { width: 1px; height: 16px; background: #e7e5e4; margin: 0 2px; }',
    '.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: #1c1917; color: #fafaf9; font-size: 12px; font-weight: 500; padding: 7px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); opacity: 0; transition: opacity 150ms ease; pointer-events: none; }',
    '.toast.visible { opacity: 1; }',
    '.link-pop { position: fixed; display: none; pointer-events: auto; width: 290px; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,0.14); padding: 8px; }',
    '.link-pop.open { display: block; }',
    '.link-input { width: 100%; border: 1px solid #d6d3d1; border-radius: 6px; padding: 6px 8px; font-size: 12px; color: #1c1917; outline: none; }',
    '.link-input:focus { border-color: #d97706; }',
    '.route-list { max-height: 160px; overflow-y: auto; margin-top: 6px; }',
    '.route-item { width: 100%; text-align: left; border: none; background: transparent; padding: 5px 8px; border-radius: 5px; font-size: 12px; color: #292524; cursor: pointer; display: flex; justify-content: space-between; }',
    '.route-item:hover { background: #f5f5f4; }',
    '.link-actions { display: flex; justify-content: space-between; margin-top: 6px; padding-top: 6px; border-top: 1px solid #f5f5f4; }',
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
    '    <button class="btn" data-cmd="link" title="Link (Cmd+K)">Link</button>',
    '  </span>',
    '  <span class="sep"></span>',
    '  <button class="btn" data-act="parent" title="Select the surrounding block">&#8593; Parent</button>',
    '  <button class="btn primary" data-act="ask" title="Attach this to the chat box">Ask Halley&hellip;</button>',
    '  <button class="btn close" data-act="close" title="Close selection (Esc)" aria-label="Close selection">&times;</button>',
    '</div>',
    '<div class="link-pop">',
    '  <input class="link-input" type="text" placeholder="Search site pages or paste https://..." />',
    '  <div class="route-list"></div>',
    '  <div class="link-actions">',
    '    <button class="btn" data-link="remove" style="color:#b91c1c;">Remove link</button>',
    '    <button class="btn" data-link="apply" style="background:#1c1917;color:#fff;">Apply</button>',
    '  </div>',
    '</div>',
    '<div class="toast"></div>',
  ].join('');

  const pinsLayer = shadow.querySelector('.pins');
  const selBox = shadow.querySelector('.sel-box');
  const flashBox = shadow.querySelector('.flash-box');
  const toolbar = shadow.querySelector('.toolbar');
  const labelEl = shadow.querySelector('.label');
  const parentBtn = shadow.querySelector('[data-act="parent"]');
  const toastEl = shadow.querySelector('.toast');
  const linkPop = shadow.querySelector('.link-pop');
  const linkInput = shadow.querySelector('.link-input');
  const routeList = shadow.querySelector('.route-list');

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2200);
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

  // Resolve an attached element by key, surviving reloads by rescanning the DOM.
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

  // ---------- Layout (boxes follow scroll/reflow via a rAF loop while visible) ----------

  function place(box, r) {
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function placeToolbar(r) {
    const tw = toolbar.offsetWidth || 280;
    const th = toolbar.offsetHeight || 34;
    let top = r.top - th - 8;
    // Flip below if clipped at top; stick inside top of viewport if tall container spans screen
    if (top < 8) {
      top = r.bottom + 8 <= window.innerHeight - th - 8 ? r.bottom + 8 : 8;
    }
    top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left));
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
    if (linkPop.classList.contains('open')) {
      linkPop.style.left = Math.max(8, Math.min(window.innerWidth - 300, left)) + 'px';
      linkPop.style.top = (top + th + 6) + 'px';
    }
  }

  function layout() {
    if (mode === 'edit' && selEl && selEl.isConnected) {
      const r = selEl.getBoundingClientRect();
      selBox.style.display = 'block';
      place(selBox, r);
      toolbar.classList.add('open');
      placeToolbar(r);
    } else {
      selBox.style.display = 'none';
      toolbar.classList.remove('open');
      linkPop.classList.remove('open');
    }
    const flashEl = flashKey ? findByKey(flashKey) : null;
    if (flashEl) {
      flashBox.style.display = 'block';
      place(flashBox, flashEl.getBoundingClientRect());
    } else {
      flashBox.style.display = 'none';
    }
    // Pin outlines/badges are hidden in Browse mode so Browse stays 100% the unadorned site.
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

  // ---------- Toolbar ----------

  function mappedParent(el) {
    return el && el.parentElement ? findMappedElement(el.parentElement) : null;
  }

  function basename(f) { const i = f.lastIndexOf('/'); return i >= 0 ? f.slice(i + 1) : f; }

  function renderToolbar() {
    if (!selEl) return;
    const tag = selEl.tagName.toLowerCase();
    const kind = friendlyKind(tag);
    const editable = selInfo && selInfo.editability === 'editable-static';
    let hint;
    if (!selInfo) hint = 'checking&hellip;';
    else if (activeEl === selEl) hint = 'editing';
    else if (editable && workspaceLocked) hint = 'paused while Halley works';
    else if (editable) hint = 'click text to edit';
    else if (kind === 'Image') hint = 'ask Halley to replace';
    else hint = 'ask Halley to edit';
    const titleHtml = persona === 'developer'
      ? '<code>&lt;' + tag + '&gt;</code>'
      : '<b>' + kind + '</b>';
    labelEl.innerHTML = titleHtml + ' &middot; ' + hint;
    labelEl.title = selMeta ? (basename(selMeta.file) + (selInfo && selInfo.reason ? ' — ' + selInfo.reason : '')) : '';
    toolbar.classList.toggle('editing', activeEl === selEl);
    selBox.classList.toggle('editable', Boolean(editable));
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

  function beginEditing(el, meta, hash, point) {
    activeEl = el;
    activeMeta = meta;
    originalHtml = el.innerHTML;
    expectedHash = hash;
    el.contentEditable = 'true';
    el.focus();
    placeCaret(el, point);
  }

  async function selectElement(el, meta, opts) {
    if (activeEl && activeEl !== el) await finishEditing(true);
    selEl = el;
    selMeta = meta;
    selInfo = null;
    knownEls.set(keyOf(meta), el);
    const token = ++selToken;
    renderToolbar();
    const info = await inspect(meta);
    if (token !== selToken) return;
    selInfo = info;
    if (opts.allowEdit && info.editability === 'editable-static') {
      if (workspaceLocked) showToast('Halley is updating files — you can still ask about this');
      else beginEditing(el, meta, info.snapshotHash, opts.point);
    }
    renderToolbar();
  }

  async function clearSelection(save) {
    selToken++;
    if (activeEl) await finishEditing(save);
    selEl = null;
    selMeta = null;
    selInfo = null;
    linkPop.classList.remove('open');
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
    // Save any pending inline edit first so Halley sees the latest file.
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

  // Keep focus/selection in the page when pressing toolbar buttons.
  toolbar.addEventListener('mousedown', (e) => { e.preventDefault(); });
  toolbar.addEventListener('click', (e) => {
    const act = e.target.closest && e.target.closest('button[data-act]');
    if (!act) return;
    const which = act.getAttribute('data-act');
    if (which === 'ask') void askHalley();
    else if (which === 'parent') void selectParent();
    else if (which === 'close') void clearSelection(true);
  });

  // ---------- Inline formatting + links ----------

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
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        linkInput.value = item.route;
        applyLink();
      });
      routeList.appendChild(btn);
    }
  }

  function rememberRange() {
    if (!activeEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (activeEl.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
  }

  function restoreSelection() {
    if (!savedRange) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  function applyLink() {
    const raw = linkInput.value.trim();
    linkPop.classList.remove('open');
    if (!activeEl) return;
    activeEl.focus();
    restoreSelection();
    if (!raw) return;
    const href = raw.startsWith('/') && !raw.startsWith('//') ? (BASE + raw) : raw;
    document.execCommand('createLink', false, href);
  }

  async function openLinkPop() {
    if (!activeEl) return;
    await loadRoutes();
    const sel = window.getSelection();
    let existingHref = '';
    if (sel && sel.anchorNode) {
      const n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      const a = n && n.closest ? n.closest('a') : null;
      if (a) {
        existingHref = a.getAttribute('href') || '';
        if (BASE && existingHref.startsWith(BASE)) existingHref = existingHref.slice(BASE.length) || '/';
      }
    }
    linkInput.value = existingHref;
    renderRoutes('');
    linkPop.classList.add('open');
    layout();
    setTimeout(() => linkInput.focus(), 10);
  }

  shadow.querySelector('.fmt').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-cmd]');
    if (!btn || !activeEl) return;
    const cmd = btn.getAttribute('data-cmd');
    restoreSelection();
    if (cmd === 'bold') document.execCommand('bold', false);
    else if (cmd === 'italic') document.execCommand('italic', false);
    else if (cmd === 'link') void openLinkPop();
  });

  linkInput.addEventListener('input', () => renderRoutes(linkInput.value));
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      linkPop.classList.remove('open');
      if (activeEl) activeEl.focus();
    }
  });
  shadow.querySelector('[data-link="apply"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    applyLink();
  });
  shadow.querySelector('[data-link="remove"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    linkPop.classList.remove('open');
    if (activeEl) activeEl.focus();
    restoreSelection();
    document.execCommand('unlink', false);
  });

  async function finishEditing(save) {
    if (!activeEl || !activeMeta) return;
    const el = activeEl;
    const meta = activeMeta;
    const newHtml = el.innerHTML;
    el.contentEditable = 'false';
    activeEl = null;
    activeMeta = null;
    savedRange = null;
    linkPop.classList.remove('open');
    if (selEl === el) renderToolbar();

    if (!save || newHtml === originalHtml) {
      if (!save) el.innerHTML = originalHtml;
      return;
    }

    try {
      const res = await fetch(BASE + '/__editor/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: meta.file, loc: meta.loc, expectedHash, newHtml }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.innerHTML = originalHtml;
        showToast(data.error || 'Could not save edit');
        window.parent.postMessage({ type: 'halley:edit-error', message: data.error || 'Save failed' }, '*');
        return;
      }
      showToast('Saved');
      window.parent.postMessage({
        type: 'halley:patch-saved',
        file: meta.file,
        loc: meta.loc,
        summary: 'Edited ' + meta.file,
      }, '*');
    } catch {
      el.innerHTML = originalHtml;
      showToast('Network error while saving');
    }
  }

  // ---------- Pointer & keyboard handling ----------

  document.addEventListener('click', (e) => {
    if (mode !== 'edit' || readOnly) return;
    if (e.target === host || host.contains(e.target)) return;
    // Cmd/Ctrl-click follows links without leaving Edit mode.
    if ((e.metaKey || e.ctrlKey) && e.target.closest && e.target.closest('a[href]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (activeEl && activeEl.contains(e.target)) return; // caret moves natively
    // Re-clicking an already-selected editable element whose caret blurred re-enters editing.
    if (selEl && selEl === e.target && selInfo && selInfo.editability === 'editable-static' && !activeEl && !workspaceLocked) {
      beginEditing(selEl, selMeta, selInfo.snapshotHash, { x: e.clientX, y: e.clientY });
      renderToolbar();
      return;
    }
    const found = findMappedElement(e.target);
    if (!found) { void clearSelection(true); return; }
    void selectElement(found.el, found.meta, { allowEdit: true, point: { x: e.clientX, y: e.clientY } });
  }, true);

  document.addEventListener('selectionchange', rememberRange);

  document.addEventListener('keydown', (e) => {
    if (mode !== 'edit') return;
    if (e.key === 'Escape') {
      if (linkPop.classList.contains('open')) {
        e.preventDefault();
        linkPop.classList.remove('open');
        if (activeEl) activeEl.focus();
        return;
      }
      if (!selEl) return;
      e.preventDefault();
      // Never discard typed edits on Esc — save and dismiss selection (Cmd+Z / Undo handles reverts).
      void clearSelection(true);
      return;
    }
    if (!activeEl) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 's') {
      e.preventDefault();
      void finishEditing(true);
    } else if ((e.metaKey || e.ctrlKey) && k === 'k') {
      e.preventDefault();
      void openLinkPop();
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

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'halley:set-mode') {
      readOnly = Boolean(msg.readOnly);
      if (msg.persona) persona = msg.persona;
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
