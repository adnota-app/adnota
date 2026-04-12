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
  btnVisibility.addEventListener('click', () => {
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

  // ─── Live mode updates — react to keyboard shortcuts while popup is open ──
  // VellumState.set() now writes 'vellumActiveMode' to storage on every mode
  // change, so we can listen here and update without any polling.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'vellumActiveMode' in changes) {
      setActiveCard(changes.vellumActiveMode.newValue);
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

    let erasures = 0, notes = 0, highlights = 0, strokes = 0;
    for (const item of pageItems) {
      switch (item.action) {
        case 'NOTE':      notes++;      break;
        case 'HIGHLIGHT': highlights++; break;
        case 'MARKER':    strokes++;    break;
        default:          erasures++;   break; // 'ERASE' or legacy entries
      }
    }

    document.getElementById('count-erasures').textContent   = erasures;
    document.getElementById('count-notes').textContent      = notes;
    document.getElementById('count-highlights').textContent = highlights;
    document.getElementById('count-strokes').textContent    = strokes;

    // ── Per-class clear: clicking a stat card deletes that action type ──────
    const labelMap = {
      ERASE:     'all erasures',
      NOTE:      'all sticky notes',
      HIGHLIGHT: 'all highlights',
      MARKER:    'all pen strokes',
    };

    document.querySelectorAll('.stat-card[data-clear-action]').forEach(card => {
      const actionType = card.dataset.clearAction;

      card.addEventListener('click', async () => {
        const label = labelMap[actionType] ?? 'these items';
        // Use a simple window.confirm — works fine in extension popups.
        if (!window.confirm(`Delete ${label} from this page? This cannot be undone.`)) return;

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
      if (!window.confirm('Delete ALL Vellum edits on this page? This cannot be undone.')) return;

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
