// popup/popup.js

document.addEventListener('DOMContentLoaded', async () => {
  const btnClear      = document.getElementById('btn-clear');
  const btnVisibility = document.getElementById('btn-visibility');
  const btnMySites    = document.getElementById('btn-my-sites');

  // ─── Open the Sites history page ──────────────────────────────────────────
  btnMySites.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/sites.html') });
    window.close();
  });

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
  document.querySelectorAll('.tool-card[data-action]').forEach(card => {
    card.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs.length) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: card.dataset.action }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      });
    });
  });

  // ─── Visibility toggle ────────────────────────────────────────────────────
  function setVisibilityBtn(isHidden) {
    btnVisibility.classList.toggle('hidden', isHidden);
    btnVisibility.title = isHidden
      ? 'Show changes (Alt+V)'
      : 'Hide changes (Alt+V)';
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

  // ─── Live updates — react to keyboard shortcuts while popup is open ────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('vellumActiveMode' in changes) {
      setActiveCard(changes.vellumActiveMode.newValue);
    }
  });

  // Visibility is ephemeral (not persisted). Content scripts broadcast
  // 'visibility-changed' via chrome.runtime on every toggle/show; catch it
  // here so the popup icon stays in sync with Alt+V and the radial menu.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'visibility-changed') {
      setVisibilityBtn(!!msg.hidden);
    }
  });

  // ─── Load stats & wire stat-card clear interactions ───────────────────────
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url;

    let domain, path;
    try {
      const parsed = new URL(url);
      domain = parsed.hostname;
      path   = parsed.pathname;
    } catch {
      return; // chrome://, file://, restricted pages — bail silently.
    }

    // ── Count items by action type from storage ──
    const stored     = await chrome.storage.local.get(domain);
    const allItems   = stored[domain]?.items ?? [];
    const pageItems  = allItems.filter(i => i.path === '*' || i.path === path);

    let erasures = 0, notes = 0, highlights = 0, strokes = 0, resizes = 0;
    for (const item of pageItems) {
      switch (item.action) {
        case 'NOTE':      notes++;      break;
        case 'HIGHLIGHT': highlights++; break;
        case 'MARKER':    strokes++;    break;
        case 'RESIZE':    resizes++;    break;
        default:          erasures++;   break; // 'ERASE' or legacy entries
      }
    }

    document.getElementById('count-erasures').textContent   = erasures;
    document.getElementById('count-notes').textContent      = notes;
    document.getElementById('count-highlights').textContent = highlights;
    document.getElementById('count-strokes').textContent    = strokes;
    document.getElementById('count-resizes').textContent    = resizes;

    // ── Per-class clear: clicking a stat card deletes that action type ──────
    const nounMap = {
      ERASE:     { singular: 'erasure',     plural: 'erasures',     count: () => erasures },
      NOTE:      { singular: 'sticky note', plural: 'sticky notes', count: () => notes },
      HIGHLIGHT: { singular: 'highlight',   plural: 'highlights',   count: () => highlights },
      MARKER:    { singular: 'pen stroke',  plural: 'pen strokes',  count: () => strokes },
      RESIZE:    { singular: 'resize',      plural: 'resizes',      count: () => resizes },
    };

    document.querySelectorAll('.stat-card[data-clear-action]').forEach(card => {
      const actionType = card.dataset.clearAction;
      const info = nounMap[actionType];

      card.addEventListener('click', async () => {
        const n = info?.count() ?? 0;
        if (n === 0) return;
        const noun = window.VellumUI.pluralize(n, info.singular, info.plural);
        const ok = await window.VellumUI.confirmDialog({
          message: `Delete ${n} ${noun} from this page?`,
        });
        if (!ok) return;

        const fresh     = await chrome.storage.local.get(domain);
        const freshData = fresh[domain];
        if (!freshData?.items) return;

        freshData.items = freshData.items.filter(item => {
          const onThisPage    = item.path === path || item.path === '*';
          const matchesAction = actionType === 'ERASE'
            ? (item.action === 'ERASE' || !item.action)  // legacy erasures may lack the field
            : item.action === actionType;
          // Keep items that are NOT (on this page AND the right action type).
          return !(onThisPage && matchesAction);
        });

        await chrome.storage.local.set({ [domain]: freshData });
        chrome.tabs.reload(tabs[0].id);
        window.close();
      });
    });

    // ── Clear ALL page edits ──────────────────────────────────────────────
    btnClear.addEventListener('click', async () => {
      const total = erasures + notes + highlights + strokes + resizes;
      if (total === 0) return;
      const noun = window.VellumUI.pluralize(total, 'edit', 'edits');
      const ok = await window.VellumUI.confirmDialog({
        message: `Delete all ${total} ${noun} on this page?`,
      });
      if (!ok) return;

      const fresh     = await chrome.storage.local.get(domain);
      const freshData = fresh[domain];
      if (freshData?.items) {
        freshData.items = freshData.items.filter(
          item => item.path !== path && item.path !== '*'
        );
        await chrome.storage.local.set({ [domain]: freshData });
      }

      chrome.tabs.reload(tabs[0].id);
      window.close();
    });
  });
});
