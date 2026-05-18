// Developer tool. Captures a curated DOM/style snapshot of the page plus
// any Adnota tool state, then copies a JSON bundle to the clipboard for
// pasting into Claude Code while iterating on heuristics.
//
//   Hotkey:   Cmd+Shift+K  (Mac) / Ctrl+Shift+K  (Win/Linux)
//   Console:  window.adnotaDebugCapture("optional label")
//
// On every capture you'll get: green outline flash on the captured element,
// a top-right toast naming the target and bundle size, and a console.log of
// the full bundle for inspection.
//
// Tools may register richer state under window.__adnotaDebug.tools[name] =
// () => stateObject. Whatever they return is included verbatim in the bundle.

(function () {
  if (window.__adnotaDebugCaptureLoaded) return;
  window.__adnotaDebugCaptureLoaded = true;

  // Gate everything on the shared `adnotaDebugLog` flag (same flag that
  // controls AdnotaLog). Default off, so end users don't get a hotkey
  // installed on every page or a "[adnota debug] capture loaded" line in
  // their console. Developers flip the flag once in
  // chrome.storage.local and reload the tab to opt in. Read-once at script
  // load (no live toggle) so the listener state is deterministic for the
  // tab's lifetime — a developer who flips the flag mid-session just
  // reloads.
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  chrome.storage.local.get(['adnotaDebugLog'], (result) => {
    if (chrome.runtime.lastError) return;
    if (!result?.adnotaDebugLog) return;
    install();
  });

  function install() {

  const BUNDLE_VERSION = 1;

  // Edit this to rebind. e.code is the physical key, so it survives Alt
  // remapping (e.g. Mac Alt+C → ç) and non-US layouts.
  const HOTKEY = { code: 'KeyK', shift: true, meta: true, alt: false };

  const STYLE_PROPS = [
    'display', 'position',
    'overflow-x', 'overflow-y',
    'contain', 'isolation',
    'transform', 'transform-origin',
    'z-index', 'will-change',
    'visibility', 'opacity',
    'height', 'width',
    'max-height', 'max-width', 'min-height', 'min-width',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'box-sizing', 'float', 'clear',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  ];

  // Pruning: properties whose value carries no signal when it equals the
  // listed default(s) are omitted from each element's computed map. Lossless
  // for heuristic debugging — anything interesting still appears. Properties
  // not listed (display, height, width) are always kept.
  const DEFAULT_OMIT = {
    'position': ['static'],
    'overflow-x': ['visible'],
    'overflow-y': ['visible'],
    'contain': ['none', 'normal'],
    'isolation': ['auto'],
    'transform': ['none'],
    'z-index': ['auto'],
    'will-change': ['auto'],
    'visibility': ['visible'],
    'opacity': ['1'],
    'max-height': ['none'],
    'max-width': ['none'],
    'min-height': ['0px', 'auto'],
    'min-width': ['0px', 'auto'],
    'margin-top': ['0px'],
    'margin-right': ['0px'],
    'margin-bottom': ['0px'],
    'margin-left': ['0px'],
    'padding-top': ['0px'],
    'padding-right': ['0px'],
    'padding-bottom': ['0px'],
    'padding-left': ['0px'],
    'box-sizing': ['content-box'],
    'float': ['none'],
    'clear': ['none'],
    'border-top-width': ['0px'],
    'border-right-width': ['0px'],
    'border-bottom-width': ['0px'],
    'border-left-width': ['0px'],
  };

  const ANCESTOR_CAP = 30;

  window.__adnotaDebug = window.__adnotaDebug || { tools: {} };

  let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  document.addEventListener('mousemove', (e) => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
  }, { capture: true, passive: true });

  function isAdnotaElement(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const id = cur.id || '';
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (id.indexOf('adnota') !== -1 || cls.indexOf('adnota') !== -1) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function targetAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const el of stack) {
      if (!isAdnotaElement(el)) return el;
    }
    return document.body;
  }

  function stableId(id) {
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(id) && !/[0-9a-f]{8,}/i.test(id);
  }

  function selectorStep(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableId(el.id)) return tag + '#' + el.id;
    const parent = el.parentElement;
    if (!parent) return tag;
    let nth = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) nth++;
      sib = sib.previousElementSibling;
    }
    const sameTagSiblings = parent.children
      ? Array.from(parent.children).filter(c => c.tagName === el.tagName).length
      : 1;
    return sameTagSiblings > 1 ? `${tag}:nth-of-type(${nth})` : tag;
  }

  function buildSelector(el) {
    if (el === document.documentElement) return 'html';
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < ANCESTOR_CAP) {
      parts.unshift(selectorStep(cur));
      if (cur.id && stableId(cur.id)) break;
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function isScrollContainer(el, cs) {
    const ox = cs.getPropertyValue('overflow-x');
    const oy = cs.getPropertyValue('overflow-y');
    const scrollable = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
    const scrollY = scrollable(oy) && el.scrollHeight > el.clientHeight + 1;
    const scrollX = scrollable(ox) && el.scrollWidth > el.clientWidth + 1;
    return { scrollY, scrollX, anyScroll: scrollX || scrollY };
  }

  function snapshotElement(el) {
    const cs = getComputedStyle(el);
    const computed = {};
    for (const prop of STYLE_PROPS) {
      const val = cs.getPropertyValue(prop);
      const defaults = DEFAULT_OMIT[prop];
      if (defaults && defaults.indexOf(val) !== -1) continue;
      // transform-origin is noise unless transform itself is non-default
      if (prop === 'transform-origin' && computed.transform === undefined) continue;
      computed[prop] = val;
    }
    const r = el.getBoundingClientRect();
    const scroll = isScrollContainer(el, cs);
    const classes = typeof el.className === 'string'
      ? el.className.split(/\s+/).filter(Boolean)
      : [];
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes,
      selector: buildSelector(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left },
      inline_style: el.getAttribute('style') || '',
      computed,
      is_scroll_container: scroll.anyScroll,
      scroll_axes: scroll.anyScroll ? { x: scroll.scrollX, y: scroll.scrollY } : null,
      scroll_position: scroll.anyScroll ? { left: el.scrollLeft, top: el.scrollTop } : null,
    };
  }

  function ancestorChain(el) {
    const chain = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < ANCESTOR_CAP) {
      chain.push(snapshotElement(cur));
      cur = cur.parentElement;
      depth++;
    }
    if (document.documentElement) chain.push(snapshotElement(document.documentElement));
    return chain;
  }

  function detectActiveAdnotaSurfaces() {
    const found = new Set();
    const all = document.querySelectorAll('[class*="adnota"], [id*="adnota"]');
    for (const el of all) {
      const id = el.id || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      // Split on whitespace only (NOT hyphens) so "adnota-shift-mode" stays
      // intact instead of collapsing to just "adnota".
      const tokens = (id + ' ' + cls).split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (t.indexOf('adnota') !== -1) found.add(t);
      }
      if (found.size > 40) break;
    }
    return Array.from(found);
  }

  function collectToolStates() {
    const out = {};
    const reg = (window.__adnotaDebug && window.__adnotaDebug.tools) || {};
    for (const name of Object.keys(reg)) {
      try {
        const fn = reg[name];
        out[name] = typeof fn === 'function' ? fn() : fn;
      } catch (err) {
        out[name] = { __error: String(err && err.message || err) };
      }
    }
    return out;
  }

  function manifestVersion() {
    try {
      return chrome?.runtime?.getManifest?.().version || null;
    } catch (_) { return null; }
  }

  function build(target, label) {
    return {
      version: BUNDLE_VERSION,
      captured_at: new Date().toISOString(),
      label: label || '',
      site: {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
        document: {
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
      },
      cursor: { x: lastPointer.x, y: lastPointer.y },
      target: snapshotElement(target),
      ancestors: ancestorChain(target.parentElement || document.body),
      adnota_surfaces: detectActiveAdnotaSurfaces(),
      tool_state: collectToolStates(),
      extension_version: manifestVersion(),
      user_agent: navigator.userAgent,
    };
  }

  function describeTarget(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const firstClass = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/).filter(Boolean)[0];
    const cls = firstClass ? '.' + firstClass : '';
    return tag + id + cls;
  }

  function flashOutline(el) {
    if (!el || el === document.documentElement) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    // Overlay div — never mutates the captured element, so its inline_style
    // stays clean and re-captures within the flash window are unaffected.
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:absolute',
      `top:${r.top + window.scrollY - 3}px`,
      `left:${r.left + window.scrollX - 3}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      'border:3px solid #4ade80',
      'box-sizing:content-box',
      'border-radius:2px',
      'pointer-events:none',
      'z-index:2147483646',
    ].join(';');
    document.documentElement.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1500);
  }

  function flashToast(lines, ok) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px',
      'z-index:2147483647', 'pointer-events:none',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'padding:12px 16px', 'border-radius:8px',
      'background:' + (ok ? 'rgba(20,80,40,0.95)' : 'rgba(120,30,30,0.95)'),
      'color:#fff', 'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
      'max-width:380px', 'white-space:pre-line',
      'border:1px solid rgba(255,255,255,0.15)',
    ].join(';');
    el.textContent = Array.isArray(lines) ? lines.join('\n') : lines;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function capture(label) {
    // Pin target at hotkey-press time so it can't drift while the user
    // types into the prompt.
    const target = targetAtPoint(lastPointer.x, lastPointer.y);
    if (typeof label !== 'string' || label.length === 0) {
      label = window.prompt('Adnota debug capture — describe the issue (one line):', '') || '';
    }
    const bundle = build(target, label);
    flashOutline(target);
    const json = JSON.stringify(bundle, null, 2);
    const sizeKB = (json.length / 1024).toFixed(1);
    console.log('[adnota debug] captured:', bundle);
    try {
      await navigator.clipboard.writeText(json);
      flashToast([
        'Adnota: captured ' + describeTarget(target),
        sizeKB + ' KB on clipboard — paste into Claude Code',
      ], true);
    } catch (err) {
      console.error('[adnota debug] clipboard write failed', err);
      flashToast([
        'Clipboard write blocked',
        'Bundle is in console — copy from there',
      ], false);
    }
    return bundle;
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== HOTKEY.code) return;
    if (HOTKEY.shift !== e.shiftKey) return;
    if (HOTKEY.alt !== e.altKey) return;
    const meta = e.metaKey || e.ctrlKey;
    if (HOTKEY.meta !== meta) return;
    e.preventDefault();
    e.stopPropagation();
    capture();
  }, true);

  window.adnotaDebugCapture = capture;

  console.log('[adnota debug] capture loaded — Cmd/Ctrl+Shift+K, or window.adnotaDebugCapture()');
  } // end install()
})();
