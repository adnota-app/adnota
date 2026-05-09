// Injected via page.addInitScript at every navigation. Runs in the page's main
// world, so it cannot see the extension's content-script globals (FuzzyAnchor
// lives in the isolated world). Selector generation is therefore inlined here
// rather than reusing the extension's helper.
//
// Events stream out via console.log with the [ADNOTA_RECORD] prefix; the Node
// side listens via page.on('console'). This survives in-page navigations
// without any cross-page state.

(() => {
  if (window.__adnotaRecorderInstalled) return;
  window.__adnotaRecorderInstalled = true;

  const PREFIX = '[ADNOTA_RECORD]';

  // ─── In-page recording indicator ──────────────────────────────────────────
  // Tiny red pill top-left so the user can see at a glance that recording is
  // live, and watch it pulse on every meaningful event.
  const indicator = document.createElement('div');
  indicator.id = '__adnota-record-indicator';
  Object.assign(indicator.style, {
    position: 'fixed', top: '12px', left: '12px', zIndex: '2147483647',
    background: 'rgba(220, 38, 38, 0.92)', color: '#fff',
    padding: '4px 10px', borderRadius: '999px',
    font: '600 11px/1 ui-monospace,monospace',
    pointerEvents: 'none', userSelect: 'none',
    boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
    transition: 'transform 120ms',
  });
  indicator.textContent = '● REC';
  const attach = () => { if (document.body && !document.body.contains(indicator)) document.body.appendChild(indicator); };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  let pingTimer = null;
  function pingIndicator() {
    if (!indicator.isConnected) attach();
    indicator.style.transform = 'scale(1.15)';
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => { indicator.style.transform = 'scale(1)'; }, 120);
  }

  const send = (type, data) => {
    try {
      if (type !== 'pointermove') pingIndicator();
      console.log(PREFIX + JSON.stringify({ type, data, t: Date.now() }));
    } catch {
      // Some payloads can include unrepresentable values; we never put DOM
      // nodes in data, so swallow the safety net rather than spam errors.
    }
  };

  // ─── Selector generator (self-contained, no extension deps) ────────────────
  // Same priority order as the extension's FuzzyAnchor.generateCSSSelector but
  // without its scoring rig. Adnota UI surfaces are recognized so they emit
  // semantic selectors (data-tool-id, handle classes) rather than structural
  // paths.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;

    const dockBtn = el.closest('[data-tool-id]');
    if (dockBtn) return `[data-tool-id="${dockBtn.dataset.toolId}"]`;

    // Adnota's shared HUD buttons. The reducer recognizes these by selector
    // and translates clicks into dedicated ops (undo -> pressKey Ctrl+Z, etc.)
    // so they don't get dropped as "unrecognized Adnota UI".
    if (el.closest('.adnota-undo-btn')) return '.adnota-undo-btn';
    if (el.closest('.adnota-trash-btn')) return '.adnota-trash-btn';

    const handle = el.closest('[class^="adnota-resizer-handle-"], [class*=" adnota-resizer-handle-"]');
    if (handle) {
      const m = handle.className.match(/adnota-resizer-handle-(left|right|top|bottom|corner)/);
      if (m) return `.adnota-resizer-handle-${m[1]}`;
    }

    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
      return '#' + el.id;
    }

    const classes = [...(el.classList || [])].filter(c => /^[A-Za-z][\w-]+$/.test(c) && c.length < 40 && !c.startsWith('css-'));
    if (classes.length) {
      const sel = el.tagName.toLowerCase() + '.' + classes.join('.');
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 8) {
      const parent = cur.parentElement;
      if (!parent) break;
      if (parent.id && /^[A-Za-z][\w-]*$/.test(parent.id)) {
        const idx = [...parent.children].indexOf(cur) + 1;
        parts.unshift(`#${parent.id} > ${cur.tagName.toLowerCase()}:nth-child(${idx})`);
        return parts.join(' > ').replace(/^.*?(#[\w-]+ )/, '$1');
      }
      const idx = [...parent.children].indexOf(cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function cssEscape(s) {
    return CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&');
  }

  // ─── Event capture ─────────────────────────────────────────────────────────
  // All listeners run in capture phase + passive so we observe events without
  // interfering with any handlers downstream.

  let lastMove = 0;
  window.addEventListener('pointermove', (e) => {
    const now = e.timeStamp;
    if (now - lastMove < 60) return;
    lastMove = now;
    send('pointermove', { x: e.clientX, y: e.clientY, sel: selectorFor(e.target) });
  }, { capture: true, passive: true });

  window.addEventListener('pointerdown', (e) => {
    send('pointerdown', {
      x: e.clientX, y: e.clientY, button: e.button,
      sel: selectorFor(e.target),
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
    });
  }, { capture: true, passive: true });

  window.addEventListener('pointerup', (e) => {
    send('pointerup', {
      x: e.clientX, y: e.clientY, button: e.button,
      sel: selectorFor(e.target),
    });
    // After every pointerup, snapshot whether the resizer ended up with a
    // selection — and if so, what element it selected. The 80ms delay gives
    // the synthesized `click` event time to fire and the resizer's click
    // handler time to update its DOM. This is what makes Shift+Scroll-traversed
    // selections record correctly: we don't care HOW the user reached the
    // selection, only WHAT got selected.
    setTimeout(snapshotSelection, 80);
  }, { capture: true, passive: true });

  function snapshotSelection() {
    const box = document.querySelector('.adnota-resizer-selection');
    if (!box) {
      send('selectionState', { present: false });
      return;
    }
    const r = box.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      send('selectionState', { present: false });
      return;
    }
    // The selection box overlays the selected element. elementsFromPoint at
    // the box's center returns the stacked elements there — the first
    // non-Adnota-UI one is what the resizer is actually targeting.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const stack = document.elementsFromPoint(cx, cy);
    const target = stack.find(el => !el.closest('[data-adnota-ui]'));
    send('selectionState', {
      present: true,
      target: target ? {
        sel: selectorFor(target),
        text: (target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        w: Math.round(r.width),
        h: Math.round(r.height),
      } : null,
    });
  }

  window.addEventListener('keydown', (e) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const inField = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    send('keydown', {
      key: e.key,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
      inField,
      sel: selectorFor(e.target),
    });
  }, { capture: true, passive: true });

  // Modifier-bearing wheel events. The resizer interprets Shift+wheel as
  // explicit DOM-traversal ("walk to parent / child"), used to reach elements
  // that would otherwise be skipped by findLayoutTarget's auto-bubble (small
  // sub-120×60 elements, etc.). Plain wheels are page scroll and not recorded.
  //
  // Capture BOTH deltaY and deltaX: browsers swap the two axes when Shift is
  // held, so the actual signal is in whichever is non-zero. The reducer reads
  // `deltaY || deltaX` to compute the user's intended direction.
  window.addEventListener('wheel', (e) => {
    if (!e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return;
    send('wheel', {
      deltaY: e.deltaY,
      deltaX: e.deltaX,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
    });
  }, { capture: true, passive: true });

  // ─── Stop sentinel (Alt+Shift+S) ──────────────────────────────────────────
  // Provides a stop signal that doesn't fight Node's SIGINT handlers. We use a
  // non-passive listener so we can preventDefault and keep the host page from
  // seeing the combo.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopPropagation();
      indicator.textContent = '● saved';
      indicator.style.background = 'rgba(34, 197, 94, 0.92)';
      send('stop', {});
    }
  }, { capture: true });

  send('init', { url: location.href, viewport: { w: innerWidth, h: innerHeight } });
})();
