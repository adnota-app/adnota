// popup/popup.js

document.addEventListener('DOMContentLoaded', async () => {
  const btnClearPage  = document.getElementById('btn-clear-page');
  const btnClearSite  = document.getElementById('btn-clear-site');
  const btnVisibility = document.getElementById('btn-visibility');
  const btnMySites    = document.getElementById('btn-my-sites');
  const brand         = document.querySelector('.brand');

  // ─── Open the Sites history page ──────────────────────────────────────────
  function openSites() {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/sites.html') });
    window.close();
  }
  btnMySites.addEventListener('click', openSites);
  brand.addEventListener('click', openSites);

  // ─── Bug-report mailto with diagnostic prefill ────────────────────────────
  // Triage email with extension version + UA + active page URL pre-attached.
  // User reviews the body in their mail client before sending and can edit
  // or strip anything they don't want to share — opt-in by definition, since
  // nothing leaves the machine without their explicit send.
  //
  // Routed through chrome.tabs.create instead of the `<a href>`'s default
  // navigation: an extension popup closes the moment focus shifts to launch
  // the mail handler, and Chrome can't always reconcile the resulting
  // navigation as a user-gesture-bound action — surfacing as the "user
  // gesture is required" warning. chrome.tabs.create is a privileged
  // extension API that hands the URL to the OS handler cleanly.
  (() => {
    const link = document.getElementById('bug-link');
    if (!link) return;

    let mailtoHref = link.getAttribute('href');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let activeUrl = 'n/a';
      let activeHost = 'n/a';
      try {
        if (tabs[0]?.url) {
          activeUrl = tabs[0].url;
          activeHost = new URL(tabs[0].url).hostname || 'n/a';
        }
      } catch {}
      const version = chrome.runtime.getManifest().version;
      const body = [
        'Describe what went wrong:',
        '',
        '',
        '---',
        `Extension: ${version}`,
        `Browser: ${navigator.userAgent}`,
        `URL: ${activeUrl}`,
        `Host: ${activeHost}`,
      ].join('\n');
      const subject = encodeURIComponent('Adnota bug');
      mailtoHref = `mailto:support@adnota.app?subject=${subject}&body=${encodeURIComponent(body)}`;
      link.setAttribute('href', mailtoHref);
    });

    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: mailtoHref, active: false });
      window.close();
    });
  })();

  // ─── Utility: mark the active tool card by mode string ───────────────────
  function setActiveCard(mode) {
    document.querySelectorAll('.tool-card').forEach(c => c.classList.remove('active'));
    if (!mode) return;
    document.querySelectorAll('.tool-card[data-mode]').forEach(card => {
      // data-mode can be a space-separated list, e.g. "highlight pen"
      if (card.dataset.mode.split(' ').includes(mode)) {
        card.classList.add('active');
      }
    });
  }

  // ─── Tool card clicks — activate the tool and close the popup ─────────────
  function activateTool(action) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) return;
      chrome.tabs.sendMessage(tabs[0].id, { action }, () => {
        void chrome.runtime.lastError;
        window.close();
      });
    });
  }

  document.querySelectorAll('.tool-card[data-action]').forEach(card => {
    card.addEventListener('click', () => activateTool(card.dataset.action));
  });

  // ─── Bare-key shortcuts (mirror content/dock.js) ──────────────────────────
  // The dock-visible gate doesn't apply here — popup being open IS the modal
  // indicator, and tool activation auto-restores the dock anyway. Lets a
  // user who opens the popup with the dock dismissed press the badge keys
  // they see and have it just work.
  const POPUP_BARE_KEYS = {
    e: 'toggle-eraser',
    r: 'toggle-resizer',
    s: 'toggle-sticky',
    d: 'toggle-highlighter',
  };

  function isEditableNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isEditableNode(document.activeElement)) return;
    const action = POPUP_BARE_KEYS[e.key?.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    activateTool(action);
  }, true);

  // ─── Visibility toggle ────────────────────────────────────────────────────
  function setVisibilityBtn(isHidden) {
    btnVisibility.classList.toggle('hidden', isHidden);
    btnVisibility.title = isHidden
      ? 'Show changes (Alt+S)'
      : 'Hide changes (Alt+S)';
  }

  // Seed from content script on open. Visibility is ephemeral and per-tab,
  // so we always ask the live page rather than reading from storage.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'get-view' }, (response) => {
      void chrome.runtime.lastError;
      setVisibilityBtn(!!response?.hidden);
    });
  });

  btnVisibility.addEventListener('click', () => {
    // Optimistically flip state immediately so the button responds on click,
    // rather than waiting for the async message → storage → onChanged round-trip.
    setVisibilityBtn(!btnVisibility.classList.contains('hidden'));

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'toggle-view' }, () => {
        void chrome.runtime.lastError;
      });
    });
  });

  // ─── Seed active mode from content script on popup open ───────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'get-mode' }, (response) => {
      void chrome.runtime.lastError;
      if (response?.mode) setActiveCard(response.mode);
    });
  });

  // ─── Auto-restore the dock if it was dismissed on this domain ─────────────
  // Opening the popup is itself the "I'm engaging with Adnota here" gesture,
  // and it's the universal recovery path advertised in the first-time dismiss
  // toast. The content script's restore-dock handler removes the hostname
  // from adnotaHiddenDomains and unhides — symmetric to the X button.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'restore-dock' }, () => {
      void chrome.runtime.lastError;
    });
  });

  // ─── Live updates — react to keyboard shortcuts while popup is open ────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('adnotaActiveMode' in changes) {
      setActiveCard(changes.adnotaActiveMode.newValue);
    }
  });

  // Visibility is ephemeral (not persisted). Content scripts broadcast
  // 'visibility-changed' via chrome.runtime on every toggle/show; catch it
  // here so the popup icon stays in sync with Alt+S and the dock's eye button.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'visibility-changed') {
      setVisibilityBtn(!!msg.hidden);
    }
  });

  // ─── Load stats & wire stat-card clear interactions ───────────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs.length) return;

    let domain, path;
    try {
      const parsed = new URL(tabs[0].url);
      domain = parsed.hostname;
      path   = parsed.pathname;
    } catch {
      return; // chrome://, file://, restricted pages — bail silently.
    }

    // Mutable counts; refreshStats() writes here, handler closures read.
    const state = {
      erasures: 0, notes: 0, highlights: 0, strokes: 0, resizes: 0,
      pageStrict: 0, siteStrict: 0,
    };

    const nounMap = {
      ERASE:     { singular: 'erasure',     plural: 'erasures',     count: () => state.erasures,   actionTypes: ['ERASE'] },
      NOTE:      { singular: 'sticky note', plural: 'sticky notes', count: () => state.notes,      actionTypes: ['NOTE'] },
      HIGHLIGHT: { singular: 'highlight',   plural: 'highlights',   count: () => state.highlights, actionTypes: ['HIGHLIGHT'] },
      MARKER:    { singular: 'pen stroke',  plural: 'pen strokes',  count: () => state.strokes,    actionTypes: ['MARKER'] },
      RESIZE:    { singular: 'resize',      plural: 'resizes',      count: () => state.resizes,    actionTypes: ['RESIZE'] },
    };

    // Footer buttons pass `{ keepOpen: true }` so a confirmed clear leaves the
    // popup open for the user to act on the other button (page vs site-wide).
    // refreshStats() runs again on storage.onChanged so counts and labels
    // never lie — also covers the toast's 5s undo bouncing items back.
    function sendSoftDelete(payload, { keepOpen = false } = {}) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'adnota-soft-delete', ...payload }, () => {
        void chrome.runtime.lastError;
        if (!keepOpen) window.close();
      });
    }

    async function refreshStats() {
      const stored    = await chrome.storage.local.get(domain);
      const allItems  = stored[domain]?.items ?? [];
      const pageItems = allItems.filter(i => window.AdnotaStorage.matchesUrl(i, tabs[0].url));

      state.erasures = state.notes = state.highlights = state.strokes = state.resizes = 0;
      for (const item of pageItems) {
        switch (item.action) {
          case 'NOTE':      state.notes++;      break;
          case 'HIGHLIGHT': state.highlights++; break;
          case 'MARKER':    state.strokes++;    break;
          case 'RESIZE':    state.resizes++;    break;
          default:          state.erasures++;   break; // 'ERASE' or legacy entries
        }
      }

      document.getElementById('count-erasures').textContent   = state.erasures;
      document.getElementById('count-notes').textContent      = state.notes;
      document.getElementById('count-highlights').textContent = state.highlights;
      document.getElementById('count-strokes').textContent    = state.strokes;
      document.getElementById('count-resizes').textContent    = state.resizes;

      // Strict counts for the footer: page-scoped vs site-wide. The stat-cards
      // above still collapse both into a "what applies here" union (legacy
      // behavior, callers outside the popup depend on it). The footer buttons
      // opt into strict scope so a click on "Clear Page Edits" doesn't
      // silently nuke a user's site-wide resize rules.
      state.pageStrict = 0;
      state.siteStrict = 0;
      for (const item of allItems) {
        if (item.path === '*') state.siteStrict++;
        else if (item.path === path) state.pageStrict++;
      }

      renderFooterLabel(btnClearPage, state.pageStrict, 'Page');
      renderFooterLabel(btnClearSite, state.siteStrict, 'Site-Wide');
    }

    // Button label always plural — count in parens disambiguates and a fixed
    // footer reads cleaner without word-length jitter on each render.
    function renderFooterLabel(btn, count, scopeLabel) {
      if (count === 0) { btn.hidden = true; return; }
      btn.hidden = false;
      btn.querySelector('.btn-label').textContent = `Clear ${scopeLabel} Edits (${count})`;
    }

    // ── Per-class clear: dispatches a soft-delete to the content script,
    //    which handles confirm, toast, and 5s undo. Closes the popup (the
    //    five stat-card paths don't have a sibling button to chain into).
    document.querySelectorAll('.stat-card[data-clear-action]').forEach(card => {
      const info = nounMap[card.dataset.clearAction];
      if (!info) return;

      card.addEventListener('click', async () => {
        const count = info.count() ?? 0;
        if (count === 0) return;

        const noun = window.AdnotaUI.pluralize(count, info.singular, info.plural);
        const ok = await window.AdnotaUI.confirmDialog({
          message: `Delete ${count} ${noun} from this page?`,
          subtext: '',
        });
        if (!ok) return;

        sendSoftDelete({
          singular: info.singular,
          plural: info.plural,
          actionTypes: info.actionTypes,
          skipConfirm: true,
        });
      });
    });

    function wireFooterClear(btn, scope, getCount) {
      btn.addEventListener('click', async () => {
        const count = getCount();
        if (count === 0) return;
        const noun = window.AdnotaUI.pluralize(count, 'edit', 'edits');
        const ok = await window.AdnotaUI.confirmDialog({
          message: `Delete ${count} ${noun} from ${scope === 'site' ? 'this site' : 'this page'}?`,
          subtext: '',
        });
        if (!ok) return;
        sendSoftDelete({
          singular: 'edit',
          plural: 'edits',
          actionTypes: ['ERASE', 'NOTE', 'HIGHLIGHT', 'MARKER', 'RESIZE'],
          skipConfirm: true,
          scope,
        }, { keepOpen: true });
      });
    }
    wireFooterClear(btnClearPage, 'page', () => state.pageStrict);
    wireFooterClear(btnClearSite, 'site', () => state.siteStrict);

    await refreshStats();

    // Live updates: re-render on any storage write for this domain so a
    // soft-delete + undo round-trip keeps the popup labels honest even
    // when the popup itself never closed.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[domain]) refreshStats();
    });
  });
});
