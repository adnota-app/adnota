// pages/sites.js
// Vellum — My Edited Sites
// Reads all chrome.storage.local data and renders a per-domain bookmark list.

(async () => {
  'use strict';

  // ─── Reserved storage keys that are NOT domain data ──────────────────────
  const RESERVED_KEYS = new Set(['vellumActiveMode']);

  // ─── Elements ─────────────────────────────────────────────────────────────
  const stateLoading   = document.getElementById('state-loading');
  const stateEmpty     = document.getElementById('state-empty');
  const stateNoResults = document.getElementById('state-no-results');
  const sitesList      = document.getElementById('sites-list');
  const searchInput    = document.getElementById('search-input');
  const searchClear    = document.getElementById('search-clear');
  const sortSelect     = document.getElementById('sort-select');
  const totalSites     = document.getElementById('total-sites');
  const totalEdits     = document.getElementById('total-edits');
  const totalPages     = document.getElementById('total-pages');
  const storageMeter   = document.getElementById('storage-meter');
  const storageText    = document.getElementById('storage-text');
  const storageBarFill = document.getElementById('storage-bar-fill');
  const toast          = document.getElementById('toast');

  // ─── Storage quota (MV3: 10MB; falls back to API value on older Chrome) ───
  const STORAGE_QUOTA = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
  const WARN_PCT = 0.80;
  const CRIT_PCT = 0.95;

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function updateStorageMeter() {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    const pct = Math.min(bytes / STORAGE_QUOTA, 1);
    const pctWhole = Math.round(pct * 100);
    const quotaMb = (STORAGE_QUOTA / (1024 * 1024)).toFixed(0);
    storageText.textContent = `${formatBytes(bytes)} / ${quotaMb} MB · ${pctWhole}%`;
    storageBarFill.style.width = `${pct * 100}%`;
    storageMeter.classList.toggle('warn', pct >= WARN_PCT && pct < CRIT_PCT);
    storageMeter.classList.toggle('crit', pct >= CRIT_PCT);
    storageMeter.title = pct >= WARN_PCT
      ? `Storage is ${pctWhole}% full. Delete unused sites to free space.`
      : `${formatBytes(bytes)} of ${quotaMb} MB used`;
  }

  // ─── Toast helper ─────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, duration = 2200) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
  }

  // ─── Time formatting ──────────────────────────────────────────────────────
  function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins < 1)   return 'just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7)   return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ─── Favicon helper ───────────────────────────────────────────────────────
  function faviconUrl(hostname) {
    return `https://www.google.com/s2/favicons?sz=64&domain=${hostname}`;
  }

  function faviconFallbackChar(hostname) {
    return (hostname || '?')[0].toUpperCase();
  }

  // ─── Load all storage and build domain-grouped model ──────────────────────
  async function loadSiteData() {
    const all = await chrome.storage.local.get(null); // pull everything

    const sites = [];

    for (const [key, value] of Object.entries(all)) {
      // Skip reserved keys and anything that isn't our domain-keyed format
      if (RESERVED_KEYS.has(key)) continue;
      if (!value || !Array.isArray(value.items) || value.items.length === 0) continue;

      const items = value.items;

      // Group items by path (page)
      const pathMap = new Map();
      let latestTs = 0;

      for (const item of items) {
        const path = item.path || '/';
        if (!pathMap.has(path)) pathMap.set(path, []);
        pathMap.get(path).push(item);

        const ts = item.updatedAt || item.createdAt || item.timestamp || 0;
        if (ts > latestTs) latestTs = ts;
      }

      // Count action types per domain
      const counts = { ERASE: 0, NOTE: 0, HIGHLIGHT: 0, MARKER: 0, RESIZE: 0 };
      for (const item of items) {
        const a = item.action;
        if (a === 'NOTE')           counts.NOTE++;
        else if (a === 'HIGHLIGHT') counts.HIGHLIGHT++;
        else if (a === 'MARKER')    counts.MARKER++;
        else if (a === 'RESIZE')     counts.RESIZE++;
        else                        counts.ERASE++;
      }

      sites.push({
        hostname:  key,
        totalEdits: items.length,
        latestTs,
        counts,
        pathMap,
      });
    }

    return sites;
  }

  // ─── Build a pill element ─────────────────────────────────────────────────
  function makePill(type, count) {
    if (!count) return null;
    const labels = { ERASE: 'Erased', NOTE: 'Notes', HIGHLIGHT: 'Highlights', MARKER: 'Strokes', RESIZE: 'Resized' };
    const classes = { ERASE: 'pill-erase', NOTE: 'pill-note', HIGHLIGHT: 'pill-highlight', MARKER: 'pill-stroke', RESIZE: 'pill-resize' };

    const pill = document.createElement('span');
    pill.className = `pill ${classes[type]}`;
    pill.innerHTML = `<span class="pill-dot"></span>${count} ${labels[type]}`;
    return pill;
  }

  // ─── Build page-level pills ───────────────────────────────────────────────
  function pageCountsFromItems(items) {
    const counts = { ERASE: 0, NOTE: 0, HIGHLIGHT: 0, MARKER: 0, RESIZE: 0 };
    for (const item of items) {
      const a = item.action;
      if (a === 'NOTE')           counts.NOTE++;
      else if (a === 'HIGHLIGHT') counts.HIGHLIGHT++;
      else if (a === 'MARKER')    counts.MARKER++;
      else if (a === 'RESIZE')     counts.RESIZE++;
      else                        counts.ERASE++;
    }
    return counts;
  }

  // ─── Build a site card DOM node ───────────────────────────────────────────
  function buildSiteCard(site) {
    const { hostname, totalEdits: total, latestTs, counts, pathMap } = site;

    const card = document.createElement('div');
    card.className = 'site-card';
    card.dataset.hostname = hostname;

    // ── Left accent ──
    const accent = document.createElement('div');
    accent.className = 'site-card-accent';
    card.appendChild(accent);

    // ── Card body ──
    const body = document.createElement('div');
    body.className = 'site-card-body';

    // Favicon
    const faviconWrap = document.createElement('div');
    faviconWrap.className = 'favicon-wrap';
    const img = document.createElement('img');
    img.className = 'favicon-img';
    img.src = faviconUrl(hostname);
    img.alt = '';
    img.addEventListener('error', () => {
      img.remove();
      const fb = document.createElement('span');
      fb.className = 'favicon-fallback';
      fb.textContent = faviconFallbackChar(hostname);
      faviconWrap.appendChild(fb);
    });
    faviconWrap.appendChild(img);
    body.appendChild(faviconWrap);

    // Site info
    const info = document.createElement('div');
    info.className = 'site-info';

    const hostEl = document.createElement('div');
    hostEl.className = 'site-host';
    hostEl.textContent = hostname;
    info.appendChild(hostEl);

    const meta = document.createElement('div');
    meta.className = 'site-meta';

    const pageLabel = document.createElement('span');
    pageLabel.className = 'site-page-count';
    const pageCount = pathMap.size;
    pageLabel.textContent = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
    meta.appendChild(pageLabel);

    if (latestTs) {
      const dot = document.createElement('span');
      dot.className = 'site-meta-dot';
      meta.appendChild(dot);

      const lastEdit = document.createElement('span');
      lastEdit.className = 'site-last-edit';
      lastEdit.textContent = `Last edited ${relativeTime(latestTs)}`;
      meta.appendChild(lastEdit);
    }

    info.appendChild(meta);
    body.appendChild(info);

    // Pills
    const pills = document.createElement('div');
    pills.className = 'site-pills';
    for (const type of ['ERASE', 'NOTE', 'HIGHLIGHT', 'MARKER', 'RESIZE']) {
      const p = makePill(type, counts[type]);
      if (p) pills.appendChild(p);
    }
    body.appendChild(pills);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'site-actions';

    // Visit latest page
    const btnVisit = document.createElement('button');
    btnVisit.className = 'btn-visit';
    btnVisit.title = `Open ${hostname}`;
    btnVisit.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      <span>Visit</span>`;
    btnVisit.addEventListener('click', (e) => {
      e.stopPropagation();
      // Open the most recently edited page
      let bestPath = '/';
      let bestTs = 0;
      for (const [path, items] of pathMap.entries()) {
        if (path === '*') continue;
        for (const item of items) {
          const ts = item.updatedAt || item.createdAt || item.timestamp || 0;
          if (ts > bestTs) { bestTs = ts; bestPath = path; }
        }
      }
      const url = `https://${hostname}${bestPath}`;
      chrome.tabs.create({ url });
    });
    actions.appendChild(btnVisit);

    // Delete-domain trash button
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-delete-domain';
    btnDelete.title = `Delete all edits for ${hostname}`;
    btnDelete.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 17 6"/>
        <path d="M15 6l-1 10a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        <path d="M8 9v6"/><path d="M12 9v6"/>
        <path d="M8 6V4h4v2"/>
      </svg>`;
    btnDelete.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageCount = pathMap.size;
      const ok = await window.VellumUI.confirmDialog({
        title: 'Delete all edits?',
        message: `Delete all edits for ${hostname}?`,
        subtext: `This removes ${total} ${total === 1 ? 'edit' : 'edits'} across ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}. This cannot be undone.`,
        confirmText: 'Delete All',
      });
      if (!ok) return;
      await chrome.storage.local.remove(hostname);
      showToast(`Deleted all edits for ${hostname}`);
      // storage.onChanged listener will refresh the list + meter.
    });
    actions.appendChild(btnDelete);

    // Expand toggle — always rendered to keep action column aligned across
    // cards. When there are no sub-pages to show, it stays inert + invisible
    // but reserves the layout slot so Visit/trash line up row-to-row.
    const hasExpandablePages = pathMap.size > 1 || (pathMap.size === 1 && ![...pathMap.keys()].every(k => k === '/'));
    const btnExpand = document.createElement('button');
    btnExpand.className = 'btn-expand';
    btnExpand.innerHTML = `
      <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>`;
    if (hasExpandablePages) {
      btnExpand.title = 'Show individual pages';
      btnExpand.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('expanded');
      });
    } else {
      btnExpand.classList.add('btn-expand-placeholder');
      btnExpand.setAttribute('aria-hidden', 'true');
      btnExpand.tabIndex = -1;
    }
    actions.appendChild(btnExpand);

    body.appendChild(actions);
    card.appendChild(body);

    // Whole-header click toggles expansion when there's a drawer to reveal.
    // Interactive children (Visit, trash, chevron) stopPropagation on click,
    // so this only fires on "empty" header space (favicon / title / pills).
    if (hasExpandablePages) {
      body.classList.add('site-card-body-expandable');
      body.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });
    }

    // ── Pages drawer ──
    const drawer = document.createElement('div');
    drawer.className = 'pages-drawer';
    const drawerInner = document.createElement('div');
    drawerInner.className = 'pages-drawer-inner';

    const drawerLabel = document.createElement('div');
    drawerLabel.className = 'drawer-label';
    drawerLabel.textContent = 'Pages';
    drawerInner.appendChild(drawerLabel);

    // Sort paths: '*' domain-wide last, then alphabetical
    const sortedPaths = [...pathMap.keys()].sort((a, b) => {
      if (a === '*') return 1;
      if (b === '*') return -1;
      return a.localeCompare(b);
    });

    for (const path of sortedPaths) {
      const items = pathMap.get(path);
      const pageCounts = pageCountsFromItems(items);

      const row = document.createElement('div');
      row.className = 'page-row';

      const isRootPath = path === '/' || path === '*';
      const pathClasses = 'page-path' + (isRootPath ? ' page-path-root' : '');

      let pathEl;
      if (path === '*') {
        pathEl = document.createElement('span');
        pathEl.className = pathClasses;
        pathEl.textContent = '(domain-wide)';
      } else {
        pathEl = document.createElement('a');
        pathEl.className = pathClasses;
        pathEl.href = `https://${hostname}${path}`;
        pathEl.target = '_blank';
        pathEl.rel = 'noopener noreferrer';
        pathEl.title = `Open ${hostname}${path} in a new tab`;

        const label = document.createElement('span');
        label.className = 'page-path-label';
        label.textContent = path;
        pathEl.appendChild(label);

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'page-path-icon');
        icon.setAttribute('width', '11');
        icon.setAttribute('height', '11');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2.2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = `
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>`;
        pathEl.appendChild(icon);
      }
      row.appendChild(pathEl);

      const pagePillsEl = document.createElement('div');
      pagePillsEl.className = 'page-pills';
      for (const type of ['ERASE', 'NOTE', 'HIGHLIGHT', 'MARKER', 'RESIZE']) {
        const p = makePill(type, pageCounts[type]);
        if (p) pagePillsEl.appendChild(p);
      }
      row.appendChild(pagePillsEl);

      drawerInner.appendChild(row);
    }

    drawer.appendChild(drawerInner);
    card.appendChild(drawer);

    return card;
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  let allSites = [];

  function sortSites(sites, order) {
    return [...sites].sort((a, b) => {
      switch (order) {
        case 'alpha':  return a.hostname.localeCompare(b.hostname);
        case 'count':  return b.totalEdits - a.totalEdits;
        case 'recent':
        default:       return b.latestTs - a.latestTs;
      }
    });
  }

  function filterSites(sites, query) {
    if (!query) return sites;
    const q = query.toLowerCase();
    return sites.filter(s => s.hostname.toLowerCase().includes(q));
  }

  function updateSummary(sites) {
    let editSum = 0, pageSum = 0;
    for (const s of sites) {
      editSum += s.totalEdits;
      pageSum += s.pathMap.size;
    }
    totalSites.textContent = sites.length;
    totalEdits.textContent = editSum;
    totalPages.textContent = pageSum;
  }

  function render() {
    const query   = searchInput.value.trim();
    const order   = sortSelect.value;
    const filtered = filterSites(sortSites(allSites, order), query);

    sitesList.innerHTML = '';

    if (allSites.length === 0) {
      stateEmpty.hidden = false;
      stateNoResults.hidden = true;
      sitesList.hidden = true;
      return;
    }

    stateEmpty.hidden = true;

    if (filtered.length === 0) {
      stateNoResults.hidden = false;
      sitesList.hidden = true;
      return;
    }

    stateNoResults.hidden = true;
    sitesList.hidden = false;

    for (const site of filtered) {
      sitesList.appendChild(buildSiteCard(site));
    }

    updateSummary(allSites); // summary always reflects total, not filtered
  }

  // ─── Initial load ─────────────────────────────────────────────────────────
  try {
    allSites = await loadSiteData();
  } catch (err) {
    console.error('[Vellum Sites] Failed to load storage:', err);
    allSites = [];
  }

  stateLoading.hidden = true;
  updateSummary(allSites);
  updateStorageMeter();
  render();

  // ─── Search wiring ────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    searchClear.hidden = searchInput.value.length === 0;
    render();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    searchInput.focus();
    render();
  });

  // ─── Sort wiring ──────────────────────────────────────────────────────────
  sortSelect.addEventListener('change', render);

  // ─── Live storage updates ─────────────────────────────────────────────────
  // Re-build data model whenever storage changes (e.g. user made an edit on
  // another tab while the Sites page was open).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // Skip if only vellumActiveMode changed
    const changedKeys = Object.keys(changes);
    if (changedKeys.every(k => RESERVED_KEYS.has(k))) return;

    allSites = await loadSiteData();
    updateSummary(allSites);
    updateStorageMeter();
    render();
  });
})();
