// One-time capture: run a fixture's ops against a live site, then write the
// resulting state to fixtures/<site>/outcomes.json as the pinned baseline.
//
// Usage: node scripts/capture.js --site=bing
//
// Re-running OVERWRITES outcomes.json. Commit the result so replay has a
// baseline to diff against.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, teardown, getWorker } from './lib/loadExtension.js';
import { runOps } from './lib/runOps.js';
import { captureState } from './lib/captureState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const siteId = args.site;
if (!siteId) {
  console.error('Missing required flag: --site=<id>');
  process.exit(2);
}

const sites = JSON.parse(await fs.readFile(path.join(HARNESS_DIR, 'sites.json'), 'utf8'));
const site = sites.sites.find(s => s.id === siteId);
if (!site) {
  console.error(`Unknown site "${siteId}". Known: ${sites.sites.map(s => s.id).join(', ')}`);
  process.exit(2);
}

const fixtureDir = path.join(HARNESS_DIR, site.fixture);
const ops = JSON.parse(await fs.readFile(path.join(fixtureDir, 'ops.json'), 'utf8'));

console.log(`[capture:${siteId}] launching browser with extension`);
const session = await launchWithExtension({ viewport: ops.viewport });
let exitCode = 0;
try {
  const page = await session.context.newPage();
  console.log(`[capture:${siteId}] navigating to ${ops.url}`);
  await page.goto(ops.url, { waitUntil: 'domcontentloaded' });

  if (ops.settleMs) await page.waitForTimeout(ops.settleMs);

  console.log(`[capture:${siteId}] running ${ops.ops.length} ops`);
  await runOps(page, ops.ops);

  if (ops.postSettleMs) await page.waitForTimeout(ops.postSettleMs);

  console.log(`[capture:${siteId}] capturing state`);
  const worker = await getWorker(session.context, page);
  const state = await captureState({
    page,
    worker,
    domInvariants: ops.domInvariants ?? [],
  });

  const outcomes = {
    $schema: '1',
    site: siteId,
    pinnedAt: new Date().toISOString().slice(0, 10),
    ...state,
  };

  const outPath = path.join(fixtureDir, 'outcomes.json');
  await fs.writeFile(outPath, JSON.stringify(outcomes, null, 2) + '\n', 'utf8');
  console.log(`[capture:${siteId}] wrote ${path.relative(HARNESS_DIR, outPath)}`);
  console.log(`[capture:${siteId}] storage hosts: ${Object.keys(state.storage).join(', ') || '(none)'}`);
  console.log(`[capture:${siteId}] invariants: ${state.domInvariants.map(i => `${i.name}=${JSON.stringify(i.result)}`).join(', ') || '(none)'}`);
} catch (err) {
  console.error(`[capture:${siteId}] FAILED:`, err);
  // Drop a debug screenshot so the next investigation has visual evidence.
  try {
    const pages = session.context.pages();
    if (pages.length) {
      const debugPath = path.join(fixtureDir, 'capture-debug.png');
      await pages[0].screenshot({ path: debugPath, fullPage: true });
      console.error(`[capture:${siteId}] debug screenshot: ${path.relative(HARNESS_DIR, debugPath)}`);
    }
  } catch {}
  exitCode = 1;
} finally {
  await teardown(session);
}

process.exit(exitCode);

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
