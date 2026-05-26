import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
} from '../messages.js';
import {
  findLatestTaskBefore,
  readTaskEntries,
  type TaskEntry,
} from '../transcript/transcriptReader.js';
import { parseTranscriptTimestamp } from '../transcript/transcriptSchema.js';
import {
  AgentAdapter,
  AgentId,
  HookConfigOpts,
  NormalisedPostToolUse,
  NormalisedPreToolUse,
  NormalisedStop,
} from './agentAdapter.js';

/**
 * Claude Code implementation of `AgentAdapter` (M9.4a).
 *
 * Extracted from `server.ts` (parse routines) and `hookConfigurator.ts`
 * (config generation). Pure refactor — no behavioural delta from v0.2.
 *
 * Wire contract reference: PRD §12.1, TRD §5.3, TRD §7.1.
 */

/** Marker on every entry written by this extension. Mirrors hookConfigurator. */
const HOOK_MARKER_KEY = 'x-claude-review-extension';
const HOOK_MARKER_VALUE = 'v1';

/** Edit-tool gate. Non-edit tools (Read, Bash, etc.) are not interesting. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Hook event matcher used by Claude Code for tool-bound events. */
const MATCHER = 'Write|Edit|MultiEdit';
const TIMEOUT_SEC = 10;

interface HookEntry {
  [k: string]: unknown;
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

export interface ClaudeCodeHookConfig {
  PreToolUse: HookEntry;
  PostToolUse: HookEntry;
  Stop: HookEntry;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentId: AgentId = 'claude-code';

  /**
   * M9.6: per-session cache of `Task` tool_use entries from the transcript,
   * sorted by timestamp. First call per session triggers a transcript scan;
   * subsequent calls binary-search the cache. Cleared by
   * `clearSubagentCache(sessionId)` when the session ends.
   *
   * v0.6.1: each entry records the transcript's `mtimeMs` at read time. On the
   * next call we `stat` the transcript (one cheap syscall) and re-read only if
   * the mtime advanced — so a sub-agent (Task) spawned MID-session is picked up
   * instead of being permanently mis-attributed to the main agent (the prior
   * cache never refreshed once set, incl. a sticky negative `null`). `tasks ===
   * null` still means "no transcript / no Task entries" for that mtime.
   */
  private readonly taskCache = new Map<string, { mtimeMs: number; tasks: ReadonlyArray<TaskEntry> | null }>();

  /**
   * Bug E fix (preserved): concurrent `extractSubagentId` calls for the same
   * session share ONE in-flight `readTaskEntries` instead of each kicking off
   * its own. Cleared when the read settles.
   */
  private readonly taskInflight = new Map<string, Promise<ReadonlyArray<TaskEntry> | null>>();

  // ------------------------------------------------------------------------
  // generateHookConfig — extracted from src/hookConfigurator.ts buildEntry
  // ------------------------------------------------------------------------

  generateHookConfig(opts: HookConfigOpts): ClaudeCodeHookConfig {
    // Workspace is the only scope wired up today. `user` is reserved
    // for a later slice (will write to ~/.claude/settings.json).
    if (opts.scope !== 'workspace') {
      throw new Error(`ClaudeCodeAdapter: unsupported scope "${opts.scope}"`);
    }
    return {
      PreToolUse:  this.buildEntry('PreToolUse', opts.port),
      PostToolUse: this.buildEntry('PostToolUse', opts.port),
      Stop:        this.buildEntry('Stop', opts.port),
    };
  }

  private buildEntry(event: 'PreToolUse' | 'PostToolUse' | 'Stop', port: number): HookEntry {
    const base: Record<string, unknown> = {};
    base[HOOK_MARKER_KEY] = HOOK_MARKER_VALUE;
    if (event !== 'Stop') {
      base.matcher = MATCHER;
    }
    base.hooks = [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/${this.routeFor(event)}`,
        timeout: TIMEOUT_SEC,
        headers: { Authorization: 'Bearer $CLAUDE_REVIEW_TOKEN' },
        allowedEnvVars: ['CLAUDE_REVIEW_TOKEN'],
      },
    ];
    return base as HookEntry;
  }

  private routeFor(event: 'PreToolUse' | 'PostToolUse' | 'Stop'): string {
    switch (event) {
      case 'PreToolUse':  return 'pre-tool-use';
      case 'PostToolUse': return 'post-tool-use';
      case 'Stop':        return 'stop';
    }
  }

  // ------------------------------------------------------------------------
  // Inbound payload normalisation — extracted from src/server.ts handlers
  // ------------------------------------------------------------------------

  parsePreToolUse(raw: unknown): NormalisedPreToolUse | null {
    const parsed = PreToolUsePayload.safeParse(raw);
    if (!parsed.success) return null;
    const data = parsed.data;
    if (!EDIT_TOOLS.has(data.tool_name)) return null;

    // M9.6: subagentId is hydrated separately by the caller via the async
    // `extractSubagentId(raw)` method. Parse stays sync; caller awaits.
    const result: NormalisedPreToolUse = {
      agentId: this.agentId,
      sessionId: data.session_id,
      toolName:  data.tool_name,
      filePath:  data.tool_input.file_path ?? null,
      cwd:       data.cwd,
      subagentId: null,
    };
    if (typeof data.tool_input.content === 'string') {
      result.fileContent = data.tool_input.content;
    }
    return result;
  }

  parsePostToolUse(raw: unknown): NormalisedPostToolUse | null {
    const parsed = PostToolUsePayload.safeParse(raw);
    if (!parsed.success) return null;
    const data = parsed.data;
    if (!EDIT_TOOLS.has(data.tool_name)) return null;

    return {
      agentId: this.agentId,
      sessionId: data.session_id,
      toolName:  data.tool_name,
      filePath:  data.tool_input.file_path ?? null,
      success:   data.tool_result?.success ?? true,
      cwd:       data.cwd,
      subagentId: null,
    };
  }

  parseStop(raw: unknown): NormalisedStop | null {
    const parsed = StopPayload.safeParse(raw);
    if (!parsed.success) return null;
    const data = parsed.data;
    // Claude Code's Stop payload doesn't carry `cwd`; the orchestrator
    // resolves it via the snapshot store keyed on sessionId. Forward
    // empty string here so adapters that DO carry cwd (OpenCode) can
    // populate it without a schema break.
    const cwd = typeof (raw as { cwd?: unknown })?.cwd === 'string'
      ? (raw as { cwd: string }).cwd
      : '';
    return {
      agentId: this.agentId,
      sessionId: data.session_id,
      cwd,
      stopHookActive: data.stop_hook_active ?? false,
      lastAssistantMessage: data.last_assistant_message ?? null,
    };
  }

  // ------------------------------------------------------------------------
  // Placeholder hooks for Waves 3 (history) and 4 (sub-agent attribution)
  // ------------------------------------------------------------------------

  /**
   * Resolve Claude Code's session transcript path.
   *
   * Layout: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` where the
   * encoding strips a Windows drive letter (`C:` → ``) and replaces
   * `\` / `/` with `-`. Matches Claude Code's own slug computation.
   *
   * Security: `sessionId` and `cwd` arrive from untrusted hook payloads.
   * After `path.resolve`, the result MUST stay under the projects root —
   * otherwise we refuse with `null`. The reader treats `null` as "no
   * transcript available", which gracefully degrades to hunk-only chat
   * and null sub-agent attribution.
   */
  resolveTranscriptPath(sessionId: string, cwd: string): string | null {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    // Reject sessionIds that contain path separators or traversal segments
    // BEFORE path.join normalises them away. `../escape` would otherwise
    // collapse the parent directory and resolve INSIDE projects/ but with
    // a different basename — still within the root, but writing to the
    // wrong filename. Disallow the whole class.
    if (/[\\/]/.test(sessionId) || sessionId.includes('..')) return null;
    const encoded = cwd.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '-');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const candidate = path.join(projectsRoot, encoded, `${sessionId}.jsonl`);
    const resolved = path.resolve(candidate);
    const projectsRootResolved = path.resolve(projectsRoot);
    const rel = path.relative(projectsRootResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  }

  /**
   * Find the most recent `Task` tool_use in the transcript whose timestamp
   * is ≤ this payload's timestamp; return its description (the sub-agent's
   * human-readable name). Returns `null` if:
   *   - the payload is unparseable
   *   - the transcript doesn't exist (resolveTranscriptPath → null)
   *   - the transcript has no `Task` entries
   *   - no Task precedes this payload's timestamp (main-agent edit)
   *
   * Cache: lazy per-session. First call streams the transcript and stores a
   * sorted `TaskEntry[]`. Subsequent calls binary-search that cache. Call
   * `clearSubagentCache(sessionId)` on session end to bound memory.
   */
  async extractSubagentId(rawPayload: unknown): Promise<string | null> {
    const meta = parsePayloadForSubagent(rawPayload);
    if (!meta) return null;
    const sid = meta.sessionId;

    const transcriptPath = this.resolveTranscriptPath(sid, meta.cwd);
    if (!transcriptPath) {
      this.taskCache.set(sid, { mtimeMs: -1, tasks: null });
      return null;
    }

    // v0.6.1: detect transcript growth via mtime so a Task spawned after the
    // first read is still attributed. One stat per call — cheap vs re-reading.
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(transcriptPath)).mtimeMs;
    } catch {
      // Transcript unreadable now (deleted / transient FS error). Serve the
      // last cached attribution rather than dropping it; only null when cold.
      const stale = this.taskCache.get(sid);
      if (stale && stale.tasks) {
        const e = findLatestTaskBefore(stale.tasks, meta.timestamp);
        return e?.description ?? null;
      }
      return null;
    }

    const cached = this.taskCache.get(sid);
    let tasks: ReadonlyArray<TaskEntry> | null;
    if (cached && cached.mtimeMs === mtimeMs) {
      tasks = cached.tasks; // up to date — no re-read
    } else {
      // Re-read (cold or transcript grew). Dedup concurrent reads via the
      // in-flight map (Bug E). Only the resolved value updates the cache,
      // and only if a concurrent clearSubagentCache didn't intervene.
      let inflight = this.taskInflight.get(sid);
      if (!inflight) {
        inflight = readTaskEntries(transcriptPath).then((loaded) => (loaded.length > 0 ? loaded : null));
        this.taskInflight.set(sid, inflight);
        void inflight.finally(() => {
          if (this.taskInflight.get(sid) === inflight) this.taskInflight.delete(sid);
        });
      }
      tasks = await inflight;
      this.taskCache.set(sid, { mtimeMs, tasks });
    }

    if (!tasks) return null;
    const entry = findLatestTaskBefore(tasks, meta.timestamp);
    return entry?.description ?? null;
  }

  clearSubagentCache(sessionId: string): void {
    this.taskCache.delete(sessionId);
    this.taskInflight.delete(sessionId);
  }
}

/**
 * Extract the (sessionId, cwd, timestamp) tuple needed by extractSubagentId.
 * Accepts either a PreToolUse or PostToolUse raw payload — both share the
 * relevant fields. Returns null if any required field is missing.
 *
 * Timestamp source: Claude Code's hook payload carries no per-event time,
 * so we use `Date.now()` as a monotonic proxy. The transcript's tool_use
 * timestamps come from the JSONL which Claude Code wrote moments before
 * the hook fired — `Date.now()` is later than all entries in the
 * transcript for this turn, so `findLatestTaskBefore` finds the right one.
 */
function parsePayloadForSubagent(
  raw: unknown,
): { sessionId: string; cwd: string; timestamp: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sessionId = r.session_id;
  const cwd = r.cwd;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  // Some payloads include an explicit timestamp; prefer it. Otherwise the
  // hook moment is now-ish (Claude wrote the tool_use to the transcript
  // microseconds ago).
  let timestamp = Date.now();
  if (typeof r.timestamp === 'string') {
    const ms = parseTranscriptTimestamp(r.timestamp);
    if (Number.isFinite(ms)) timestamp = ms;
  }
  return { sessionId, cwd, timestamp };
}

/** Exported for unit tests. */
export const __test = { HOOK_MARKER_KEY, HOOK_MARKER_VALUE, MATCHER, EDIT_TOOLS };
