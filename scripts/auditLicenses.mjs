#!/usr/bin/env node
/**
 * License audit (M7 beta gate).
 *
 * Walks the production dependency closure (only what gets shipped in the
 * VSIX after the externalisation refactor) and asserts every license is
 * on the allow-list. Fails CI on any license that isn't.
 *
 * No new npm dep — uses the lockfile + per-package package.json so this
 * runs offline and is pinnable.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Liberal allowlist: anything genuinely permissive. Reject GPL/AGPL/LGPL
// outright — they have copyleft implications for redistribution. Reject
// "UNLICENSED" / "UNKNOWN" — we ship to a marketplace; we need the rights.
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

// Composite shapes vsce / npm sometimes report:
//   "(MIT OR Apache-2.0)"  ⇒ pass if any disjunct passes
//   "MIT AND BSD-3-Clause" ⇒ pass only if every conjunct passes
function isAllowed(licenseField) {
  if (typeof licenseField === 'object' && licenseField?.type) licenseField = licenseField.type;
  if (typeof licenseField !== 'string') return false;
  const trimmed = licenseField.trim().replace(/^\(|\)$/g, '');
  if (ALLOWED.has(trimmed)) return true;
  if (trimmed.includes(' OR ')) {
    return trimmed.split(/\s+OR\s+/).some((part) => isAllowed(part.trim()));
  }
  if (trimmed.includes(' AND ')) {
    return trimmed.split(/\s+AND\s+/).every((part) => isAllowed(part.trim()));
  }
  return false;
}

async function loadProductionDeps() {
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const out = new Map(); // name@version → license

  for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
    if (info.dev || info.devOptional) continue;
    if (!pkgPath.startsWith('node_modules/')) continue;
    const pkgJsonPath = path.join(root, pkgPath, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    const name = pkg.name ?? pkgPath.replace(/^node_modules\//, '');
    const version = pkg.version ?? info.version ?? 'unknown';
    const license = pkg.license ?? pkg.licenses ?? 'UNKNOWN';
    out.set(`${name}@${version}`, license);
  }
  return out;
}

const deps = await loadProductionDeps();
const violations = [];
for (const [pkg, license] of deps) {
  if (!isAllowed(license)) violations.push({ pkg, license });
}

console.log(`[audit:licenses] ${deps.size} production package(s) scanned`);
if (violations.length === 0) {
  console.log('[audit:licenses] All licenses on allow-list. ✅');
  process.exit(0);
}

console.error('[audit:licenses] License policy violations:');
for (const v of violations) console.error(`  - ${v.pkg}: ${JSON.stringify(v.license)}`);
console.error('[audit:licenses] Update the allow-list or remove the dependency.');
process.exit(1);
