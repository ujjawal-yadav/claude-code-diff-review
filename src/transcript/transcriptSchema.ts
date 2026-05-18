/**
 * Claude Code JSONL transcript schema (M9.5 — Wave 3).
 *
 * Claude Code persists every turn's conversation to a per-session JSONL file
 * at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each line is one
 * `TranscriptEntry`. The schema here is the minimum surface we need to:
 *
 *   1. Reconstruct the user's original prompt for a turn (for hunk chat).
 *   2. Locate the `tool_use` that produced a given file edit.
 *   3. Identify the enclosing `Task` sub-agent (for Wave 4 attribution).
 *
 * Tolerant by design — the reader skips lines that fail Zod validation with
 * a debug log; never throws. Claude Code MAY add fields between releases;
 * any extras pass through unread.
 */

import { z } from 'zod';

// --------------------------------------------------------------------------
// Content blocks inside assistant messages
// --------------------------------------------------------------------------

const TextBlockZ = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolUseBlockZ = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string(),
  input: z.unknown(),
});

const ThinkingBlockZ = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

const ContentBlockZ = z.union([TextBlockZ, ToolUseBlockZ, ThinkingBlockZ]);

// --------------------------------------------------------------------------
// Top-level transcript entries (one per JSONL line)
// --------------------------------------------------------------------------

const UserEntryZ = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const AssistantEntryZ = z.object({
  type: z.literal('assistant'),
  message: z.object({ content: z.array(ContentBlockZ) }),
  timestamp: z.string(),
});

const ToolUseEntryZ = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.unknown(),
  parent_tool_use_id: z.string().optional(),
  timestamp: z.string(),
});

const ToolResultEntryZ = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
  timestamp: z.string(),
});

const SystemEntryZ = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  message: z.string().optional(),
  timestamp: z.string(),
});

export const TranscriptEntryZ = z.discriminatedUnion('type', [
  UserEntryZ,
  AssistantEntryZ,
  ToolUseEntryZ,
  ToolResultEntryZ,
  SystemEntryZ,
]);

export type TranscriptEntry = z.infer<typeof TranscriptEntryZ>;
export type UserEntry      = z.infer<typeof UserEntryZ>;
export type AssistantEntry = z.infer<typeof AssistantEntryZ>;
export type ToolUseEntry   = z.infer<typeof ToolUseEntryZ>;
export type ToolResultEntry= z.infer<typeof ToolResultEntryZ>;
export type ContentBlock   = z.infer<typeof ContentBlockZ>;

/** Tolerant decode — returns null on schema failure. */
export function decodeEntry(raw: unknown): TranscriptEntry | null {
  const parsed = TranscriptEntryZ.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse Claude Code's ISO-8601 timestamp into a JS epoch ms. Returns NaN on
 * unparseable strings; caller treats NaN as "skip this entry".
 */
export function parseTranscriptTimestamp(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}
