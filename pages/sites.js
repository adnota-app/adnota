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
  const toast          = document.getElementById('toast');

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

    // Expand toggle (only if more than 1 page)
    if (pathMap.size > 1 || (pathMap.size === 1 && ![...pathMap.keys()].every(k => k === '/'))) {
      const btnExpand = document.createElement('button');
      btnExpand.className = 'btn-expand';
      btnExpand.title = 'Show individual pages';
      btnExpand.innerHTML = `
        <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>`;
      btnExpand.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('expanded');
      });
      actions.appendChild(btnExpand);
    }

    body.appendChild(actions);
    card.appendChild(body);

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

      const pathEl = document.createElement('span');
      pathEl.className = 'page-path' + (path === '/' || path === '*' ? ' page-path-root' : '');
      pathEl.textContent = path === '*' ? '(domain-wide)' : path;
      pathEl.title = path;
      row.appendChild(pathEl);

      const pagePillsEl = document.createElement('div');
      pagePillsEl.className = 'page-pills';
      for (const type of ['ERASE', 'NOTE', 'HIGHLIGHT', 'MARKER', 'RESIZE']) {
        const p = makePill(type, pageCounts[type]);
        if (p) pagePillsEl.appendChild(p);
      }
      row.appendChild(pagePillsEl);

      if (path !== '*') {
        const btnPage = document.createElement('button');
        btnPage.className = 'btn-page-visit';
        btnPage.textContent = 'Open';
        btnPage.addEventListener('click', () => {
          chrome.tabs.create({ url: `https://${hostname}${path}` });
        });
        row.appendChild(btnPage);
      }

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
    render();
  });
})();
