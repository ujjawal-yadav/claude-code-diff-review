import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Logger } from '../logger.js';

/**
 * v0.5 — discover the workspace's tsconfig and detect whether to use
 * `tsc -b --noEmit` (composite / project-references) or plain
 * `tsc --noEmit -p <path>`.
 *
 * Strategy
 * --------
 *   1. Prefer `tsconfig.build.json` at workspace root (build-only config —
 *      typically the "real" config in projects that have a separate editor
 *      config). Falls back to `tsconfig.json`.
 *   2. Parse the resolved config with `extends` chain resolution.
 *   3. If `composite: true` is set on the resolved config OR `references[]`
 *      is non-empty, use build-mode: `tsc -b --noEmit`.
 *   4. Otherwise use project mode: `tsc --noEmit -p <path>`.
 *
 * tsconfig allows JSON-with-comments (JSONC). We strip `//` and `/* * /`
 * comments + trailing commas with a regex pass — adding a `jsonc-parser`
 * dep is overkill for one detection heuristic. False positives (a string
 * containing `//`) would mis-parse, but tsconfig keys / values rarely
 * contain those tokens; we accept the imperfection.
 *
 * Returns `null` when no tsconfig exists at the workspace root — the
 * caller surfaces a project-level warning ("no TypeScript project
 * detected") and the build-signal feature becomes a no-op for this session.
 */

export interface ResolvedTsConfig {
  /** Absolute path to the tsconfig that will be passed via `-p`. */
  configPath: string;
  /** True when composite/references detected → use `tsc -b --noEmit`. */
  useBuildMode: boolean;
}

const CANDIDATE_NAMES = ['tsconfig.build.json', 'tsconfig.json'] as const;

/** Strip JSONC comments + trailing commas. Tolerant; not strictly conformant. */
function stripJsonComments(raw: string): string {
  return raw
    // Line comments — match // up to end of line.
    .replace(/\/\/[^\n\r]*/g, '')
    // Block comments — non-greedy, multi-line.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Trailing commas before } or ].
    .replace(/,(\s*[}\]])/g, '$1');
}

interface RawTsConfig {
  extends?: string | string[];
  compilerOptions?: { composite?: boolean };
  references?: unknown[];
}

async function readTsConfig(absPath: string): Promise<RawTsConfig | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    return JSON.parse(stripJsonComments(raw)) as RawTsConfig;
  } catch {
    return null;
  }
}

/**
 * Recursively follow `extends` to determine the EFFECTIVE composite flag
 * and references count. tsconfig's `extends` can be a single string or
 * (TS 5.0+) an array; later entries override earlier ones.
 *
 * Cycle-safe via depth cap (5 levels is more than any sane project nests).
 */
async function resolveEffective(
  configPath: string,
  logger?: Logger,
  depth = 0,
): Promise<{ composite: boolean; referencesCount: number }> {
  if (depth > 5) {
    logger?.warn('buildSignal', 'tsconfig.extends.depth-exceeded', { configPath });
    return { composite: false, referencesCount: 0 };
  }
  const cfg = await readTsConfig(configPath);
  if (!cfg) return { composite: false, referencesCount: 0 };

  let composite = !!cfg.compilerOptions?.composite;
  let referencesCount = Array.isArray(cfg.references) ? cfg.references.length : 0;

  // Walk extends chain. Each extends contributes to composite via OR.
  const extendsList = Array.isArray(cfg.extends)
    ? cfg.extends
    : typeof cfg.extends === 'string'
    ? [cfg.extends]
    : [];
  for (const ext of extendsList) {
    const resolved = resolveExtendsPath(path.dirname(configPath), ext);
    if (!resolved) continue;
    const inherited = await resolveEffective(resolved, logger, depth + 1);
    if (inherited.composite) composite = true;
    // Note: references[] is NOT inherited via extends per tsconfig spec, but
    // we sum out of paranoia — the worst case is "switch to -b when we
    // didn't strictly need to", which is benign.
    referencesCount += inherited.referencesCount;
  }
  return { composite, referencesCount };
}

/**
 * Resolve a tsconfig `extends` reference to an absolute path. Handles:
 *   - Relative path: `./base.json`, `../shared/tsconfig.json`
 *   - Bare-ish: `@tsconfig/strictest/tsconfig.json` (node_modules package)
 *   - With or without `.json` suffix
 *
 * Returns null on resolution failure.
 */
function resolveExtendsPath(fromDir: string, ext: string): string | null {
  // Default to .json if no extension.
  const withExt = /\.json$/i.test(ext) ? ext : `${ext}.json`;
  if (ext.startsWith('./') || ext.startsWith('../') || path.isAbsolute(ext)) {
    return path.resolve(fromDir, withExt);
  }
  // Bare package reference — best-effort lookup under node_modules.
  // tsc itself walks up looking for node_modules; we do one hop for
  // simplicity (covers 99% of cases).
  return path.resolve(fromDir, 'node_modules', withExt);
}

export async function resolveTsconfig(
  cwd: string,
  logger?: Logger,
): Promise<ResolvedTsConfig | null> {
  for (const name of CANDIDATE_NAMES) {
    const candidate = path.join(cwd, name);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const eff = await resolveEffective(candidate, logger);
    return {
      configPath: candidate,
      useBuildMode: eff.composite || eff.referencesCount > 0,
    };
  }
  logger?.debug('buildSignal', 'tsconfig.not-found', { cwd });
  return null;
}

/** Exported for tests. */
export const __test = { stripJsonComments, resolveEffective, resolveExtendsPath };
