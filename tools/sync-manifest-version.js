#!/usr/bin/env node
// Mirror package.json's version into manifest.json. Runs from npm's `version`
// lifecycle so `npm version patch|minor|major` keeps both files (and the git
// tag npm creates) aligned in one shot.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const pkgVersion = require(path.join(root, 'package.json')).version;

const raw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

if (manifest.version === pkgVersion) {
  console.log(`manifest.json already at ${pkgVersion}`);
  process.exit(0);
}

const prev = manifest.version;
manifest.version = pkgVersion;
// Preserve trailing newline if the source had one.
const trailing = raw.endsWith('\n') ? '\n' : '';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + trailing);
console.log(`manifest.json: ${prev} → ${pkgVersion}`);
