// Replay a fixture's ops against the current code, diff the resulting state
// against the pinned outcomes.json. Exit 0 on match, 1 on drift.
//
// Usage: node scripts/replay.js --site=bing

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, teardown, getWorker } from './lib/loadExtension.js';
import { runOps } from './lib/runOps.js';
import { captureState } from './lib/captureState.js';
import { diffState, formatDiffs } from './lib/diff.js';

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
const outcomesPath = path.join(fixtureDir, 'outcomes.json');
const expected = JSON.parse(await fs.readFile(outcomesPath, 'utf8'));

console.log(`[replay:${siteId}] launching browser with extension`);
const session = await launchWithExtension({ viewport: ops.viewport });

let exitCode = 0;
try {
  const page = await session.context.newPage();
  console.log(`[replay:${siteId}] navigating to ${ops.url}`);
  await page.goto(ops.url, { waitUntil: 'domcontentloaded' });

  if (ops.settleMs) await page.waitForTimeout(ops.settleMs);

  console.log(`[replay:${siteId}] running ${ops.ops.length} ops`);
  await runOps(page, ops.ops);

  if (ops.postSettleMs) await page.waitForTimeout(ops.postSettleMs);

  const worker = await getWorker(session.context, page);
  const actual = await captureState({
    page,
    worker,
    domInvariants: ops.domInvariants ?? [],
  });

  // Compare only the captured fields, not the metadata wrapper. The pinned
  // baseline includes $schema/site/pinnedAt that aren't part of the diff.
  const expectedShape = {
    storage: expected.storage,
    styleOverrides: expected.styleOverrides,
    eraseOverrides: expected.eraseOverrides,
    domInvariants: expected.domInvariants,
  };

  const diffs = diffState(expectedShape, actual);
  const invariantFails = actual.domInvariants.filter(i => i.result === false || (i.result && typeof i.result === 'object' && i.result.error));

  if (diffs.length === 0 && invariantFails.length === 0) {
    console.log(`[replay:${siteId}] PASS`);
    console.log(`  invariants: ${actual.domInvariants.map(i => `${i.name}=${JSON.stringify(i.result)}`).join(', ') || '(none)'}`);
  } else {
    console.error(`[replay:${siteId}] FAIL`);
    if (invariantFails.length) {
      console.error('\nFailed invariants:');
      for (const inv of invariantFails) {
        console.error(`  ${inv.name}: result=${JSON.stringify(inv.result)}`);
        console.error(`    expr: ${inv.expr}`);
      }
    }
    if (diffs.length) {
      console.error(`\nState drift (${diffs.length} difference${diffs.length === 1 ? '' : 's'}):`);
      console.error(formatDiffs(diffs));
    }
    exitCode = 1;
  }
} catch (err) {
  console.error(`[replay:${siteId}] ERROR:`, err);
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
