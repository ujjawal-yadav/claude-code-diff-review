/**
 * Claude Code transcript reader (M9.5 + M9.6 — Waves 3 & 4).
 *
 * Streams the JSONL transcript line-by-line and extracts the small windows
 * that two callers care about:
 *
 *   - `readTranscriptWindow(path, opts)` — Wave 3: for a given file edit,
 *     fetch the user's original prompt for the turn plus up to N tool calls
 *     before/after. Used by the chat user-message composer.
 *
 *   - `readTaskEntries(path)` — Wave 4: enumerate every `Task` tool_use
 *     entry in the transcript with its timestamp. Used by the adapter's
 *     sub-agent attribution cache.
 *
 * Heap-bounded by construction
 * ----------------------------
 * We use `readline.createInterface(fs.createReadStream(...))` so the entry
 * objects flow through one line at a time. The window function maintains
 * only a small ring buffer of pre-target candidates plus a bounded
 * post-target counter — peak memory is O(windowSize × max-entry-size),
 * NOT O(file-size). A 50 MB transcript fits under 50 MB heap easily.
 *
 * Tolerant by design
 * ------------------
 * Lines that fail `JSON.parse` or `decodeEntry` are skipped with a debug
 * log (when a logger is provided). The reader NEVER throws to the caller.
 * Missing file / permission error → returns the empty result shape.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

import type { Logger } from '../logger.js';
import {
  decodeEntry,
  parseTranscriptTimestamp,
  type TranscriptEntry,
  type ToolUseEntry,
} from './transcriptSchema.js';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface ToolCallSummary {
  toolName: string;
  /** Truncated JSON repr of `tool_input`, capped at INPUT_SUMMARY_CAP_BYTES. */
  inputSummary: string;
  /** ms since epoch (NaN-safe — entries with unparseable timestamps are skipped). */
  timestamp: number;
}

export interface TranscriptWindow {
  /** Most recent user prompt before the target tool_use, truncated to USER_PROMPT_CAP_BYTES. */
  userPrompt: string | null;
  /** Up to `windowSize` tool calls immediately before the target, oldest-first. */
  precedingToolCalls: ToolCallSummary[];
  /** Up to `windowSize` tool calls immediately after the target, oldest-first. */
  followingToolCalls: ToolCallSummary[];
  /** Most recent assistant 'thinking' block (if Claude was in extended-thinking mode). */
  assistantThinking: string | null;
}

export interface TaskEntry {
  /** ms since epoch; sorted ascending in the returned array. */
  timestamp: number;
  /** Stable id of the Task tool_use, when present in the transcript. */
  taskToolUseId: string | null;
  /** From `tool_input.description`, untruncated — UI truncates at render time. */
  description: string;
}

// --------------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------------

const DEFAULT_WINDOW_SIZE = 5;
const INPUT_SUMMARY_CAP_BYTES = 1024;       // per-tool-call input preview
const USER_PROMPT_CAP_BYTES   = 4 * 1024;   // 4 KB
const THINKING_CAP_BYTES      = 4 * 1024;   // 4 KB

const EMPTY_WINDOW: TranscriptWindow = Object.freeze({
  userPrompt: null,
  precedingToolCalls: [],
  followingToolCalls: [],
  assistantThinking: null,
});

// --------------------------------------------------------------------------
// readTranscriptWindow — Wave 3 chat-context source
// --------------------------------------------------------------------------

export interface ReadWindowOpts {
  /** File path the edit targeted (matches `tool_input.file_path`). */
  filePath: string;
  /** Tool calls to capture on each side of the target. Default 5. */
  windowSize?: number;
  logger?: Logger;
}

/**
 * Stream the transcript and build a `TranscriptWindow` around the most
 * recent `tool_use` whose `tool_input.file_path` equals `opts.filePath`.
 *
 * Algorithm
 * ---------
 * Two passes are equivalent to one pass with state. We do one pass:
 *
 *   - Maintain a ring buffer `precedingCandidates` (size = windowSize) of
 *     the most recent tool_use entries seen, plus a running `lastUserPrompt`
 *     and `lastThinking`.
 *
 *   - When we hit a tool_use that matches `opts.filePath`, lock in the
 *     current ring as `precedingToolCalls`, snapshot user/thinking, then
 *     keep collecting up to `windowSize` more tool_use entries as
 *     `followingToolCalls`.
 *
 *   - If we see a *later* matching tool_use after locking in (the user
 *     edited the same file multiple times in one turn), reset and use the
 *     newer match — we want the most recent.
 *
 * Returns the empty window if the file is never found in the transcript
 * or the file can't be read (ENOENT, EACCES). Never throws.
 */
export async function readTranscriptWindow(
  transcriptPath: string,
  opts: ReadWindowOpts,
): Promise<TranscriptWindow> {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  const logger = opts.logger;

  let lastUserPrompt: string | null = null;
  let lastThinking: string | null = null;
  // Ring of recent tool_use summaries (oldest at index 0).
  const precedingCandidates: ToolCallSummary[] = [];
  // Set once we hit a matching tool_use; collect up to windowSize more.
  let precedingLocked: ToolCallSummary[] | null = null;
  let userPromptAtLock: string | null = null;
  let thinkingAtLock: string | null = null;
  const followingCollected: ToolCallSummary[] = [];

  try {
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const entry = parseLine(line, logger);
      if (!entry) continue;

      switch (entry.type) {
        case 'user': {
          lastUserPrompt = truncateUtf8(entry.message.content, USER_PROMPT_CAP_BYTES);
          break;
        }
        case 'assistant': {
          // Snapshot the most recent 'thinking' block if present.
          for (const block of entry.message.content) {
            if (block.type === 'thinking') {
              lastThinking = truncateUtf8(block.thinking, THINKING_CAP_BYTES);
            }
          }
          break;
        }
        case 'tool_use': {
          const ts = parseTranscriptTimestamp(entry.timestamp);
          if (!Number.isFinite(ts)) break;
          const summary = summariseToolCall(entry, ts);

          if (precedingLocked && followingCollected.length < windowSize) {
            followingCollected.push(summary);
          }
          // Always also push into the ring — we may see a LATER matching
          // tool_use that resets us, in which case this entry needs to be
          // available as preceding context for that newer target. Cap at
          // windowSize+1 so the target itself fits without evicting the
          // oldest preceding entry; `slice(0, -1)` drops the target at
          // lock time.
          pushBounded(precedingCandidates, summary, windowSize + 1);

          if (matchesTargetFile(entry, opts.filePath)) {
            // Newer match — reset the post-collection.
            precedingLocked = precedingCandidates.slice(0, -1); // exclude the target itself
            userPromptAtLock = lastUserPrompt;
            thinkingAtLock = lastThinking;
            followingCollected.length = 0;
          }
          break;
        }
        case 'tool_result':
        case 'system':
          break;
      }
    }
  } catch (err) {
    logger?.debug?.('transcript', 'read.failed', { path: transcriptPath, err: String(err) });
    return EMPTY_WINDOW;
  }

  if (!precedingLocked) {
    // File never appeared in the transcript.
    return EMPTY_WINDOW;
  }

  return {
    userPrompt: userPromptAtLock,
    precedingToolCalls: precedingLocked.slice(),
    followingToolCalls: followingCollected.slice(),
    assistantThinking: thinkingAtLock,
  };
}

// --------------------------------------------------------------------------
// readTaskEntries — Wave 4 sub-agent attribution source
// --------------------------------------------------------------------------

/**
 * Enumerate every `Task` tool_use in the transcript with its timestamp and
 * description (from `tool_input.description`). Returned array is sorted
 * ascending by timestamp so the caller can binary-search.
 *
 * Empty array on any error.
 */
export async function readTaskEntries(
  transcriptPath: string,
  opts?: { logger?: Logger },
): Promise<TaskEntry[]> {
  const logger = opts?.logger;
  const entries: TaskEntry[] = [];

  try {
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const entry = parseLine(line, logger);
      if (!entry) continue;
      if (entry.type !== 'tool_use') continue;
      if (entry.tool_name !== 'Task') continue;
      const ts = parseTranscriptTimestamp(entry.timestamp);
      if (!Number.isFinite(ts)) continue;
      const description = extractTaskDescription(entry);
      if (!description) continue;
      entries.push({
        timestamp: ts,
        taskToolUseId: entry.id ?? entry.tool_use_id ?? null,
        description,
      });
    }
  } catch (err) {
    logger?.debug?.('transcript', 'taskScan.failed', { path: transcriptPath, err: String(err) });
    return [];
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

/**
 * Binary search: return the latest `TaskEntry` whose timestamp is <= `ts`.
 * Pure function — exposed for unit testing and for adapter callers that
 * already have the sorted list cached.
 */
export function findLatestTaskBefore(
  tasks: ReadonlyArray<TaskEntry>,
  ts: number,
): TaskEntry | null {
  if (tasks.length === 0) return null;
  let lo = 0, hi = tasks.length - 1;
  let best: TaskEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tasks[mid].timestamp <= ts) {
      best = tasks[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// --------------------------------------------------------------------------
// Helpers (module-local)
// --------------------------------------------------------------------------

function parseLine(line: string, logger?: Logger): TranscriptEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    logger?.debug?.('transcript', 'line.invalid-json');
    return null;
  }
  return decodeEntry(raw);
}

function matchesTargetFile(entry: ToolUseEntry, filePath: string): boolean {
  // Edit tools store the target path at tool_input.file_path. Treat the
  // input as a loose record (we already passed schema validation as
  // ToolUseEntry; the input is z.unknown()).
  const input = entry.tool_input as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== 'object') return false;
  return input.file_path === filePath;
}

function summariseToolCall(entry: ToolUseEntry, timestamp: number): ToolCallSummary {
  let inputSummary: string;
  try {
    inputSummary = JSON.stringify(entry.tool_input ?? null);
  } catch {
    inputSummary = '(unserialisable input)';
  }
  return {
    toolName: entry.tool_name,
    inputSummary: truncateUtf8(inputSummary, INPUT_SUMMARY_CAP_BYTES),
    timestamp,
  };
}

function extractTaskDescription(entry: ToolUseEntry): string | null {
  const input = entry.tool_input as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== 'object') return null;
  const desc = input.description;
  if (typeof desc !== 'string' || desc.length === 0) return null;
  return desc;
}

function pushBounded<T>(buf: T[], item: T, cap: number): void {
  buf.push(item);
  while (buf.length > cap) buf.shift();
}

function truncateUtf8(s: string, capBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= capBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, capBytes);
  return buf.toString('utf8') + ' …(truncated)';
}

/** Exported for unit tests. */
export const __test = {
  matchesTargetFile,
  summariseToolCall,
  extractTaskDescription,
  truncateUtf8,
};
