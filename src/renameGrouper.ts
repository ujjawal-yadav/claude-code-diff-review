import type { HunkReview, SessionReview } from './types.js';

/**
 * v0.4 (A8 cheap) — heuristic single-identifier rename detection.
 *
 * Strategy
 * --------
 * For each hunk, tokenise `-` and `+` lines into identifiers (`\b[A-Za-z_$]
 * [A-Za-z0-9_$]*\b`). If the symmetric difference is exactly ONE removed
 * token AND ONE added token, both ≥3 characters, the hunk is a rename
 * candidate keyed by `${oldToken}->${newToken}`. Hunks with matching keys
 * across the session form a group; groups of size ≥3 surface in the UI.
 *
 * False positives are bounded by:
 *   - the symmetric-difference cardinality constraint (exactly 1 in, 1 out),
 *   - the ≥3 length filter (drops single-letter loops / 2-letter vars),
 *   - the ≥3 group-size filter (drops coincidental token swaps).
 *
 * False negatives we accept: multi-token renames (`fooBar → bazQux`),
 * type-only renames where the identifier appears in non-text positions, and
 * renames that also touch other identifiers in the same hunk.
 *
 * Pure. No I/O. Side-effect-free over input.
 */

export interface RenameCandidate {
  oldToken: string;
  newToken: string;
}

const IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
const MIN_TOKEN_LEN = 3;
const MIN_GROUP_SIZE = 3;

/** Returns null when the hunk doesn't look like a single-identifier rename. */
export function detectRename(hunk: HunkReview): RenameCandidate | null {
  const dels = new Set<string>();
  const adds = new Set<string>();
  for (const line of hunk.lines) {
    const isDel = line.startsWith('-');
    const isAdd = line.startsWith('+');
    if (!isDel && !isAdd) continue;
    const body = line.slice(1);
    // Use matchAll for stable per-line iteration; collect into the per-side set.
    for (const m of body.matchAll(IDENT_RE)) {
      const tok = m[0];
      if (isDel) dels.add(tok);
      else       adds.add(tok);
    }
  }
  const removed = [...dels].filter((t) => !adds.has(t) && t.length >= MIN_TOKEN_LEN);
  const added   = [...adds].filter((t) => !dels.has(t) && t.length >= MIN_TOKEN_LEN);
  if (removed.length !== 1 || added.length !== 1) return null;
  return { oldToken: removed[0]!, newToken: added[0]! };
}

/**
 * Walk every hunk in the session; cluster by rename key; return only groups
 * with ≥3 members. Output is keyed by `${oldToken}->${newToken}` so the
 * webview can address a group via a stable string id.
 */
export function groupRenames(session: SessionReview): Record<string, Array<{ filePath: string; hunkIndex: number }>> {
  const buckets = new Map<string, Array<{ filePath: string; hunkIndex: number }>>();
  for (const file of session.files) {
    for (const hunk of file.hunks) {
      const cand = detectRename(hunk);
      if (!cand) continue;
      const key = `${cand.oldToken}->${cand.newToken}`;
      const arr = buckets.get(key) ?? [];
      arr.push({ filePath: file.filePath, hunkIndex: hunk.index });
      buckets.set(key, arr);
    }
  }
  const out: Record<string, Array<{ filePath: string; hunkIndex: number }>> = {};
  for (const [k, v] of buckets) {
    if (v.length >= MIN_GROUP_SIZE) out[k] = v;
  }
  return out;
}

/**
 * Annotate each hunk in `session` with `renameGroupId` for groups present
 * in `groups`. Mutates in-place (matches the orchestrator's pattern of
 * decorating the `FileReview` graph at openReview-time alongside risk flags).
 */
export function annotateRenameGroups(
  session: SessionReview,
  groups: Record<string, Array<{ filePath: string; hunkIndex: number }>>,
): void {
  const byHunkKey = new Map<string, string>();
  for (const [groupId, members] of Object.entries(groups)) {
    for (const m of members) {
      byHunkKey.set(`${m.filePath}::${m.hunkIndex}`, groupId);
    }
  }
  if (byHunkKey.size === 0) return;
  for (const file of session.files) {
    for (const hunk of file.hunks) {
      const gid = byHunkKey.get(`${file.filePath}::${hunk.index}`);
      if (gid) hunk.renameGroupId = gid;
    }
  }
}

/** Exported for unit tests. */
export const __test = { IDENT_RE, MIN_TOKEN_LEN, MIN_GROUP_SIZE };
