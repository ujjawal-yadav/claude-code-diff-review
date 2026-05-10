#!/usr/bin/env node
/**
 * SBOM generator (M7 beta gate).
 *
 * Emits a CycloneDX 1.5 JSON SBOM covering the production dependency
 * closure. Output: dist/sbom.cdx.json. Attach this to a GitHub Release
 * alongside the VSIX so downstream consumers can do their own license
 * / vulnerability audits.
 *
 * No new npm dep — we synthesise the document from the lockfile + each
 * package's own package.json.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'dist', 'sbom.cdx.json');

const rootPkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

async function loadProductionComponents() {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const components = [];
  for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
    if (pkgPath === '') continue;                 // root package itself
    if (info.dev || info.devOptional) continue;
    if (!pkgPath.startsWith('node_modules/')) continue;
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(path.join(root, pkgPath, 'package.json'), 'utf8')); }
    catch { continue; }
    const name = pkg.name ?? pkgPath.replace(/^node_modules\//, '');
    const version = pkg.version ?? info.version ?? '0.0.0';
    const purl = `pkg:npm/${encodeURIComponent(name).replace(/%40/g, '@')}@${version}`;
    components.push({
      type: 'library',
      'bom-ref': purl,
      name,
      version,
      purl,
      licenses: pkg.license
        ? [{ license: typeof pkg.license === 'string' ? { id: pkg.license } : { name: String(pkg.license) } }]
        : undefined,
      description: pkg.description,
      hashes: info.integrity ? [{ alg: 'SHA-512', content: info.integrity.replace(/^sha512-/, '') }] : undefined,
    });
  }
  return components;
}

const components = await loadProductionComponents();

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      'bom-ref': `pkg:vscode/${rootPkg.name}@${rootPkg.version}`,
      name: rootPkg.name,
      version: rootPkg.version,
      description: rootPkg.description,
      licenses: [{ license: { id: rootPkg.license ?? 'MIT' } }],
    },
    tools: [{ vendor: rootPkg.name, name: 'scripts/generateSbom.mjs', version: '1' }],
  },
  components,
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(sbom, null, 2));
console.log(`[audit:sbom] Wrote ${outPath} with ${components.length} component(s).`);
