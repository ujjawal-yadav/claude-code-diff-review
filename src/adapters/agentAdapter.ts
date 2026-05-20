/**
 * Multi-agent abstraction surface (M9.4a).
 *
 * Goal
 * ----
 * Decouple the rest of the extension from any one coding-agent's wire
 * format. Each supported agent (Claude Code today; OpenCode tomorrow)
 * implements `AgentAdapter` and is responsible for:
 *
 *   1. **Hook-config generation** — emit whatever JSON/YAML/TOML blob
 *      the agent expects so PreToolUse / PostToolUse / Stop hooks fire
 *      against our loopback server.
 *   2. **Inbound payload normalisation** — accept the agent's raw hook
 *      payload (already JSON-parsed by Fastify) and either reject it
 *      (return `null`) or normalise it into one of the `Normalised*`
 *      shapes below.
 *   3. **(Future) Transcript resolution & sub-agent identity** —
 *      placeholder hooks for Waves 3 (history) and 4 (sub-agent
 *      attribution). Adapters return `null` until those slices land.
 *
 * Forward-compatibility note
 * --------------------------
 * `agentId` is forward-declared as a discriminated union so call-sites
 * that branch on agent identity (e.g. transcript path resolution, UI
 * badges) typecheck against the full set even while only Claude Code
 * is wired up. Adding a new agent is a one-line union extension.
 *
 * Anti-coupling rule
 * ------------------
 * This module MUST NOT import from `server.ts`, `extension.ts`,
 * `reviewOrchestrator.ts`, or anything VS-Code-flavoured. It is a
 * pure-data contract — that's what makes it the dependency-inversion
 * boundary between the host runtime and the per-agent parsers.
 */

// Single source of truth lives in `src/types.ts`. Re-exported here so the
// adapter contract module stays import-self-contained for consumers.
import type { AgentId } from '../types.js';
export type { AgentId };

// --------------------------------------------------------------------------
// Hook-config generation
// --------------------------------------------------------------------------

export interface HookConfigOpts {
  /**
   * Where the generated config should be scoped. `workspace` writes a
   * per-project file (today: `.claude/settings.json`); `user` would
   * write to the agent's user-global config dir. Workspace is the only
   * scope wired up in v0.2 — `user` is reserved for a later slice.
   */
  scope: 'user' | 'workspace';
  /** Workspace root (only meaningful when `scope === 'workspace'`). */
  workspaceRoot: string;
  /** Bound port of the loopback hook server. */
  port: number;
}

// --------------------------------------------------------------------------
// Normalised hook events
// --------------------------------------------------------------------------
//
// These shapes are the lingua-franca every downstream consumer
// (orchestrator, snapshot store, telemetry) speaks. Adapter authors
// translate agent-specific field names INTO these shapes; downstream
// code never sees the raw payload.
//
// Why a flat shape rather than mirroring the Claude wire format?
//   • Agents disagree on nesting (`tool_input.file_path` vs
//     `args.path`). Flattening at the adapter boundary means we don't
//     leak that disagreement.
//   • A flat record is trivially loggable and telemetry-safe.

export interface NormalisedPreToolUse {
  agentId: AgentId;
  sessionId: string;
  toolName: string;
  /** Absolute path the tool intends to write, when knowable. */
  filePath: string | null;
  /** Proposed new content (only Write provides this pre-edit). */
  fileContent?: string;
  cwd: string;
  /**
   * Identity of the sub-agent emitting this event, if the host agent
   * supports sub-agents (e.g. Claude Code's Task tool). `null` when
   * the top-level agent is the actor. Wave 4 will populate; today the
   * Claude Code adapter always returns `null`.
   */
  subagentId: string | null;
}

export interface NormalisedPostToolUse {
  agentId: AgentId;
  sessionId: string;
  toolName: string;
  filePath: string | null;
  success: boolean;
  cwd: string;
  subagentId: string | null;
}

export interface NormalisedStop {
  agentId: AgentId;
  sessionId: string;
  cwd: string;
  /**
   * Sub-agent Stop events are debounced/filtered differently from
   * top-level Stop. Wave 4 populates; today: always false.
   */
  stopHookActive: boolean;
  /** Optional last assistant message (Claude Code provides). */
  lastAssistantMessage: string | null;
}

// --------------------------------------------------------------------------
// Adapter contract
// --------------------------------------------------------------------------

export interface AgentAdapter {
  readonly agentId: AgentId;

  /**
   * Produce the agent-specific config blob that wires hook events to
   * the loopback server. Returns `unknown` because each agent's schema
   * differs; the caller (hookConfigurator) knows how to persist it.
   */
  generateHookConfig(opts: HookConfigOpts): unknown;

  /**
   * Validate & normalise an inbound PreToolUse payload. Returns `null`
   * when the payload fails schema validation or refers to a tool we
   * don't care about (non-edit). Adapters MUST NOT throw — null is
   * the signal.
   */
  parsePreToolUse(raw: unknown): NormalisedPreToolUse | null;
  parsePostToolUse(raw: unknown): NormalisedPostToolUse | null;
  parseStop(raw: unknown): NormalisedStop | null;

  /**
   * Resolve the path to the agent's session-transcript file on disk,
   * if one exists. Used by the history layer (Wave 3) to capture
   * conversation context alongside the diff review.
   *
   * Returns `null` until M9.5 lands.
   */
  resolveTranscriptPath(sessionId: string, cwd: string): string | null;

  /**
   * Extract a sub-agent identifier from a raw hook payload, if the
   * agent attributes events to nested agents (Claude Code's Task
   * tool, OpenCode's sub-prompts, etc.).
   *
   * Async because the canonical source (Claude Code's JSONL transcript)
   * requires file I/O — implementations typically cache the parsed
   * `Task` entries per session and binary-search by timestamp for
   * subsequent calls. The first call per session pays the scan cost
   * (~10–30 ms on a 5 MB transcript); subsequent calls are sub-ms.
   *
   * `parsePreToolUse` / `parsePostToolUse` MUST NOT call this internally
   * (they're sync). Callers in the host (extension.ts.onPreToolUse)
   * await it after parsing and thread the result through to the
   * snapshot store.
   */
  extractSubagentId(rawPayload: unknown): Promise<string | null>;

  /**
   * Optional cache-eviction hook. Implementations that cache transcript
   * data per session SHOULD clear that cache when a session ends
   * (`SnapshotStore.release`). Adapters with no caching can omit.
   */
  clearSubagentCache?(sessionId: string): void;
}
