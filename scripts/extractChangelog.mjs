#!/usr/bin/env node
/**
 * Extract a single version's section from CHANGELOG.md.
 *
 * Usage:
 *   node scripts/extractChangelog.mjs 0.2.0     # prints the [0.2.0] block to stdout
 *
 * Used by `docs/RELEASE.md` step 10 to populate the GitHub Release notes
 * from the canonical changelog rather than re-typing them.
 *
 * Format expected (Keep a Changelog):
 *   ## [X.Y.Z] — YYYY-MM-DD
 *   ...lines...
 *   ## [next]      <-- terminates the block
 *
 * Exit non-zero if the version isn't found so CI scripts can short-circuit.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = resolve(__dirname, '..', 'CHANGELOG.md');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: extractChangelog.mjs <version>\n');
  process.exit(2);
}

const text = readFileSync(CHANGELOG, 'utf8');
const lines = text.split('\n');

// Match `## [0.2.0]` or `## [0.2.0] — date`. Allow `v0.2.0` variant too.
const versionPattern = new RegExp(`^## \\[v?${version.replace(/\./g, '\\.')}\\]`);
const anyHeaderPattern = /^## \[/;

let start = -1;
let end = lines.length;
for (let i = 0; i < lines.length; i++) {
  if (start === -1 && versionPattern.test(lines[i])) {
    start = i;
    continue;
  }
  if (start !== -1 && anyHeaderPattern.test(lines[i])) {
    end = i;
    break;
  }
}

if (start === -1) {
  process.stderr.write(`version ${version} not found in CHANGELOG.md\n`);
  process.exit(1);
}

const block = lines.slice(start, end).join('\n').replace(/\s+$/, '') + '\n';
process.stdout.write(block);
