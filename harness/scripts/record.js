// Interactive recorder: launches a real browser with the extension, streams
// user pointer/key events back via console.log, reduces them to typed ops,
// and writes fixtures/<site>/ops.json.
//
// Stop the recording with Alt+Shift+S inside the browser (preferred) or Ctrl+C
// in this terminal. The shim path is more reliable — Playwright installs its
// own SIGINT handler that races ours and can kill the process before the file
// gets written.
//
// Usage:
//   node scripts/record.js --site=<id> --url='<url>' [--no-capture]

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, teardown } from './lib/loadExtension.js';
import { reduceEvents } from './lib/reduceRecording.js';
import { resolveOpsUrl } from './lib/resolveUrl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const siteId = args.site;
const startUrl = args.url;
if (!siteId || !startUrl) {
  console.error("Usage: node scripts/record.js --site=<id> --url='<url>' [--no-capture]");
  console.error("       (quote the URL: zsh treats ? and & as special)");
  process.exit(2);
}

const fixtureDir = path.join(HARNESS_DIR, 'fixtures', siteId);
await fs.mkdir(fixtureDir, { recursive: true });

const sitesPath = path.join(HARNESS_DIR, 'sites.json');

const shimPath = path.join(__dirname, 'lib', 'recorderShim.js');
const shimSource = await fs.readFile(shimPath, 'utf8');

console.log(`[record:${siteId}] launching browser`);
const session = await launchWithExtension({ viewport: { width: 1280, height: 900 } });

const events = [];
let stopping = false;
let resolveStop;
const stopPromise = new Promise(r => { resolveStop = r; });

const requestStop = (reason) => {
  if (stopping) return;
  stopping = true;
  console.log(`[record:${siteId}] stop signal: ${reason}`);
  resolveStop();
};

session.context.on('console', msg => {
  const text = msg.text();
  if (!text.startsWith('[ADNOTA_RECORD]')) return;
  let ev;
  try { ev = JSON.parse(text.slice('[ADNOTA_RECORD]'.length)); }
  catch { return; }

  if (ev.type === 'stop') { requestStop('Alt+Shift+S in browser'); return; }

  events.push(ev);
  echoEvent(ev);
});

// Backup stop signal: Ctrl+C in the terminal. Playwright also hooks SIGINT,
// so the post-stop write path needs to happen BEFORE any awaited Playwright
// call — see the doStop() function below.
process.on('SIGINT', () => requestStop('Ctrl+C'));

// Inject the shim at every navigation in this context.
await session.context.addInitScript({ content: shimSource });

// Resolve fixture://<id> URLs to a localhost server so the recording uses the
// same stable target replay will see. The recording's ops.json keeps the
// logical URL (fixture://<id>) so the replay can re-resolve it.
const resolved = await resolveOpsUrl(startUrl, HARNESS_DIR);

const page = await session.context.newPage();
console.log(`[record:${siteId}] navigating to ${startUrl}${resolved.url !== startUrl ? ` (served from ${resolved.url})` : ''}`);
await page.goto(resolved.url, { waitUntil: 'domcontentloaded' });

console.log('');
console.log('  ▸ Recording. Perform the workflow you want to lock in.');
console.log('  ▸ Stop with Alt+Shift+S in the browser, or Ctrl+C here.');
console.log('');

await stopPromise;

await doStop();

async function doStop() {
  console.log('');
  console.log(`[record:${siteId}] stopping (captured ${events.length} raw events)`);

  // Snapshot viewport BEFORE teardown — afterwards page is gone.
  let viewport = { width: 1280, height: 900 };
  try { viewport = page.viewportSize() ?? viewport; } catch {}

  const ops = reduceEvents(events, { initialUrl: startUrl, viewport });

  // Write ops.json BEFORE teardown so a SIGINT-induced abort can't lose data.
  if (ops.length > 0) {
    const opsJson = {
      url: startUrl,
      viewport,
      settleMs: 2500,
      postSettleMs: 400,
      ops: [{ type: 'waitForDock' }, ...ops],
      domInvariants: [],
    };
    const opsPath = path.join(fixtureDir, 'ops.json');
    await fs.writeFile(opsPath, JSON.stringify(opsJson, null, 2) + '\n', 'utf8');
    console.log(`[record:${siteId}] wrote ${path.relative(HARNESS_DIR, opsPath)} (${ops.length} ops)`);
    for (const op of ops) console.log(`    ${formatOp(op)}`);

    // Register in sites.json now that the fixture has real content.
    try {
      const sites = JSON.parse(await fs.readFile(sitesPath, 'utf8'));
      if (!sites.sites.find(s => s.id === siteId)) {
        sites.sites.push({ id: siteId, fixture: `fixtures/${siteId}` });
        await fs.writeFile(sitesPath, JSON.stringify(sites, null, 2) + '\n', 'utf8');
        console.log(`[record:${siteId}] added to sites.json`);
      }
    } catch (err) {
      console.warn(`[record:${siteId}] could not update sites.json: ${err.message}`);
    }
  } else {
    const histogram = events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
    console.error(`[record:${siteId}] no recognized ops produced from ${events.length} raw events.`);
    console.error(`  histogram: ${Object.entries(histogram).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.error('');
    console.error('  The reducer recognizes:');
    console.error('    - clicks on dock tool buttons   (sel like [data-tool-id="resizer"])');
    console.error('    - drags on resizer handles      (sel like .adnota-resizer-handle-bottom)');
    console.error('    - clicks on non-Adnota elements (after a tool is active)');
    console.error('    - bare keys e/r/s/d, Alt+A, Alt+S, Ctrl+Z, Escape');
    console.error('');
    console.error('  Tip: if the dock did not hover-expand, press `r` to activate the resizer');
    console.error('  via bare-key, then hover/click/drag.');
  }

  if (ops.length === 0) {
    try { await teardown(session); } catch {}
    process.exit(1);
  }

  if (args['no-capture']) {
    try { await teardown(session); } catch {}
    console.log('');
    console.log('  ▸ Skipped capture (--no-capture). When ready, run:');
    console.log(`      node scripts/capture.js --site=${siteId}`);
    process.exit(0);
  }

  // Spawn capture BEFORE teardown so a SIGINT-induced exit during the await
  // can't kill the auto-capture flow. detached:true puts the child in its own
  // process group — Ctrl+C in the recorder's terminal hits this process's
  // group, but the detached child stays alive.
  console.log('');
  console.log(`[record:${siteId}] running capture to write outcomes.json baseline`);
  const proc = spawn(process.execPath, [path.join(__dirname, 'capture.js'), `--site=${siteId}`], {
    stdio: 'inherit',
    cwd: HARNESS_DIR,
    detached: true,
  });

  // Watchdog: if the capture child hangs (Chromium teardown can deadlock with
  // --load-extension), force-exit the parent after 90s. The spawn is
  // detached so the child can keep running in the background if it's still
  // making progress.
  const watchdog = setTimeout(() => {
    console.warn(`[record:${siteId}] capture child still running after 90s — releasing terminal. Ctrl+C any leftover Chromium if needed.`);
    process.exit(0);
  }, 90000);
  proc.on('exit', code => {
    clearTimeout(watchdog);
    process.exit(code ?? 0);
  });

  // Teardown the recorder browser and fixture server in parallel with the
  // capture child.
  teardown(session).catch(() => {});
  resolved.stop().catch(() => {});
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

function echoEvent(ev) {
  if (ev.type === 'pointermove') return;
  if (ev.type === 'init') { console.log(`  · init at ${ev.data.url}`); return; }
  if (ev.type === 'pointerdown') {
    const mods = [ev.data.shift && 'shift', ev.data.alt && 'alt', ev.data.ctrl && 'ctrl', ev.data.meta && 'meta'].filter(Boolean).join('+');
    console.log(`  · pointerdown ${mods ? `(${mods}) ` : ''}-> ${ev.data.sel}`);
    return;
  }
  if (ev.type === 'pointerup') { console.log(`  · pointerup   -> ${ev.data.sel}`); return; }
  if (ev.type === 'keydown') {
    const mods = [ev.data.shift && 'shift', ev.data.alt && 'alt', ev.data.ctrl && 'ctrl', ev.data.meta && 'meta'].filter(Boolean).join('+');
    const key = mods ? `${mods}+${ev.data.key}` : ev.data.key;
    console.log(`  · key ${key}${ev.data.inField ? ' (in field)' : ''}`);
    return;
  }
}

function formatOp(op) {
  switch (op.type) {
    case 'activateTool':  return `activateTool ${op.tool}`;
    case 'hoverElement':  return `hoverElement ${op.selector}`;
    case 'clickToSelect': return `clickToSelect`;
    case 'dragHandle':    return `dragHandle ${op.handle} dx=${op.dx} dy=${op.dy}`;
    case 'pressKey':      return `pressKey ${[op.alt && 'Alt', op.ctrl && 'Ctrl', op.meta && 'Meta', op.shift && 'Shift', op.key].filter(Boolean).join('+')}`;
    default:              return JSON.stringify(op);
  }
}
