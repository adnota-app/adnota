// pages/welcome.js — wires up the welcome page's one bit of dynamic state.
//
// MV3 extension pages run under a default CSP that blocks inline scripts, so
// this lives in a separate file. The link's href starts as "#" so it scrolls
// to top if this script fails to load — chrome.runtime.getURL gives us the
// real chrome-extension://<id>/pages/sites.html target.

(function () {
  const link = document.getElementById('open-sites-link');
  if (link && typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    link.href = chrome.runtime.getURL('pages/sites.html');
  }
})();
