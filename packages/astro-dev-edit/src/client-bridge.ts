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
  return `
(() => {
  const BASE = ${baseLiteral};
  const sourceMap = window.__HALLEY_SOURCE_MAP__ || new WeakMap();

  let mode = 'browse'; // 'browse' | 'edit' | 'select'
  let readOnly = false;
  let workspaceLocked = false;
  let activeEl = null;
  let activeMeta = null;
  let originalHtml = '';
  let expectedHash = '';
  let cachedRoutes = null;
  let savedRange = null;

  // Shadow DOM host for Halley overlay + Notion-style Bubble Menu
  const host = document.createElement('div');
  host.id = '__halley-bridge-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = \`
    <style>
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .hover-box {
        position: fixed; pointer-events: none; display: none;
        border: 1.5px solid #d97706; background: rgba(217,119,6,0.06);
        border-radius: 4px; transition: all 60ms ease-out;
      }
      .hover-tag {
        position: absolute; top: -20px; left: -1.5px;
        background: #1c1917; color: #fafaf9; font-size: 10px; font-weight: 600;
        padding: 2px 6px; border-radius: 4px; white-space: nowrap;
        letter-spacing: 0.02em;
      }
      .toast {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        background: #1c1917; color: #fafaf9; font-size: 12px; font-weight: 500;
        padding: 7px 14px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        opacity: 0; transition: opacity 150ms ease; pointer-events: none;
      }
      .toast.visible { opacity: 1; }
      .bubble {
        position: fixed; display: none; pointer-events: auto;
        background: #ffffff; border: 1px solid #e7e5e4; border-radius: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06);
        padding: 4px; gap: 2px; align-items: center;
      }
      .bubble.open { display: flex; }
      .btn {
        border: none; background: transparent; color: #1c1917;
        font-size: 12px; font-weight: 600; padding: 5px 8px; border-radius: 5px;
        cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
      }
      .btn:hover { background: #f5f5f4; }
      .btn.active { background: #fef3c7; color: #92400e; }
      .sep { width: 1px; height: 16px; background: #e7e5e4; margin: 0 2px; }
      .link-pop {
        position: fixed; display: none; pointer-events: auto; width: 290px;
        background: #ffffff; border: 1px solid #e7e5e4; border-radius: 10px;
        box-shadow: 0 14px 36px rgba(0,0,0,0.14); padding: 8px;
      }
      .link-pop.open { display: block; }
      .link-input {
        width: 100%; border: 1px solid #d6d3d1; border-radius: 6px;
        padding: 6px 8px; font-size: 12px; color: #1c1917; outline: none;
      }
      .link-input:focus { border-color: #d97706; }
      .route-list { max-height: 160px; overflow-y: auto; margin-top: 6px; }
      .route-item {
        width: 100%; text-align: left; border: none; background: transparent;
        padding: 5px 8px; border-radius: 5px; font-size: 12px; color: #292524;
        cursor: pointer; display: flex; justify-content: space-between;
      }
      .route-item:hover { background: #f5f5f4; }
      .link-actions { display: flex; justify-content: space-between; margin-top: 6px; padding-top: 6px; border-top: 1px solid #f5f5f4; }
    </style>
    <div class="hover-box"><div class="hover-tag"></div></div>
    <div class="bubble" role="toolbar" aria-label="Text formatting">
      <button class="btn" data-cmd="bold" title="Bold (Cmd+B)"><strong>B</strong></button>
      <button class="btn" data-cmd="italic" title="Italic (Cmd+I)"><em>I</em></button>
      <div class="sep"></div>
      <button class="btn" data-cmd="link" title="Link (Cmd+K)">Link</button>
    </div>
    <div class="link-pop">
      <input class="link-input" type="text" placeholder="Search site pages or paste https://..." />
      <div class="route-list"></div>
      <div class="link-actions">
        <button class="btn" data-link="remove" style="color:#b91c1c;">Remove link</button>
        <button class="btn" data-link="apply" style="background:#1c1917;color:#fff;">Apply</button>
      </div>
    </div>
    <div class="toast"></div>
  \`;

  const hoverBox = shadow.querySelector('.hover-box');
  const hoverTag = shadow.querySelector('.hover-tag');
  const toastEl = shadow.querySelector('.toast');
  const bubble = shadow.querySelector('.bubble');
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

  function findMappedElement(target) {
    let cur = target;
    while (cur && cur !== document.documentElement) {
      if (cur === host) return null;
      const meta = sourceMap.get(cur);
      if (meta) return { el: cur, meta };
      const file = cur.getAttribute && cur.getAttribute('data-astro-source-file');
      const loc = cur.getAttribute && cur.getAttribute('data-astro-source-loc');
      if (file && loc) {
        const m = { file, loc };
        sourceMap.set(cur, m);
        return { el: cur, meta: m };
      }
      cur = cur.parentElement;
    }
    return null;
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
      btn.innerHTML = '<span>' + item.route + '</span>';
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        linkInput.value = item.route;
        applyLink();
      });
      routeList.appendChild(btn);
    }
  }

  function closeMenus() {
    bubble.classList.remove('open');
    linkPop.classList.remove('open');
  }

  function positionBubble() {
    if (!activeEl) return closeMenus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (!linkPop.classList.contains('open')) bubble.classList.remove('open');
      return;
    }
    const range = sel.getRangeAt(0);
    if (!activeEl.contains(range.commonAncestorContainer)) {
      bubble.classList.remove('open');
      return;
    }
    savedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    bubble.classList.add('open');
    const bw = bubble.offsetWidth || 160;
    const left = Math.max(8, Math.min(window.innerWidth - bw - 8, rect.left + rect.width / 2 - bw / 2));
    const top = Math.max(8, rect.top - 42);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
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
    positionBubble();
  }

  bubble.addEventListener('mousedown', async (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    const cmd = btn.getAttribute('data-cmd');
    if (!activeEl) return;
    restoreSelection();
    if (cmd === 'bold') {
      document.execCommand('bold', false);
    } else if (cmd === 'italic') {
      document.execCommand('italic', false);
    } else if (cmd === 'link') {
      await loadRoutes();
      const sel = window.getSelection();
      let existingHref = '';
      if (sel && sel.anchorNode) {
        const a = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('a');
        if (a) {
          existingHref = a.getAttribute('href') || '';
          if (BASE && existingHref.startsWith(BASE)) {
            existingHref = existingHref.slice(BASE.length) || '/';
          }
        }
      }
      linkInput.value = existingHref;
      renderRoutes('');
      const rect = bubble.getBoundingClientRect();
      linkPop.style.left = Math.max(8, Math.min(window.innerWidth - 300, rect.left)) + 'px';
      linkPop.style.top = (rect.bottom + 6) + 'px';
      linkPop.classList.add('open');
      setTimeout(() => linkInput.focus(), 10);
    }
  });

  linkInput.addEventListener('input', () => renderRoutes(linkInput.value));
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      linkPop.classList.remove('open');
      activeEl?.focus();
    }
  });
  shadow.querySelector('[data-link="apply"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    applyLink();
  });
  shadow.querySelector('[data-link="remove"]').addEventListener('mousedown', (e) => {
    e.preventDefault();
    linkPop.classList.remove('open');
    activeEl?.focus();
    restoreSelection();
    document.execCommand('unlink', false);
  });

  async function finishEditing(save) {
    if (!activeEl || !activeMeta) return;
    const el = activeEl;
    const meta = activeMeta;
    const newHtml = el.innerHTML;
    el.contentEditable = 'false';
    el.style.outline = '';
    activeEl = null;
    activeMeta = null;
    closeMenus();

    if (!save || newHtml === originalHtml) {
      if (!save) el.innerHTML = originalHtml;
      return;
    }

    try {
      const res = await fetch(BASE + '/__editor/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: meta.file,
          loc: meta.loc,
          expectedHash,
          newHtml,
        }),
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

  document.addEventListener('mousemove', (e) => {
    if (mode === 'browse' || readOnly || activeEl) {
      hoverBox.style.display = 'none';
      return;
    }
    const found = findMappedElement(e.target);
    if (!found) {
      hoverBox.style.display = 'none';
      return;
    }
    const r = found.el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px';
    hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';
    hoverTag.textContent = mode === 'select' ? ('Select <' + found.el.tagName.toLowerCase() + '>') : ('<' + found.el.tagName.toLowerCase() + '>');
  }, { passive: true });

  document.addEventListener('click', async (e) => {
    if (mode === 'browse' || readOnly) return;
    if (e.target === host || host.contains(e.target)) return;
    if (activeEl && activeEl.contains(e.target)) return;

    const found = findMappedElement(e.target);
    if (!found) return;
    e.preventDefault();
    e.stopPropagation();

    if (activeEl) {
      await finishEditing(true);
    }

    if (workspaceLocked) {
      showToast('Halley is updating files — please wait a moment');
      return;
    }

    const { el, meta } = found;
    if (mode === 'select') {
      window.parent.postMessage({
        type: 'halley:element-context',
        context: {
          file: meta.file,
          loc: meta.loc,
          route: currentRoute(),
          tagName: el.tagName.toLowerCase(),
          renderedText: (el.innerText || '').trim().slice(0, 300),
          outerHTML: el.outerHTML.slice(0, 1200),
          reason: 'selected',
        },
      }, '*');
      showToast('Attached to chat');
      return;
    }

    // Edit Mode: inspect AST editability
    try {
      const res = await fetch(BASE + '/__editor/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: meta.file, loc: meta.loc }),
      });
      const data = await res.json();
      if (data.editability === 'editable-static') {
        activeEl = el;
        activeMeta = meta;
        originalHtml = el.innerHTML;
        expectedHash = data.snapshotHash;
        hoverBox.style.display = 'none';
        el.contentEditable = 'true';
        el.style.outline = '2px solid #d97706';
        el.style.outlineOffset = '2px';
        el.focus();
      } else {
        window.parent.postMessage({
          type: 'halley:element-context',
          context: {
            file: meta.file,
            loc: meta.loc,
            route: currentRoute(),
            tagName: el.tagName.toLowerCase(),
            renderedText: (el.innerText || '').trim().slice(0, 300),
            outerHTML: el.outerHTML.slice(0, 1200),
            reason: 'dynamic',
          },
        }, '*');
        showToast('Managed by site data — attached to chat');
      }
    } catch {
      showToast('Could not inspect element');
    }
  }, true);

  document.addEventListener('selectionchange', () => {
    if (activeEl) positionBubble();
  });

  document.addEventListener('keydown', (e) => {
    if (!activeEl) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      finishEditing(true);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      bubble.querySelector('[data-cmd="link"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishEditing(false);
    }
  });

  document.addEventListener('focusout', (e) => {
    if (!activeEl) return;
    setTimeout(() => {
      if (!activeEl) return;
      const focused = document.activeElement;
      if (focused === activeEl || activeEl.contains(focused) || focused === host || shadow.contains(shadow.activeElement)) {
        return;
      }
      finishEditing(true);
    }, 120);
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'halley:set-mode') {
      readOnly = Boolean(msg.readOnly);
      mode = readOnly ? 'browse' : (msg.mode || 'browse');
      if (mode === 'browse' && activeEl) finishEditing(true);
      hoverBox.style.display = 'none';
    } else if (msg.type === 'halley:lock') {
      workspaceLocked = Boolean(msg.locked);
      if (workspaceLocked && activeEl) {
        finishEditing(false);
        showToast('Halley is editing this page…');
      }
    } else if (msg.type === 'halley:reload') {
      window.location.reload();
    }
  });

  window.addEventListener('popstate', notifyRoute);
  document.addEventListener('astro:page-load', notifyRoute);
  notifyRoute();
  window.parent.postMessage({ type: 'halley:ready', route: currentRoute() }, '*');
})();
`;
}
