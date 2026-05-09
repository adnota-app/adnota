// Capture a page's rendered HTML into fixtures/<id>/page.html. The snapshot
// is a stable test target: subsequent record/capture/replay runs serve it
// from a localhost HTTP server instead of hitting the live site, eliminating
// content rotation, autofocus interception, anti-bot, and network flakiness.
//
// Usage:
//   node scripts/snapshot.js --site=<id> --url='<live-url>'
//
// What gets saved:
//   - The post-render outerHTML (so SPAs that render via JS still capture
//     their hydrated DOM)
//   - All same-origin and cross-origin stylesheets, fetched and inlined as
//     <style> tags so the page renders without external requests
//
// What gets stripped:
//   - All <script> tags. The DOM is already rendered by the time we capture;
//     scripts on replay would re-run, hit removed dependencies, and possibly
//     redirect or mutate the snapshot. Better to freeze the DOM as-is.

import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const siteId = args.site;
const url = args.url;
if (!siteId || !url) {
  console.error("Usage: node scripts/snapshot.js --site=<id> --url='<live-url>'");
  console.error("       (quote the URL: zsh treats ? and & as special)");
  process.exit(2);
}

const fixtureDir = path.join(HARNESS_DIR, 'fixtures', siteId);
await fs.mkdir(fixtureDir, { recursive: true });

console.log(`[snapshot:${siteId}] launching browser`);
const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-blink-features=AutomationControlled',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

let exitCode = 0;
try {
  console.log(`[snapshot:${siteId}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Try networkidle (best for SPAs that finish rendering after a few requests)
  // but don't fail if the site keeps a websocket or polling connection open.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Extra settle for SPAs that render after networkidle.
  await page.waitForTimeout(2000);

  console.log(`[snapshot:${siteId}] inlining stylesheets`);
  const inlineCount = await inlineStylesheets(page);
  console.log(`[snapshot:${siteId}] inlined ${inlineCount} stylesheets`);

  await page.evaluate(() => {
    document.querySelectorAll('script').forEach(s => s.remove());
  });

  // Inject <base href> so relative asset URLs (images, fonts, background-image
  // url(...) inside CSS) resolve against the original origin instead of
  // localhost. Without this, every relative <img src="/..."> 404s on replay
  // and the snapshot renders unstyled. Forms and links also redirect to the
  // original origin, but Adnota's tools don't normally trigger navigation.
  await page.evaluate((origin) => {
    if (!document.querySelector('base[href]')) {
      const base = document.createElement('base');
      base.href = origin + '/';
      document.head.prepend(base);
    }
  }, new URL(url).origin);

  const html = await page.content();
  const outPath = path.join(fixtureDir, 'page.html');
  await fs.writeFile(outPath, html, 'utf8');
  console.log(`[snapshot:${siteId}] wrote ${path.relative(HARNESS_DIR, outPath)} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Record against the snapshot:`);
  console.log(`       node scripts/record.js --site=${siteId} --url='fixture://${siteId}'`);
  console.log(`  2. Replay later:`);
  console.log(`       node scripts/replay.js --site=${siteId}`);
} catch (err) {
  console.error(`[snapshot:${siteId}] FAILED:`, err);
  exitCode = 1;
} finally {
  try { await browser.close(); } catch {}
}

process.exit(exitCode);


async function inlineStylesheets(page) {
  // Pull every stylesheet's URL (and media query, if any) from the DOM. Then
  // fetch each one through page.request so cookies/origin-bound headers
  // are inherited, and replace the <link> with an inline <style>.
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('link[rel="stylesheet"], link[type="text/css"]')]
      .map(el => ({ href: el.href, media: el.media || '' }));
  });

  let count = 0;
  for (const link of links) {
    if (!link.href) continue;
    try {
      const resp = await page.request.get(link.href, { timeout: 10000 });
      if (!resp.ok()) continue;
      const css = await resp.text();
      const replaced = await page.evaluate(({ href, css, media }) => {
        const target = [...document.querySelectorAll('link[rel="stylesheet"], link[type="text/css"]')]
          .find(el => el.href === href);
        if (!target) return false;
        const style = document.createElement('style');
        if (media) style.media = media;
        style.textContent = css;
        target.replaceWith(style);
        return true;
      }, { href: link.href, css, media: link.media });
      if (replaced) count++;
    } catch {
      // Skip stylesheets we can't fetch (CORS, 4xx, timeouts). The page may
      // render slightly off but the DOM structure — what we test against —
      // is preserved.
    }
  }
  return count;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
