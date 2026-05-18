import { AgentAdapter, AgentId } from './agentAdapter.js';
import { ClaudeCodeAdapter } from './claudeCodeAdapter.js';

/**
 * Adapter registry (M9.4a.3).
 *
 * Single source of truth for "which agents does this build of the
 * extension support?". The registry is intentionally read-only at
 * runtime — adding an agent is a code change, not a config change.
 */

const claudeCode = new ClaudeCodeAdapter();

export const agentAdapters: ReadonlyMap<AgentId, AgentAdapter> = new Map<AgentId, AgentAdapter>([
  ['claude-code', claudeCode],
]);

/** Convenience: throws if the requested agent isn't compiled in. */
export function requireAdapter(id: AgentId): AgentAdapter {
  const adapter = agentAdapters.get(id);
  if (!adapter) {
    throw new Error(`No adapter registered for agentId="${id}"`);
  }
  return adapter;
}

export type {
  AgentAdapter,
  AgentId,
  HookConfigOpts,
  NormalisedPreToolUse,
  NormalisedPostToolUse,
  NormalisedStop,
} from './agentAdapter.js';
export { ClaudeCodeAdapter } from './claudeCodeAdapter.js';
