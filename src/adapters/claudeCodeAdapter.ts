import {
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
} from '../messages.js';
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

    const result: NormalisedPreToolUse = {
      agentId: this.agentId,
      sessionId: data.session_id,
      toolName:  data.tool_name,
      filePath:  data.tool_input.file_path ?? null,
      cwd:       data.cwd,
      subagentId: this.extractSubagentId(raw),
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
      subagentId: this.extractSubagentId(raw),
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

  resolveTranscriptPath(_sessionId: string, _cwd: string): string | null {
    // TODO M9.5 — resolve `~/.claude/projects/<slug>/<sessionId>.jsonl`.
    return null;
  }

  extractSubagentId(_rawPayload: unknown): string | null {
    // TODO M9.6 — read Task-tool nesting from `transcript_path` / parent ids.
    return null;
  }
}

/** Exported for unit tests. */
export const __test = { HOOK_MARKER_KEY, HOOK_MARKER_VALUE, MATCHER, EDIT_TOOLS };
