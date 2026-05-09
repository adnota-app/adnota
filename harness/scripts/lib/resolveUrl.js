// fixture://<id> URL resolution. ops.json stores the logical URL; the harness
// resolves it just-in-time so live URLs and snapshot-backed ones can coexist.

import path from 'node:path';
import fs from 'node:fs/promises';
import { startFixtureServer } from './fixtureServer.js';

export async function resolveOpsUrl(opsUrl, harnessDir) {
  if (!opsUrl.startsWith('fixture://')) {
    return { url: opsUrl, stop: async () => {} };
  }
  const id = opsUrl.slice('fixture://'.length);
  const fixturePath = path.join(harnessDir, 'fixtures', id, 'page.html');
  try {
    await fs.access(fixturePath);
  } catch {
    throw new Error(
      `fixture://${id}: no page.html at fixtures/${id}/page.html\n` +
      `  capture one with: node scripts/snapshot.js --site=${id} --url='<live-url>'`
    );
  }
  return await startFixtureServer(fixturePath);
}
