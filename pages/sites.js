// pages/sites.js
// Adnota — My Edited Sites
// Reads all chrome.storage.local data and renders a per-domain bookmark list.

(async () => {
  'use strict';

  // ─── Reserved storage keys that are NOT domain data ──────────────────────
  // The view-state keys (tab / feed type / per-tab sort) belong here too —
  // the loadAllData pass walks every top-level key looking for domain
  // payloads, so any meta key we store has to be excluded explicitly or
  // it'd get (mis)treated as a domain.
  const RESERVED_KEYS = new Set([
    'adnotaActiveMode',
    'adnotaHomeTab',
    'adnotaHomeFeedType',
    'adnotaHomeSortSnippets',
    'adnotaHomeSortSites',
  ]);

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
  const tagFilterBar   = document.getElementById('tag-filter-bar');
  const toast          = document.getElementById('toast');

  // Snippets-tab elements
  const viewSnippets       = document.getElementById('view-snippets');
  const viewSites          = document.getElementById('view-sites');
  const tabSnippets        = document.getElementById('tab-snippets');
  const tabSites           = document.getElementById('tab-sites');
  const tabSnippetsCount   = document.getElementById('tab-snippets-count');
  const tabSitesCount      = document.getElementById('tab-sites-count');
  const proseFeed          = document.getElementById('prose-feed');
  const feedTypeFilter     = document.getElementById('feed-type-filter');
  const feedStateEmpty     = document.getElementById('feed-state-empty');
  const feedStateNoResults = document.getElementById('feed-state-no-results');

  // ─── Theme / color mapping ───────────────────────────────────────────────
  // Highlights store either a theme key (`adnota-theme-yellow`, etc.) or a
  // raw hex/rgb string picked with the eyedropper. Sticky notes only use
  // theme keys. The table below is the source of truth for both rails
  // (quote-block left border, thought-block theme strip).
  const THEME_HEX = {
    'adnota-theme-yellow': '#FBE6A1',
    'adnota-theme-green':  '#B8F5B8',
    'adnota-theme-blue':   '#A3DDFB',
    'adnota-theme-pink':   '#FFC0C8',
    'adnota-theme-white':  '#E8E6DE',
    'adnota-theme-black':  '#1a1a1a',
  };
  function themeHex(key, fallback = '#cccccc') {
    if (!key) return fallback;
    if (typeof key === 'string' && (key.startsWith('#') || key.startsWith('rgb'))) return key;
    return THEME_HEX[key] ?? fallback;
  }

  // Black highlight = redaction. In the feed we render redactions as a
  // narrow black bar instead of reproducing the underlying text — the quote
  // has no meaningful prose to show, so we honor the user's intent to hide.
  const REDACTION_THEME = 'adnota-theme-black';
  function isRedaction(item) {
    return item.type === 'highlight' && item.color === REDACTION_THEME;
  }

  // ─── View state ──────────────────────────────────────────────────────────
  const SORT_OPTIONS = {
    snippets: [
      { value: 'newest', label: 'Newest' },
      { value: 'oldest', label: 'Oldest' },
    ],
    sites: [
      { value: 'recent', label: 'Most Recent' },
      { value: 'alpha',  label: 'A → Z' },
      { value: 'count',  label: 'Most Edits' },
      { value: 'size',   label: 'Largest' },
    ],
  };

  const SEARCH_PLACEHOLDER = {
    snippets: 'Search your snippets…',
    sites:    'Filter sites…',
  };

  const TAB_KEY   = 'adnotaHomeTab';
  const TYPE_KEY  = 'adnotaHomeFeedType';
  const SORT_SNIPPETS_KEY = 'adnotaHomeSortSnippets';
  const SORT_SITES_KEY    = 'adnotaHomeSortSites';

  // ─── Storage quota (MV3: 10MB; falls back to API value on older Chrome) ───
  const STORAGE_QUOTA = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
  const WARN_PCT = 0.80;
  const CRIT_PCT = 0.95;

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${Math.round(n / (1024 * 1024))} MB`;
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

  // Normalize a tag string; mirrors lib/tagIndex.js. Defined inline so the
  // Sites page still works if tagIndex.js fails to load for any reason.
  function normalizeTag(raw) {
    if (window.AdnotaTags) return window.AdnotaTags.normalize(raw);
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/\s+/g, ' ').slice(0, 40);
  }

  // ─── Load all storage and build both views' data models in one pass ──────
  // Returns { sites, feedItems }. The Snippets tab reads feedItems (flat
  // stream of HIGHLIGHT + NOTE text, newest first); the By Site tab reads
  // sites (existing per-domain aggregation). Keeping both derivations in one
  // storage walk avoids a duplicate `chrome.storage.local.get(null)` call.
  async function loadAllData() {
    const all = await chrome.storage.local.get(null);

    const sites = [];
    const feedItems = [];

    for (const [key, value] of Object.entries(all)) {
      if (RESERVED_KEYS.has(key)) continue;
      if (!value || !Array.isArray(value.items) || value.items.length === 0) continue;

      const hostname = key;
      const items = value.items;

      // Group items by path (page)
      const pathMap = new Map();
      let latestTs = 0;
      const tagCounts = {};
      const counts = { ERASE: 0, NOTE: 0, HIGHLIGHT: 0, MARKER: 0, RESIZE: 0 };

      for (const item of items) {
        const path = item.path || '/';
        if (!pathMap.has(path)) pathMap.set(path, []);
        pathMap.get(path).push(item);

        const ts = item.updatedAt || item.createdAt || item.timestamp || 0;
        if (ts > latestTs) latestTs = ts;

        const tag = normalizeTag(item.tag);
        if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;

        const a = item.action;
        if (a === 'NOTE')           counts.NOTE++;
        else if (a === 'HIGHLIGHT') counts.HIGHLIGHT++;
        else if (a === 'MARKER')    counts.MARKER++;
        else if (a === 'RESIZE')    counts.RESIZE++;
        else                        counts.ERASE++;

        // Flatten into feed stream. Only HIGHLIGHT + NOTE carry text —
        // ERASE / MARKER / RESIZE have no user-readable prose and stay in
        // the By Site tab only. Blank-body notes are silently skipped in
        // the feed (they'd render empty) but still count in By Site.
        if (a === 'HIGHLIGHT') {
          feedItems.push({
            id: item._id,
            type: 'highlight',
            text: item.text ?? '',
            domain: hostname,
            path,
            url: `https://${hostname}${path === '*' ? '/' : path}`,
            tag,
            color: item.color,
            timestamp: ts,
          });
        } else if (a === 'NOTE') {
          const body = (item.comments?.[0]?.text ?? '').trim();
          if (!body) continue;
          feedItems.push({
            id: item.uuid,
            type: 'note',
            text: body,
            domain: hostname,
            path,
            url: `https://${hostname}${path === '*' ? '/' : path}`,
            tag,
            theme: item.theme,
            timestamp: ts,
          });
        }
      }

      const bytes = new Blob([JSON.stringify(value)]).size;

      sites.push({
        hostname:  key,
        totalEdits: items.length,
        latestTs,
        counts,
        pathMap,
        bytes,
        tagCounts,
      });
    }

    return { sites, feedItems };
  }

  // Aggregate per-domain tag counts into a global map for the chip row.
  function computeGlobalTagCounts(sites) {
    const totals = {};
    for (const s of sites) {
      for (const [tag, n] of Object.entries(s.tagCounts || {})) {
        totals[tag] = (totals[tag] || 0) + n;
      }
    }
    return totals;
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
    const { hostname, totalEdits: total, latestTs, counts, pathMap, bytes } = site;

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

    if (bytes > 0) {
      const dot = document.createElement('span');
      dot.className = 'site-meta-dot';
      meta.appendChild(dot);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'site-size';
      sizeEl.textContent = formatBytes(bytes);
      sizeEl.title = `Approx. ${bytes.toLocaleString()} bytes stored for ${hostname}`;
      meta.appendChild(sizeEl);
    }

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
    // When a tag filter is active, surface the per-site match count so the
    // user sees *why* this domain is in the filtered view.
    if (activeTag && site.tagCounts?.[activeTag]) {
      const tagPill = document.createElement('span');
      tagPill.className = 'pill pill-tag';
      const dot = document.createElement('span');
      dot.className = 'pill-dot';
      tagPill.appendChild(dot);
      tagPill.appendChild(document.createTextNode(`#${activeTag} · ${site.tagCounts[activeTag]}`));
      pills.appendChild(tagPill);
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
        <polyline points="3 6 17 6"/>
        <path d="M15 6v10a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
        <path d="M8 9v6"/><path d="M12 9v6"/>
        <path d="M8 6V4h4v2"/>
      </svg>`;
    btnDelete.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageCount = pathMap.size;
      const ok = await window.AdnotaUI.confirmDialog({
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

    // Sort paths: '*' domain-wide last, then alphabetical. When a tag filter
    // is active, drop paths that have no matching tagged items so the drawer
    // stays focused on what the user asked for.
    const sortedPaths = [...pathMap.keys()]
      .filter(path => !activeTag || tagMatchCount(pathMap.get(path)) > 0)
      .sort((a, b) => {
        if (a === '*') return 1;
        if (b === '*') return -1;
        return a.localeCompare(b);
      });

    for (const path of sortedPaths) {
      const items = pathMap.get(path);
      const pageCounts = pageCountsFromItems(items);
      const pageTagMatches = tagMatchCount(items);

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
      if (activeTag && pageTagMatches > 0) {
        const tagPill = document.createElement('span');
        tagPill.className = 'pill pill-tag';
        const dot = document.createElement('span');
        dot.className = 'pill-dot';
        tagPill.appendChild(dot);
        tagPill.appendChild(document.createTextNode(`#${activeTag} · ${pageTagMatches}`));
        pagePillsEl.appendChild(tagPill);
      }
      row.appendChild(pagePillsEl);

      drawerInner.appendChild(row);
    }

    drawer.appendChild(drawerInner);
    card.appendChild(drawer);

    return card;
  }

  // ─── State ───────────────────────────────────────────────────────────────
  let allSites = [];
  let allFeedItems = [];
  let globalTagCounts = {};
  let activeTag = null;              // null means "All" — no tag filter applied
  let activeTab = 'snippets';        // 'snippets' | 'sites'
  let feedType = 'all';              // 'all' | 'highlights' | 'notes'
  const sortValues = {               // per-tab sort; each tab remembers its own
    snippets: 'newest',
    sites:    'recent',
  };

  // ── Tag filter URL hash plumbing ─────────────────────────────────────────
  // Filter state survives reloads and can be shared as a link.
  function readActiveTagFromHash() {
    const m = /^#tag=(.+)$/.exec(location.hash || '');
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (err) { return null; }
  }

  function writeActiveTagToHash(tag) {
    if (tag) {
      const encoded = encodeURIComponent(tag);
      if (location.hash !== `#tag=${encoded}`) {
        history.replaceState(null, '', `${location.pathname}${location.search}#tag=${encoded}`);
      }
    } else if (location.hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  }

  function setActiveTag(tag) {
    activeTag = tag || null;
    writeActiveTagToHash(activeTag);
    render();
  }

  function renderTagFilter() {
    // Sort by usage count desc, ties broken alphabetically. Most-used tags
    // first means the chip row stays useful even as tags proliferate — the
    // high-signal entries stay visible before any horizontal scrolling.
    const sortedTags = Object.keys(globalTagCounts).sort((a, b) =>
      (globalTagCounts[b] - globalTagCounts[a]) || a.localeCompare(b)
    );
    if (sortedTags.length === 0) {
      tagFilterBar.hidden = true;
      tagFilterBar.innerHTML = '';
      return;
    }

    tagFilterBar.hidden = false;
    tagFilterBar.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'tag-filter-label';
    label.textContent = 'Filter';
    tagFilterBar.appendChild(label);

    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'tag-chip' + (activeTag === null ? ' active' : '');
    allChip.textContent = 'All';
    allChip.addEventListener('click', () => setActiveTag(null));
    tagFilterBar.appendChild(allChip);

    for (const tag of sortedTags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeTag === tag ? ' active' : '');
      const hash = document.createElement('span');
      hash.className = 'tag-chip-hash';
      hash.textContent = '#';
      const name = document.createElement('span');
      name.className = 'tag-chip-name';
      name.textContent = tag;
      const count = document.createElement('span');
      count.className = 'tag-chip-count';
      count.textContent = globalTagCounts[tag];
      chip.appendChild(hash);
      chip.appendChild(name);
      chip.appendChild(count);
      chip.addEventListener('click', () => setActiveTag(activeTag === tag ? null : tag));
      tagFilterBar.appendChild(chip);
    }
  }

  // ─── Sort helpers ────────────────────────────────────────────────────────
  function sortSites(sites, order) {
    return [...sites].sort((a, b) => {
      switch (order) {
        case 'alpha':  return a.hostname.localeCompare(b.hostname);
        case 'count':  return b.totalEdits - a.totalEdits;
        case 'size':   return b.bytes - a.bytes;
        case 'recent':
        default:       return b.latestTs - a.latestTs;
      }
    });
  }

  function sortFeedItems(items, order) {
    const dir = order === 'oldest' ? 1 : -1;
    return [...items].sort((a, b) => (a.timestamp - b.timestamp) * dir);
  }

  // ─── Filter helpers ──────────────────────────────────────────────────────
  function filterSites(sites, query) {
    let result = sites;
    if (activeTag) {
      result = result.filter(s => (s.tagCounts?.[activeTag] || 0) > 0);
    }
    if (query) {
      const q = query.toLowerCase();
      result = result.filter(s => s.hostname.toLowerCase().includes(q));
    }
    return result;
  }

  function filterFeedItems(items, query) {
    let result = items;
    if (feedType === 'highlights') result = result.filter(it => it.type === 'highlight');
    else if (feedType === 'notes') result = result.filter(it => it.type === 'note');
    if (activeTag) {
      result = result.filter(it => it.tag === activeTag);
    }
    if (query) {
      const q = query.toLowerCase();
      result = result.filter(it =>
        it.text.toLowerCase().includes(q) ||
        it.domain.toLowerCase().includes(q)
      );
    }
    return result;
  }

  // Count items tagged with `activeTag` on a specific page (array of items).
  function tagMatchCount(items) {
    if (!activeTag) return 0;
    let n = 0;
    for (const it of items) {
      if (normalizeTag(it.tag) === activeTag) n++;
    }
    return n;
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

  function updateTabCounts() {
    tabSnippetsCount.textContent = allFeedItems.length;
    tabSitesCount.textContent = allSites.length;
  }

  // ─── Undo toast (Home-page specific) ─────────────────────────────────────
  // The lib/adnotaUI `softDeleteItems` helper is designed for in-page bulk
  // deletion (resolves selectors against the live DOM, etc.) and doesn't
  // fit the Home page where we're operating on remote domains' items.
  // This is the minimal toast + undo flow we need instead.
  let undoToastTimer;
  function showUndoToast(msg, onUndo, duration = 5000) {
    toast.innerHTML = '';
    toast.classList.add('has-undo');
    const label = document.createElement('span');
    label.className = 'toast-msg';
    label.textContent = msg;
    toast.appendChild(label);

    if (onUndo) {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'toast-undo';
      undoBtn.textContent = 'Undo';
      // Try/catch: a silent rejection inside onUndo used to make the undo
      // button look dead — click fired, nothing changed, no error shown.
      // Now any failure surfaces in the console for debugging.
      undoBtn.addEventListener('click', async () => {
        clearTimeout(undoToastTimer);
        try {
          await onUndo();
        } catch (err) {
          console.error('[Adnota Sites] Undo handler failed:', err);
        }
        toast.classList.remove('visible');
        toast.classList.remove('has-undo');
      });
      toast.appendChild(undoBtn);
    }

    toast.classList.add('visible');
    clearTimeout(undoToastTimer);
    undoToastTimer = setTimeout(() => {
      toast.classList.remove('visible');
      toast.classList.remove('has-undo');
    }, duration);
  }

  // ─── Per-item soft-delete ────────────────────────────────────────────────
  // Removes one HIGHLIGHT or NOTE from storage by its identifier, shows a
  // 5-second Undo toast. If the user clicks Undo, the snapshot is spliced
  // back in. The storage.onChanged listener naturally re-renders the feed
  // in both directions.
  //
  // Defensive: we deep-clone the snapshot (via JSON.parse/stringify) so
  // restoration can't be corrupted by anything else that touches the same
  // item reference in the meantime. Both delete and undo write paths are
  // wrapped in try/catch so a quota error or schema surprise surfaces in
  // the console instead of a silently-broken undo button.
  async function deleteFeedItem(item) {
    const domain = item.domain;
    const actionType = item.type === 'highlight' ? 'HIGHLIGHT' : 'NOTE';
    const idField = item.type === 'highlight' ? '_id' : 'uuid';
    let snapshot;

    try {
      const data = await chrome.storage.local.get(domain);
      const record = data[domain];
      if (!record?.items) return;

      const found = record.items.find(
        i => i.action === actionType && i[idField] === item.id
      );
      if (!found) return;
      snapshot = JSON.parse(JSON.stringify(found));

      record.items = record.items.filter(
        i => !(i.action === actionType && i[idField] === item.id)
      );
      await chrome.storage.local.set({ [domain]: record });
    } catch (err) {
      console.error('[Adnota Sites] Delete failed:', err);
      return;
    }

    const noun = item.type === 'highlight' ? 'Snippet' : 'Note';
    showUndoToast(`${noun} deleted`, async () => {
      const again = await chrome.storage.local.get(domain);
      const againRec = again[domain] || { items: [] };
      againRec.items = (againRec.items || []).concat([snapshot]);
      await chrome.storage.local.set({ [domain]: againRec });
    });
  }

  // ─── Feed rendering ──────────────────────────────────────────────────────
  // Quote block = the highlighted text, rendered as prose with a color-hint
  // left border. Thought block = the sticky note's body, rendered with a
  // theme-color strip. Both carry the same source chip underneath.

  function faviconImg(hostname) {
    const img = document.createElement('img');
    img.className = 'source-favicon';
    img.src = faviconUrl(hostname);
    img.alt = '';
    img.loading = 'lazy';
    img.width = 14; img.height = 14;
    return img;
  }

  function buildSourceChip(item) {
    const chip = document.createElement('div');
    chip.className = 'source-chip';

    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = `Open ${item.domain}${item.path !== '*' ? item.path : ''} in a new tab`;
    link.appendChild(faviconImg(item.domain));
    const host = document.createElement('span');
    host.className = 'source-host';
    host.textContent = item.domain;
    link.appendChild(host);
    chip.appendChild(link);

    const dot1 = document.createElement('span');
    dot1.className = 'source-dot';
    chip.appendChild(dot1);

    const time = document.createElement('span');
    time.className = 'source-time';
    time.textContent = relativeTime(item.timestamp);
    chip.appendChild(time);

    if (item.tag) {
      const dot2 = document.createElement('span');
      dot2.className = 'source-dot';
      chip.appendChild(dot2);

      const tag = document.createElement('span');
      tag.className = 'source-tag';
      tag.textContent = `#${item.tag}`;
      chip.appendChild(tag);
    }

    return chip;
  }

  // SVG path strings for action icons. Keeping them as constants lets the
  // copy button swap to a checkmark on success without building a new
  // button element each time.
  const ICON_COPY = `
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="11" height="11" rx="2"/>
      <path d="M4 14H3a1 1 0 01-1-1V3a1 1 0 011-1h10a1 1 0 011 1v1"/>
    </svg>`;
  const ICON_CHECK = `
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="4 10 8 14 16 6"/>
    </svg>`;
  // Trash path matches lib/adnotaUI.js ICONS.trash so Home and HUD toolbars
  // use visually identical trash icons. Straight-sided can + full-width
  // polyline top reads cleaner than the tapered variant it replaced.
  const ICON_TRASH = `
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="3 6 17 6"/>
      <path d="M15 6v10a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
      <path d="M8 9v6"/><path d="M12 9v6"/>
      <path d="M8 6V4h4v2"/>
    </svg>`;

  function buildCopyButton(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'feed-item-action feed-item-copy';
    btn.title = 'Copy text';
    btn.innerHTML = ICON_COPY;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(item.text);
      } catch (err) {
        console.error('[Adnota Sites] Copy failed:', err);
        return;
      }
      btn.classList.add('copied');
      btn.title = 'Copied';
      btn.innerHTML = ICON_CHECK;
      // Auto-revert so repeat copies feel natural — each press gives fresh
      // visual confirmation rather than being stuck in the "copied" state.
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = 'Copy text';
        btn.innerHTML = ICON_COPY;
      }, 1400);
    });
    return btn;
  }

  function buildTrashButton(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'feed-item-action feed-item-trash';
    btn.title = item.type === 'highlight' ? 'Delete this quote' : 'Delete this note';
    btn.innerHTML = ICON_TRASH;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteFeedItem(item);
    });
    return btn;
  }

  // Action bar in the top-right of every feed card. Hover-reveal so it
  // doesn't clutter the prose at rest. Redactions get no copy button (the
  // feed intentionally hides the underlying text for them).
  function buildActionsBar(item) {
    const bar = document.createElement('div');
    bar.className = 'feed-item-actions';
    if (!isRedaction(item)) bar.appendChild(buildCopyButton(item));
    bar.appendChild(buildTrashButton(item));
    return bar;
  }

  // A `click` event fires after a drag-select on mouseup, which was hijacking
  // the user's text selection by opening the source in a new tab. Guard by
  // checking for a live non-collapsed selection inside the block at click
  // time — if they just selected text, leave them alone.
  function attachFeedItemClick(block, item) {
    block.addEventListener('click', (e) => {
      if (e.target.closest('.source-link') || e.target.closest('.feed-item-action')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && block.contains(sel.anchorNode)) return;
      window.open(item.url, '_blank', 'noopener');
    });
  }

  function buildQuoteBlock(item) {
    const block = document.createElement('article');
    block.className = 'feed-item feed-quote';
    block.dataset.id = item.id;

    if (isRedaction(item)) {
      block.classList.add('feed-quote-redaction');
      block.style.setProperty('--quote-color', '#1a1a1a');
      const bar = document.createElement('div');
      bar.className = 'redaction-bar';
      // Roughly mimic the length of the original text with block glyphs,
      // clamped so a single long highlight doesn't dominate the feed.
      const n = Math.max(6, Math.min(48, item.text.length));
      bar.textContent = '█'.repeat(n);
      bar.title = 'Redacted';
      block.appendChild(bar);
    } else {
      block.style.setProperty('--quote-color', themeHex(item.color));
      const body = document.createElement('p');
      body.className = 'feed-text';
      body.textContent = (item.text || '').trim() || '(empty highlight)';
      block.appendChild(body);
    }

    block.appendChild(buildSourceChip(item));
    block.appendChild(buildActionsBar(item));
    attachFeedItemClick(block, item);
    return block;
  }

  function buildThoughtBlock(item) {
    const block = document.createElement('article');
    block.className = 'feed-item feed-thought';
    block.dataset.id = item.id;
    block.style.setProperty('--thought-color', themeHex(item.theme, '#FBE6A1'));

    const body = document.createElement('p');
    body.className = 'feed-text';
    body.textContent = item.text;
    block.appendChild(body);

    block.appendChild(buildSourceChip(item));
    block.appendChild(buildActionsBar(item));
    attachFeedItemClick(block, item);
    return block;
  }

  function renderProseFeed() {
    const query = searchInput.value.trim();
    const order = sortValues.snippets;
    const filtered = filterFeedItems(sortFeedItems(allFeedItems, order), query);

    proseFeed.innerHTML = '';

    // Three-way state: nothing captured at all → empty; captures exist but
    // filter narrowed to zero → no-results; otherwise → render items.
    if (allFeedItems.length === 0) {
      feedStateEmpty.hidden = false;
      feedStateNoResults.hidden = true;
      proseFeed.hidden = true;
      return;
    }
    feedStateEmpty.hidden = true;

    if (filtered.length === 0) {
      feedStateNoResults.hidden = false;
      proseFeed.hidden = true;
      return;
    }
    feedStateNoResults.hidden = true;
    proseFeed.hidden = false;

    for (const item of filtered) {
      proseFeed.appendChild(
        item.type === 'highlight' ? buildQuoteBlock(item) : buildThoughtBlock(item)
      );
    }
  }

  function renderSitesList() {
    const query = searchInput.value.trim();
    const order = sortValues.sites;
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
  }

  // Master render — recomputes chips + tab counts, then renders both panes.
  // Rendering the inactive pane is cheap (DOM insert, no paint) and keeps
  // the hand-off on tab switch instant.
  function render() {
    globalTagCounts = computeGlobalTagCounts(allSites);
    // Reset activeTag if the user's chosen tag no longer exists anywhere.
    if (activeTag && !globalTagCounts[activeTag]) {
      activeTag = null;
      writeActiveTagToHash(null);
    }
    renderTagFilter();
    updateTabCounts();

    renderProseFeed();
    renderSitesList();

    updateSummary(allSites); // summary always reflects total, not filtered
  }

  // ─── Tab / type / sort controllers ───────────────────────────────────────
  function applyTabChrome() {
    // Visibility
    viewSnippets.hidden = activeTab !== 'snippets';
    viewSites.hidden    = activeTab !== 'sites';

    // Tab button states
    tabSnippets.classList.toggle('active', activeTab === 'snippets');
    tabSites.classList.toggle('active', activeTab === 'sites');
    tabSnippets.setAttribute('aria-selected', activeTab === 'snippets' ? 'true' : 'false');
    tabSites.setAttribute('aria-selected', activeTab === 'sites' ? 'true' : 'false');

    // Search + sort adapt per tab
    searchInput.placeholder = SEARCH_PLACEHOLDER[activeTab];
    renderSortOptions();
  }

  function renderSortOptions() {
    const options = SORT_OPTIONS[activeTab];
    const current = sortValues[activeTab];
    sortSelect.innerHTML = '';
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === current) el.selected = true;
      sortSelect.appendChild(el);
    }
  }

  function setActiveTab(tab) {
    if (tab !== 'snippets' && tab !== 'sites') return;
    if (tab === activeTab) return;
    activeTab = tab;
    chrome.storage.local.set({ [TAB_KEY]: activeTab });
    applyTabChrome();
    // No need to re-render items — both panes were painted by render();
    // we just toggled visibility.
  }

  function setFeedType(type) {
    if (!['all', 'highlights', 'notes'].includes(type)) return;
    if (type === feedType) return;
    feedType = type;
    chrome.storage.local.set({ [TYPE_KEY]: feedType });
    for (const chip of feedTypeFilter.querySelectorAll('.feed-type-chip')) {
      chip.classList.toggle('active', chip.dataset.type === feedType);
    }
    renderProseFeed();
  }

  // ─── Initial load ────────────────────────────────────────────────────────
  try {
    const { sites, feedItems } = await loadAllData();
    allSites = sites;
    allFeedItems = feedItems;
  } catch (err) {
    console.error('[Adnota Sites] Failed to load storage:', err);
    allSites = [];
    allFeedItems = [];
  }

  // Restore view state. Per-tab sort lives in chrome.storage (not URL) so
  // it's device-local and doesn't pollute shareable tag-filter links.
  const saved = await chrome.storage.local.get([
    TAB_KEY, TYPE_KEY, SORT_SNIPPETS_KEY, SORT_SITES_KEY,
  ]);
  if (saved[TAB_KEY] === 'sites' || saved[TAB_KEY] === 'snippets') activeTab = saved[TAB_KEY];
  if (['all', 'highlights', 'notes'].includes(saved[TYPE_KEY])) feedType = saved[TYPE_KEY];
  if (SORT_OPTIONS.snippets.some(o => o.value === saved[SORT_SNIPPETS_KEY])) {
    sortValues.snippets = saved[SORT_SNIPPETS_KEY];
  }
  if (SORT_OPTIONS.sites.some(o => o.value === saved[SORT_SITES_KEY])) {
    sortValues.sites = saved[SORT_SITES_KEY];
  }

  // Seed the Snippets type-filter active chip to match restored state.
  for (const chip of feedTypeFilter.querySelectorAll('.feed-type-chip')) {
    chip.classList.toggle('active', chip.dataset.type === feedType);
  }

  activeTag = readActiveTagFromHash();
  stateLoading.hidden = true;
  updateStorageMeter();
  applyTabChrome();
  render();

  // Hash changes (e.g. user edits the URL or hits Back/Forward) resync the
  // active tag filter. Guarded so we don't re-render when we wrote the hash
  // ourselves to reflect an in-page chip click.
  window.addEventListener('hashchange', () => {
    const fromHash = readActiveTagFromHash();
    if (fromHash !== activeTag) {
      activeTag = fromHash;
      render();
    }
  });

  // ─── Search wiring ────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    searchClear.hidden = searchInput.value.length === 0;
    // Search predicates differ per tab but both panes always re-render,
    // so a single render() handles both Snippets and Sites filtering.
    render();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    searchInput.focus();
    render();
  });

  // ─── Sort wiring ──────────────────────────────────────────────────────────
  sortSelect.addEventListener('change', () => {
    const newValue = sortSelect.value;
    sortValues[activeTab] = newValue;
    const key = activeTab === 'snippets' ? SORT_SNIPPETS_KEY : SORT_SITES_KEY;
    chrome.storage.local.set({ [key]: newValue });
    // Only re-render the active pane's items — the other tab's sort hasn't
    // changed, and we'd waste work rebuilding its DOM.
    if (activeTab === 'snippets') renderProseFeed();
    else renderSitesList();
  });

  // ─── Tab wiring ──────────────────────────────────────────────────────────
  tabSnippets.addEventListener('click', () => setActiveTab('snippets'));
  tabSites.addEventListener('click', () => setActiveTab('sites'));

  // ─── Type filter wiring ──────────────────────────────────────────────────
  feedTypeFilter.addEventListener('click', (e) => {
    const chip = e.target.closest('.feed-type-chip');
    if (!chip) return;
    setFeedType(chip.dataset.type);
  });

  // ─── Bug-report popover ──────────────────────────────────────────────────
  // Floating button (bottom-right) → small note + clickable mailto link.
  // Pre-release feedback path; opt-in click so the page stays calm at rest.
  (() => {
    const root = document.getElementById('bug-report');
    if (!root) return;
    const btn = document.getElementById('bug-report-btn');
    const pop = document.getElementById('bug-report-popover');
    const setOpen = (open) => {
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(pop.hidden);
    });
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (!root.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) setOpen(false);
    });
  })();

  // ─── Live storage updates ─────────────────────────────────────────────────
  // Re-build data model whenever storage changes (e.g. user made an edit on
  // another tab while the Sites page was open).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    // Skip if every changed key is view-state/reserved — nothing to re-read.
    const changedKeys = Object.keys(changes);
    if (changedKeys.every(k => RESERVED_KEYS.has(k))) return;

    const { sites, feedItems } = await loadAllData();
    allSites = sites;
    allFeedItems = feedItems;
    updateStorageMeter();
    render();
  });
})();
