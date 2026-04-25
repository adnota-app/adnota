// lib/tagIndex.js
//
// Shared tag utility used by sticky notes, the quick-highlight popup, and the
// Sites (Home) page. Tags are one optional free-text string per NOTE/HIGHLIGHT
// item; there is no tag management UI — tags exist because some item has one.
// This file is the only place that knows how to normalize a tag, collect the
// full set from storage, and render an autocomplete dropdown under an input.

(function () {
  'use strict';

  function normalize(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/\s+/g, ' ').slice(0, 40);
  }

  // Pull every non-empty tag across all domains with its usage count. No
  // caching — reads fire on tag-input focus, and total item count is bounded
  // by the 10 MB storage cap. Returns [{ tag, count }] sorted by count desc,
  // then alphabetically on ties, so the most-used tags appear first wherever
  // this list is rendered (autocomplete, Home-page chip row).
  async function getAllTags() {
    const all = await chrome.storage.local.get(null);
    const counts = new Map();
    for (const value of Object.values(all)) {
      if (!value || !Array.isArray(value.items)) continue;
      for (const item of value.items) {
        const t = normalize(item.tag);
        if (t) counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  }

  // Wire an autocomplete dropdown onto an <input>. Returns a cleanup function.
  //
  //   inputEl — the text input the user types into.
  //   opts.onPick(tag) — called when the user clicks or Enters a suggestion.
  //     The default pick behavior sets inputEl.value; onPick runs after that.
  //
  // Dropdown is appended to <body> with position:fixed so it escapes every
  // parent stacking context (sticky note containers, the quick-highlight popup,
  // the Sites page chrome) without CSS gymnastics.
  function buildAutocompleteDropdown(inputEl, opts = {}) {
    const { onPick } = opts;
    let dropdown = null;
    let tags = [];
    let highlightedIdx = -1;

    function ensureDropdown() {
      if (dropdown) return dropdown;
      dropdown = document.createElement('div');
      dropdown.className = 'vellum-tag-suggest';
      dropdown.setAttribute('data-vellum-ui', '1');
      document.body.appendChild(dropdown);
      return dropdown;
    }

    function positionDropdown() {
      if (!dropdown) return;
      const r = inputEl.getBoundingClientRect();
      // Center the dropdown horizontally on the input so any overflow (when
      // the dropdown's natural width exceeds the input's, e.g. the narrow
      // quick-highlight popup) is split evenly on both sides instead of
      // spilling all to one edge.
      dropdown.style.left = `${r.left + r.width / 2}px`;
      dropdown.style.right = 'auto';
      dropdown.style.transform = 'translateX(-50%)';
      dropdown.style.top  = `${r.bottom + 2}px`;
      dropdown.style.minWidth = `${Math.max(r.width, 140)}px`;
    }

    function render() {
      if (!dropdown) return;
      const q = normalize(inputEl.value).toLowerCase();
      const matches = tags
        .filter(t => !q || t.tag.toLowerCase().includes(q))
        .filter(t => t.tag.toLowerCase() !== q)
        .slice(0, 8);

      if (matches.length === 0) {
        dropdown.style.display = 'none';
        highlightedIdx = -1;
        return;
      }

      dropdown.style.display = 'block';
      dropdown.innerHTML = '';
      matches.forEach(({ tag, count }, i) => {
        const item = document.createElement('div');
        item.className = 'vellum-tag-suggest-item' + (i === highlightedIdx ? ' highlighted' : '');
        item.dataset.tag = tag;

        const hash = document.createElement('span');
        hash.className = 'vellum-tag-suggest-item-hash';
        hash.textContent = '#';
        item.appendChild(hash);

        const name = document.createElement('span');
        name.className = 'vellum-tag-suggest-item-name';
        name.textContent = tag;
        item.appendChild(name);

        const countEl = document.createElement('span');
        countEl.className = 'vellum-tag-suggest-item-count';
        countEl.textContent = count;
        item.appendChild(countEl);

        // mousedown (not click) so the input's blur handler doesn't fire first
        // and hide the dropdown before the pick lands.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(tag);
        });
        dropdown.appendChild(item);
      });
      positionDropdown();
    }

    function pick(tag) {
      inputEl.value = tag;
      // Fire input event so any existing listener (debounced save, etc.) sees the change.
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof onPick === 'function') onPick(tag);
      hide();
    }

    function hide() {
      if (dropdown) dropdown.style.display = 'none';
      highlightedIdx = -1;
    }

    async function onFocus() {
      try { tags = await getAllTags(); } catch (err) { tags = []; }
      ensureDropdown();
      render();
    }

    function onInput() {
      highlightedIdx = -1;
      render();
    }

    function onBlur() {
      // Delay so mousedown on a suggestion can register first.
      setTimeout(hide, 120);
    }

    function onKeyDown(e) {
      const isOpen = dropdown && dropdown.style.display === 'block';
      if (!isOpen) {
        if (e.key === 'Escape') hide();
        return;
      }
      const items = dropdown.querySelectorAll('.vellum-tag-suggest-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightedIdx = Math.min(items.length - 1, highlightedIdx + 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightedIdx = Math.max(0, highlightedIdx - 1);
        render();
      } else if (e.key === 'Enter' && highlightedIdx >= 0 && items[highlightedIdx]) {
        e.preventDefault();
        pick(items[highlightedIdx].dataset.tag || '');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      }
    }

    function onReposition() {
      if (dropdown && dropdown.style.display === 'block') positionDropdown();
    }

    inputEl.addEventListener('focus', onFocus);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('blur', onBlur);
    inputEl.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);

    return function cleanup() {
      inputEl.removeEventListener('focus', onFocus);
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('blur', onBlur);
      inputEl.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
      if (dropdown) dropdown.remove();
    };
  }

  window.VellumTags = { getAllTags, normalize, buildAutocompleteDropdown };
})();
