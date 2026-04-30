// popup/popup.js

document.addEventListener('DOMContentLoaded', async () => {
  const btnClear      = document.getElementById('btn-clear');
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

    // ── Per-class clear: each card dispatches a soft-delete to the content
    //    script, which handles confirm, toast, and 5s undo. The popup just
    //    sends the request and closes.
    const nounMap = {
      ERASE:     { singular: 'erasure',     plural: 'erasures',     count: () => erasures,   actionTypes: ['ERASE'] },
      NOTE:      { singular: 'sticky note', plural: 'sticky notes', count: () => notes,      actionTypes: ['NOTE'] },
      HIGHLIGHT: { singular: 'highlight',   plural: 'highlights',   count: () => highlights, actionTypes: ['HIGHLIGHT'] },
      MARKER:    { singular: 'pen stroke',  plural: 'pen strokes',  count: () => strokes,    actionTypes: ['MARKER'] },
      RESIZE:    { singular: 'resize',      plural: 'resizes',      count: () => resizes,    actionTypes: ['RESIZE'] },
    };

    function sendSoftDelete(payload) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'adnota-soft-delete', ...payload }, () => {
        void chrome.runtime.lastError;
        window.close();
      });
    }

    document.querySelectorAll('.stat-card[data-clear-action]').forEach(card => {
      const info = nounMap[card.dataset.clearAction];
      if (!info) return;

      card.addEventListener('click', async () => {
        const count = info.count() ?? 0;
        if (count === 0) return;

        const noun = window.AdnotaUI.pluralize(count, info.singular, info.plural);
        const ok = await window.AdnotaUI.confirmDialog({
          message: `Delete ${count} ${noun} from this page?`,
          subtext: 'You\u2019ll have 5 seconds to undo.',
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

    // ── Clear ALL page edits ──────────────────────────────────────────────
    btnClear.addEventListener('click', async () => {
      const total = erasures + notes + highlights + strokes + resizes;
      if (total === 0) return;

      const noun = window.AdnotaUI.pluralize(total, 'edit', 'edits');
      const ok = await window.AdnotaUI.confirmDialog({
        message: `Delete ${total} ${noun} from this page?`,
        subtext: 'You\u2019ll have 5 seconds to undo.',
      });
      if (!ok) return;

      sendSoftDelete({
        singular: 'edit',
        plural: 'edits',
        actionTypes: ['ERASE', 'NOTE', 'HIGHLIGHT', 'MARKER', 'RESIZE'],
        skipConfirm: true,
      });
    });
  });
});
