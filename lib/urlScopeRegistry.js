// lib/urlScopeRegistry.js
//
// Curated list of domains where RESIZE's default "site-wide" scope causes
// cross-app bleed because distinct sub-apps share a hostname (and sometimes
// a path) but render under wildly different layouts. Canonical case:
// google.com web search and image search both live at /search and differ
// only by the `udm` query param — a site-wide resize rule from one bleeds
// into the other and visually breaks it.
//
// For listed domains, RESIZE saves use the matched scope id (e.g.
// `scope:google-web`) as the storage `path` instead of `'*'`. Loads only
// surface rules whose scope matches the current URL. Domains not listed
// here keep the existing site-wide default — un-listed sites are the 95%
// where site-wide works fine and surprising scoping would be the worse bug.
//
// Adding an entry: define hostname regex + scope predicates in
// most-specific-first order. Predicates receive a parsed URL. Return null
// (no match) when the URL is on a curated domain but no specific scope
// applies — the caller falls back to '*', preserving today's behavior for
// un-mapped paths on a partially-curated site.

const SCOPES = [
  {
    hostname: /^(www\.)?google\.com$/i,
    scopes: [
      // Image search: same /search path as web, distinguished by `udm=2`.
      // This is the originally-reported bleed case.
      { id: 'google-images', match: (u) => u.pathname === '/search' && u.searchParams.get('udm') === '2' },
      // Web search: any /search URL without a more-specific udm match
      // (image, etc.) falls here. Order matters — image must be checked
      // first because it also satisfies this predicate.
      { id: 'google-web',    match: (u) => u.pathname === '/search' },
    ],
  },
];

function resolveScope(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  for (const entry of SCOPES) {
    if (!entry.hostname.test(url.hostname)) continue;
    for (const s of entry.scopes) {
      let hit = false;
      try { hit = !!s.match(url); } catch { hit = false; }
      if (hit) return `scope:${s.id}`;
    }
    // Domain matched but no specific scope did — return null so the caller
    // falls back to '*'. Avoids surprise-narrowing of resizes made on
    // unfamiliar pages of a partially-curated domain (e.g. google.com/about).
    return null;
  }
  return null;
}

window.AdnotaUrlScopeRegistry = { resolveScope };
