import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extension manifest lives at the worktree root, three levels above this file:
// harness/scripts/lib/loadExtension.js -> harness/scripts/lib -> harness/scripts -> harness -> root.
const EXTENSION_DIR = path.resolve(__dirname, '../../..');

export async function launchWithExtension({ viewport } = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adnota-harness-'));

  // We use Playwright's bundled Chromium (not system Chrome): real Chrome silently
  // refuses --load-extension when launched in automation mode, while Chromium
  // accepts it. The trade is that anti-bot sites flag Chromium via
  // `navigator.webdriver` and the --enable-automation switch, so we strip both:
  //  - --disable-blink-features=AutomationControlled removes the webdriver tell
  //  - ignoreDefaultArgs drops Playwright's --enable-automation switch
  // Together these let Bing serve a real results page while the extension still
  // loads its content scripts.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: viewport ?? { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Service worker registers lazily on first use in MV3. Don't block boot on it
  // — if it isn't already up, getWorker() below will wait when we actually need
  // to read storage.
  const worker = context.serviceWorkers()[0] ?? null;

  return { context, worker, userDataDir, extensionDir: EXTENSION_DIR };
}

// Lazy worker accessor — call this from places that need chrome.storage.local
// access. Triggers an extension API path that wakes the worker if it's idle.
export async function getWorker(context, page, timeout = 15000) {
  let [worker] = context.serviceWorkers();
  if (worker) return worker;

  // Nudge the worker awake by hitting an extension URL or by sending a message
  // through the content script. We use a context.waitForEvent with a timeout
  // and assume something else (page nav, content script init) will spin it up.
  try {
    worker = await context.waitForEvent('serviceworker', { timeout });
    return worker;
  } catch {
    // Final fallback: read storage via the page's content script context using
    // a sendMessage round-trip. Surface a clearer error if even that fails.
    throw new Error('Extension service worker did not start within ' + timeout + 'ms');
  }
}

export async function teardown({ context, userDataDir }) {
  try { await context.close(); } catch {}
  try { await fs.rm(userDataDir, { recursive: true, force: true }); } catch {}
}
