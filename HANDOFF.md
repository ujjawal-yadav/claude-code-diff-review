# HANDOFF.md — Claude Code Diff Review

> Read this end-to-end before touching code. It's the single source for what this project is, how it works, why decisions were made, and what's deferred. Everything else (`PROJECT_TRACKER.md`, `CHANGELOG.md`, `docs/*`) is supporting detail; this doc is the entry point.

> **2026-05-23 update — start with PROJECT_TRACKER.md's "Where we left off" banner first.** The architecture / threat-model / file-map sections below remain accurate for the v0.2.1 baseline. Deltas v0.3 → v0.5.1 are summarised in CHANGELOG.md and PROJECT_TRACKER.md's recent Session Log entries. The plan file `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md` is the canonical source for design decisions, locked resolutions, and the forward roadmap (v0.6 multi-language build-signal + Insights, v1.0 file-based token + zero-config onboarding).

---

## 1. Identity

| | |
|---|---|
| **Product** | Claude Code Diff Review |
| **Marketplace ID** | `UjjawalYadav.claude-code-diff-review` |
| **Repository** | `github.com/ujjawal-yadav/claude-code-diff-review` |
| **License** | MIT |
| **Engines** | `vscode ^1.85.0`, `node >=18` |
| **Stack** | TypeScript (strict + `exactOptionalPropertyTypes`), React 18 + Zustand (webview), Fastify (loopback server), Vitest |
| **Current version** | **0.5.1** (committed `00daf15` locally as combined v0.5.0 + v0.5.1; tag + push pending). Shipped to marketplace: v0.2.x, v0.3.0, v0.3.1, v0.4.0. |
| **Test count** | **513 / 513** passing (51 files) |
| **Bundle** | `dist/extension.js` ~975 KB (Node CJS), `dist/webview/index.js` ~367 KB (IIFE, chrome108); `.vsix` ~5.03 MB |
| **Runtime deps added since v0.2.1** | `cross-spawn@^7.0.6`, `tree-kill@^1.2.2`, `string-argv@^0.3.2` (all v0.5; MIT; license-audit pre-approved) |
| **Major features added since v0.2.1** | Risk flags + keyboard nav (v0.3) · Edit-before-accept + reject-with-feedback drafts + rename grouping (v0.4) · TypeScript build signal (v0.5) · Reliability + UX hotfix (v0.5.1). See CHANGELOG.md `[0.3.0]`–`[0.5.1]` entries. |
| **New top-level dirs since v0.2.1** | `src/buildSignal/` (v0.5 — 5 modules), `src/shared/` (v0.5.1 — 2 cross-bundle modules), `webview/components/{TooltipPopover,InlineExpandingPanel}.tsx` (v0.5.1, v0.4 respectively) |

---

## 2. Problem this product solves

Claude Code (Anthropic's terminal CLI) edits files autonomously. In a single "turn" it can edit 5, 20, sometimes 50 files. The user has two unappealing choices today:

1. **Accept blindly** and hope nothing's wrong. Risky for non-trivial refactors.
2. **Eyeball `git diff` after the fact.** Means accepting changes onto a dirty tree, then surgically reverting hunks via `git checkout -p`. Clunky, breaks flow, requires git proficiency.

This extension inserts a **session-aware per-hunk review surface** between Claude finishing a turn and the user committing to the changes. For each hunk: Accept, Reject (revert in place via diff inversion), or Ask Claude (streaming chat scoped to that hunk). No git required. The reverted file state is computed in-process from the captured pre-edit snapshot, not from a git index.

**Adjacent value adds shipped over time:**
- **History panel**: every past session reviewable any time (resume, rollback, delete).
- **Transcript-aware chat**: chat queries cite the user's original prompt and Claude's surrounding tool calls.
- **Sub-agent attribution**: files edited inside a `Task` invocation are labelled with the sub-agent description.
- **Crash recovery**: closed-panel sessions with unfinished hunks surface for resume.

---

## 3. Core mental model

```
Claude edits files in a workspace
    │
    ▼
PreToolUse hook  →  capture original file content (snapshot store)
    │
    ▼
Claude writes to disk
    │
    ▼
PostToolUse hook →  record touched path on the current turn
    │
    ▼
Stop hook        →  debounced openReview:
                    - read current disk state per file
                    - diff against snapshot
                    - emit FileReview { hunks: HunkReview[] }
                    - open WebviewPanel
                    - record turn-stopped to event log
    │
    ▼
User clicks Accept/Reject/Ask per hunk
    │
    ▼
Accept: mark in-memory only (file already has the change on disk)
Reject: recompute file content via set-based reversibility,
        write to disk through per-file mutex
Ask:    AnthropicClient.streamChat with hunk diff + transcript context
    │
    ▼
All hunks decided →  session complete; auto-cleanup
                     event log persists for History panel
```

The single most important architectural concept is **set-based reversibility**:

```
Given:
  originalSnapshot  = file content BEFORE Claude edited it
  allHunks          = the hunks Claude produced (frozen for the session)
  acceptedSet       = a set of hunk indices the user has accepted

File content at any time = applyHunks(originalSnapshot, allHunks ∩ acceptedSet)
```

This means:
- **Reject** = remove a hunk from `acceptedSet`, re-render, write to disk.
- **Accept** = add to set, no disk write (it's already there from Claude's write).
- **Undo** = invert set membership.
- **Reconstruction from event log** = replay events, rebuild `acceptedSet` from `hunk-decided` events.

Per-hunk text fuzz factor only matters when computing the diff once at openReview time. Subsequent accept/reject operations don't fuzz — they re-render from the snapshot + set, which is deterministic.

---

## 4. Use cases

### Primary
1. Claude makes 20 edits in one turn; user reviews each and accepts/rejects hunk-by-hunk.
2. Reject part of a refactor while keeping the rest — file on disk converges to the intended subset.
3. Click 💬 Ask on a non-obvious hunk; streaming response cites the original prompt + Claude's surrounding tool calls.
4. Close the panel mid-review, come back later, click Resume Review on the session card → state restored.
5. Decide an entire turn was wrong → Rollback this turn → all files restored to pre-edit content via the event log.
6. Delete a session permanently → segments and unreferenced blobs garbage-collected.

### Secondary
7. Cross-session decision history: every turn ever, browsable, with per-file decision counts and timestamps.
8. Sub-agent attribution: see which files came from which `Task` invocation in a multi-agent session.
9. Pro/Max OAuth via `claude /login` (reads `~/.claude/.credentials.json`); no API key required for chat.
10. Personal Anthropic API key (`sk-ant-api03-…`) as fallback.
11. Switch between user and workspace install scopes via command.
12. Crash recovery probe on activation: sessions with open turns within 7 days surface a toast.

### Edge cases handled
13. External edit modifies a file mid-review → drift detected, banner shown, hunks re-diff against current disk.
14. Claude continues editing in a resumed session → prior decisions preserved (Bug B fix).
15. Multiple panels open simultaneously → events route by `sessionId` (Bug D fix), not by path.
16. Bearer token mismatch (terminal opened before extension activation) → burst-detector toast surfaces `[Open New Terminal]` after 3 401s in 10s.
17. Hook config has legacy unmarked entries from older extension versions → auto-stripped on activation, logged as `hooks.legacy.stripped`.
18. Per-file mutex serialises concurrent hunk actions on the same file; different files run in parallel.

### Negative use cases (deliberately NOT supported)
- Remote / SSH / Dev Container / WSL — server binds to 127.0.0.1 in the local extension host.
- Multi-root workspaces — only the first workspace folder's `.claude/` is used.
- Gating Claude's tool calls — we observe and react; we don't block.
- Non-Claude agents — `AgentAdapter` interface exists but only `ClaudeCodeAdapter` is implemented.

---

## 5. Architecture overview

### High-level component graph

```
┌──────────────────────────────────────────────────────────────────────┐
│                       VS Code Extension Host                          │
│                                                                       │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐    │
│  │ Fastify HTTP │───▶│ ClaudeCodeAdapter│───▶│ReviewOrchestrator│    │
│  │ (127.0.0.1)  │    │  (parse + norm)  │    │ (state machine)  │    │
│  └──────▲───────┘    └──────────────────┘    └────────┬─────────┘    │
│         │                                              │              │
│   PreToolUse/                                          │              │
│   PostToolUse/                                ┌────────┴─────────┐    │
│   Stop with                                   │  HistoryService  │    │
│   $CLAUDE_REVIEW_TOKEN                        │  (event log +    │    │
│                                               │   blob store)    │    │
│                                               └────────┬─────────┘    │
│         ┌──────────────────────────────────┐           │              │
│         │       SnapshotStore              │           │              │
│         │  (per-(sid,path) originals)      │           │              │
│         └──────────────────────────────────┘           │              │
│                                                        │              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────┴──────────┐   │
│  │ ReviewPanelMgr  │  │HistoryPanelMgr   │  │PendingStatusBar    │   │
│  │ (webview)       │  │ (webview)        │  │(↶ N pending)       │   │
│  └─────────────────┘  └──────────────────┘  └────────────────────┘   │
│                                                                       │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐   │
│  │ AnthropicClient │  │ ChatService      │  │StatusBarController │   │
│  │ (streaming)     │  │ (per hunk chat)  │  │(live-session count)│   │
│  └─────────────────┘  └──────────────────┘  └────────────────────┘   │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
              ▲                                          │
              │                                          ▼
       Claude Code spawns                       ~/.claude/review-history/
       hooks against our server                 <workspaceHash>/
       (env var substitution)                     ├── index.json
                                                  ├── sessions/<sid>.0.jsonl
                                                  └── blobs/<sha256-prefix>/
```

### Trust boundaries

```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│      Claude Code     │   │   Extension Host     │   │       Webview        │
│  (separate process)  │──▶│  (Node.js + vscode)  │──▶│ (sandboxed iframe)   │
│                      │   │                      │   │                      │
│  • Hook payloads     │   │  • Sees tokens       │   │  • Strict CSP         │
│  • $CLAUDE_REVIEW_   │   │  • Reads transcript  │   │  • connect-src 'none' │
│    TOKEN at fork     │   │  • Streams chat      │   │  • Per-panel nonce    │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘

Security invariants:
- Bearer token in OS keychain only; never logged, never crossed to webview
- Transcript content stays host-side; never crossed to webview (integration-tested)
- All webview messages Zod-validated (input + output)
- Bearer compare is constant-time (timingSafeEqual + equal-length-dummy)
```

---

## 6. File map

### `src/` (extension host)

| File | Purpose |
|---|---|
| `extension.ts` | Activation god-file. Wires every service together. ~700 LOC. Owns lifecycle. |
| `logger.ts` | JSON-line OutputChannel writer with depth-limited secret redactor. |
| `secretManager.ts` | `vscode.SecretStorage` wrapper for bearer token, OAuth token, API key. `getOrCreateBearerToken` (default path) + `rotateBearerToken` (explicit command). |
| `credentialResolver.ts` | 5-stage credential lookup (CLAUDE_CODE_OAUTH_TOKEN env, CLAUDE_REVIEW_OAUTH_TOKEN env, SecretStorage OAuth, `~/.claude/.credentials.json` file, SecretStorage API key). Per-call, never throws. |
| `server.ts` | Fastify on 127.0.0.1. Constant-time bearer auth. 10 MB body cap. 8 s handler timeout. Logs `auth.failed` with length-only + 13-char prefix on 401. Calls `onAuthFailure` callback. |
| `hookConfigurator.ts` | Atomic merge of `.claude/settings.json`. Marker key `x-claude-review-extension: v1`. Auto-strips legacy unmarked entries matching `OUR_HOOK_URL_RE`. |
| `snapshotStore.ts` | Per-session map of `originals: Map<AbsPath, string>`. `captureOriginal` reads file once at first PreToolUse. `beginTurnIfNeeded` mints turn ids. `currentTurnTouched` set scopes per-turn writes. Path-traversal guard via `resolveSafe`. |
| `diffEngine.ts` | `structuredPatch(context: 3)`. `revertHunk` with `fuzzFactor: 2` retry. CRLF + binary (NUL) detection. Pure functions. |
| `reviewOrchestrator.ts` | Session state machine. **~1500 LOC god-class.** Owns `sessions: Map<SessionId, SessionReview>`, `byPath`, `globalByPath`, `hunkSets`, `undoStack`. Per-file mutex via `lockFile`. Routes hook events → openReview, hunk actions → applyHunkSetChange, undo, dismissSession, adoptReconstructed, rollbackTurnFromHistory. |
| `reviewPanel.ts` | WebviewPanel lifecycle per session. CSP nonce regenerated per panel. `connect-src 'none'`. Coalesced `postMessage` flush via `setImmediate`. Dispatches webview messages (accept-hunk, reject-hunk, chat-message, open-history, …). |
| `statusBarController.ts` | Live-session pending indicator. Priority 100. `$(diff) N hunks pending`. |
| `pendingStatusBar.ts` | Recoverable-session pending indicator (β.0 / 10.1.6). Sibling of `StatusBarController`, NOT a subclass. Priority 99. `$(history) N hunks pending`. Subscribes to `HistoryService.addChangeListener`. |
| `authFailureBurstDetector.ts` | Sliding-window detector (3 in 10s, 60s cooldown). Toast: `[Open New Terminal] [Show Logs] [Rotate Token]`. Test-injectable `showToast`, `executeAction`, `now`. |
| `codeLensProvider.ts` | Gutter Accept/Reject buttons aligned to hunk start lines. `ACCEPT_HUNK_AT` / `REJECT_HUNK_AT` commands dispatch into the orchestrator. |
| `onboarding.ts` | First-run toast. 4 actions: Set OAuth Token, Set API Key, Use claude /login (with Verify Now), Dismiss. Gated by `globalState['claudeReview.onboarding.shownAt']`. Skips silently if a credential is resolvable. |
| `anthropicClient.ts` | Anthropic SDK wrapper. `streamChat(req, handlers, signal)`. System prompt v2 (`HUNK_REVIEW_PROMPT_VERSION = 'v2'`) with transcript-aware addition. Lazy credential resolution per call. |
| `chatService.ts` | Per-(sessionId, filePath, hunkIndex) chat history. Injects transcript context if `transcriptContextEnabled`. Strict separation: transcript bytes never crossed to webview. |
| `telemetry.ts` | Opt-in. Gated by `claudeReview.telemetry` + VS Code global telemetry setting. Batched 10s flush. PII-scrubbed. |
| `scmProvider.ts` | `ClaudeReviewScmProvider`. Files appear in SCM panel under Pending / Partial / Rejected / Accepted resource groups with strikethrough/faded decorations. |
| `messages.ts` | All Zod schemas: hook payloads (`PreToolUsePayload`, `PostToolUsePayload`, `StopPayload`) and webview ↔ host discriminated unions. `WebviewToHost`, `HistoryWebviewToHost`, `HostToWebview`, `HistoryHostToWebview`. |
| `types.ts` | Branded primitives (`SessionId`, `AbsPath`). Core domain types: `SessionData`, `SessionReview`, `FileReview`, `HunkReview`, `HunkStatus`, `AgentId` (single source of truth). |
| `adapters/agentAdapter.ts` | Interface: `parsePreToolUse`, `parsePostToolUse`, `parseStop`, `generateHookConfig`, `resolveTranscriptPath`, `extractSubagentId`. Pure-data contract; no VS Code imports. |
| `adapters/claudeCodeAdapter.ts` | Only concrete adapter. ~300 LOC. Parses Claude hook payloads. Generates HTTP hook config with `$CLAUDE_REVIEW_TOKEN` substitution. Resolves transcript path via cwd-encoding. Extracts sub-agent id from transcript with per-session promise-coalesced cache (Bug E fix). |
| `adapters/index.ts` | `agentAdapters: Map<AgentId, AgentAdapter>`. Single entry today. |
| `history/historyService.ts` | The orchestrator for the event log + blob store + index. ~1100 LOC. `recordTurnStarted`, `recordTurnStopped`, `recordHunkDecided`, `recordFileSnapshotReverted`, `recordUndo`, `recordTurnAborted`, `deleteSession`, `listSessions`, `getPendingReviewsSummary` (1s TTL cache), `reconstructSessionReview` (event-log replay with Promise.all blob batches), `addChangeListener` (multi-listener Set, 7 emission sites). |
| `history/historyEvents.ts` | Zod schemas for `turn-started`, `turn-stopped`, `hunk-decided`, `file-snapshot-reverted`, `undo`, `turn-aborted`. Forward-compat: optional fields ignored on read. |
| `history/historyTypes.ts` | Pure types: `PendingReviewsSummary`, `ReconstructedSessionReview`, `ReconstructedFileReview`, `FileDriftStatus`, `SessionIndexEntry`. No Node imports — webview-safe. |
| `history/historyBlobs.ts` | Content-addressed SHA-256 blob store. `BlobStore.write(content)`, `.read(sha)`, `.delete(sha)`. Atomic tmp+rename. |
| `history/historyWriter.ts` | Append-only JSONL per session. 5 MB segments (`<sid>.0.jsonl`, `<sid>.1.jsonl`, …). Per-session promise-chain lock. Per-event size guard (rejects >5 MB events). |
| `history/historyReader.ts` | Streaming reader. `readSession(sid)` returns async generator. `findResumeCandidates({ withinMs })`. |
| `history/historyIndex.ts` | `~/.claude/review-history/<workspaceHash>/index.json`. Per-instance write mutex. Atomic tmp+rename. Maintained fields: `sessionId`, `agentId`, `startedAt`, `lastEventAt`, `turns`, `status`, `lastAssistantMessage`, `hasOpenTurn`, `pendingHunkCount`. |
| `transcript/transcriptSchema.ts` | Zod for Claude transcript entries (user, assistant, tool_use, tool_result, system). Tolerant decode. |
| `transcript/transcriptReader.ts` | Heap-bounded JSONL streaming via `readline`. Exports: `readTranscriptWindow` (chat context), `readTaskEntries` (sub-agent attribution). Ring-buffer windowing. Path-traversal guard on sessionId. |

### `webview/` (review panel)

| File | Purpose |
|---|---|
| `App.tsx` | Root component. Reads from Zustand store. Mounts `<SessionHeader>`, `<FileList>`, `<DiffPane>`, `<ChatOverlay>`. |
| `store.ts` | Zustand store. `useUi` hook exposes session, viewType, selectedFileIndex, undoDepth, chat. |
| `vscode.ts` | `acquireVsCodeApi()` wrapper + `send` postMessage helper. |
| `components/SessionHeader.tsx` | Top bar: title, file count, hunk count. Action buttons: Toggle view, Accept all, Reject all, Undo, **📜 History** (v0.2.1). |
| `components/FileList.tsx` | Virtualised file picker (`react-virtuoso` at >50 files). Per-file row: NEW/DEL/BIN tags, sub-agent chip, pending pill. |
| `components/DiffPane.tsx` | Single-file diff renderer. Lazy expansion. Header with sub-agent tooltip. |
| `components/HunkBlock.tsx` | Per-hunk renderer. Custom split + unified line renderers. Accept / Reject / 💬 Ask buttons. Read-only badge for decided hunks. |
| `components/ChatOverlay.tsx` | Side panel overlay for the active chat. Streaming deltas. Auth error renders `<AuthHelp>` with Set API Key / Set OAuth / Use claude /login buttons. |
| `components/Splitter.tsx`, `HeaderSplitter.tsx` | Resize handles. Width persists across panel reload. |
| `components/ErrorBoundary.tsx` | Top-level error wall. |
| `history/App.tsx` | History panel root. |
| `history/components/SessionList.tsx` | Left sidebar. Session cards with status badge, pending-count badge, last-event-ago. |
| `history/components/SessionDetail.tsx` | Right pane. Header action bar (Resume / Rollback / Delete with modal confirms). Turn timeline with file lists, decision counts, sub-agent inline labels. |
| `history/vscode.ts` | postMessage helper for history-webview-to-host messages. |

### Other top-level

| File | Purpose |
|---|---|
| `package.json` | Manifest. 11 commands, 14 config keys (post-Wave-1 audit), galleryBanner, icon, etc. |
| `esbuild.config.mjs` | Dual bundle: extension (Node CJS) + webview (IIFE chrome108). `@anthropic-ai/sdk` left external for cold-start savings. |
| `.vscodeignore` | Excludes src/webview/tests/docs. Includes `assets/icon.png` but excludes `assets/feature.png` + `assets/screenshots/` (those resolve from GitHub raw URLs). |
| `scripts/auditLicenses.mjs` | Production-dep license check against allowlist. |
| `scripts/generateSbom.mjs` | CycloneDX SBOM emission to `dist/sbom.cdx.json`. |
| `scripts/extractChangelog.mjs` | Slices a single version's section from CHANGELOG.md (used by release.yml). |
| `.github/workflows/ci.yml` | Per-PR CI matrix: macos/linux/windows × node20. |
| `.github/workflows/release.yml` | Tag-triggered. Verifies tag↔package.json version, runs release:check, regenerates SBOM, packages VSIX, publishes to VS Code Marketplace + Open VSX (latter conditional on `OVSX_PAT`), creates GitHub Release with VSIX + SBOM. |
| `docs/RELEASE.md` | 12-step manual release runbook. |
| `docs/qa.md` | Manual QA checklist (sections A–T). |
| `docs/METRICS.md` | Telemetry events catalogue. |
| `assets/icon.png` | Marketplace listing icon (1024×1024 chat-bubble image). |
| `assets/feature.png` | README hero image (served from GitHub raw URL). |
| `assets/screenshots/` | README screenshots (also GitHub raw URLs). |

### Test surface

`tests/unit/` and `tests/integration/`. Notable files:
- `tests/integration/server.test.ts` — server auth, fuzz, 401 observability
- `tests/integration/orchestrator.set.test.ts` — set-based reversibility integration
- `tests/integration/resume-and-continue.test.ts` — Bug B+C regression
- `tests/integration/history.reconstruction.test.ts` — replay correctness
- `tests/integration/history.liveUpdate.test.ts` — emitter channel contract
- `tests/integration/orchestrator.adoptReconstructed.test.ts` — round-trip equivalence
- `tests/integration/chat.transcript.test.ts` — transcript injection + security boundary
- `tests/integration/subagent.test.ts` — attribution end-to-end
- `tests/unit/authFailureBurstDetector.test.ts` — burst detector contract
- `tests/unit/rotateBearerToken.test.ts` — command flow
- `tests/integration/perf.bench.test.ts` — Stop→init dispatch <4500 ms P99

---

## 7. Core data shapes

### `SessionData` (`src/types.ts`)
Per-session ephemeral state inside `SnapshotStore`.
```ts
{
  agentId: AgentId,
  cwd: string,
  currentTurnId: string | null,
  lastTurnId: string | null,
  turnStartedAt: number | null,
  originals: Map<AbsPath, string>,
  touched: Set<AbsPath>,
  currentTurnTouched: Set<AbsPath>,        // scoped per-turn
  subagentIdByPath: Map<AbsPath, string | null>,
  byteBudget: number,
  fileBudget: number,
  overBudget: boolean,
}
```

### `SessionReview` / `FileReview` / `HunkReview` (`src/types.ts`)
What the orchestrator holds in memory + what the webview renders.
```ts
SessionReview {
  sessionId: SessionId,
  agentId: AgentId,
  cwd: string,
  files: FileReview[],
  metrics: SessionMetrics,
  // … timing, banner, viewType …
}

FileReview {
  filePath: AbsPath,
  relPath: string,
  before: string,
  after: string,
  hunks: HunkReview[],
  isNew: boolean,
  isDeleted: boolean,
  isBinary: boolean,
  subagentId?: string,           // file-level only, never on HunkReview
  status: 'pending' | 'partial' | 'accepted' | 'rejected',
  warnings?: FileWarning[],
}

HunkReview {
  index: number,
  oldStart: number, oldLines: number,
  newStart: number, newLines: number,
  header: string,
  lines: string[],
  status: HunkStatus,             // pending | accepted | rejected
  decidedAt?: number,
}
```

### `HunkSetState` (`src/core/hunkSet.ts`)
The set-based reversibility primitive.
```ts
{
  originalSnapshot: string,
  allHunks: ReadonlyArray<StructuredHunk>,
  acceptedSet: Set<number>,
}
```
Rendering: `applyHunks(originalSnapshot, allHunks.filter((_, i) => acceptedSet.has(i)))`.

### Event log entries (`src/history/historyEvents.ts`)
Discriminated by `kind`. Each event has `v`, `eventId`, `ts`, `turnId`, `agentId`.
```
turn-started     { files: [{ path, beforeBlob, mtimeBeforeMs }] }
turn-stopped     { files: [{ path, afterBlob, isNew, isDeleted, isBinary, subagentId?, hunks: [...] }], lastAssistantMessage }
hunk-decided     { path, hunkIdx, decision, postBlob, drift, subagentId? }
file-snapshot-reverted { path, postBlob, subagentId? }
undo             { scope, target: { srcTurnId, srcEventId, path?, hunkIdx? }, postBlobs: Record<path, sha>, cascaded[] }
turn-aborted     { reason: 'window-closed' | 'extension-deactivated' | 'circuit-breaker' | 'timeout' }
```

### Index file (`src/history/historyIndex.ts`)
`~/.claude/review-history/<workspaceHash>/index.json`.
```json
{
  "version": 1,
  "sessions": [
    {
      "sessionId": "…",
      "agentId": "claude-code",
      "startedAt": 1716000000,
      "lastEventAt": 1716000123,
      "turns": 2,
      "status": "open" | "closed" | "aborted",
      "lastAssistantMessage": "Added a comment…",
      "hasOpenTurn": false,
      "pendingHunkCount": 3
    }
  ]
}
```

---

## 8. Lifecycle traces

### Activation (`src/extension.ts`, ~200 ordered steps; this is the spine)
1. Logger.
2. SecretManager.
3. `secrets.getOrCreateBearerToken()` (keychain reuse or fresh).
4. `environmentVariableCollection.replace('CLAUDE_REVIEW_TOKEN', token)` + `persistent = true`.
5. SnapshotStore.
6. ReviewPanelManager.
7. HistoryService (if `history.enabled`).
8. AnthropicClient with `resolveCredential` lambda.
9. ChatService.
10. StatusBarController.
11. PendingStatusBar (if HistoryService).
12. AuthFailureBurstDetector + wire `history.addChangeListener → pendingStatusBar.scheduleRefresh`.
13. `agentAdapters.get('claude-code')`.
14. ReviewOrchestrator (`onChange: codeLens.refresh + pendingStatusBar.scheduleRefresh`, `onDismissSession: clearSubagentCache`).
15. CodeLens provider.
16. SCM provider (lazy).
17. HistoryPanelManager.
18. `startServer({ … onAuthFailure: () => detector.record() })`.
19. `ensureHooksInstalled` (deferred via fire-and-forget).
20. Crash-recovery probe (`findResumeCandidates({ withinMs: 7d })` → toast).
21. Gitignore prompt (workspace-scope only, one-shot).
22. Onboarding (one-shot, skips if credential resolves).
23. Commands registered (11).

### Hook event lifecycle (single Edit by Claude)
```
Claude → PreToolUse HTTP POST → server.ts onRequest authorize
                              → adapter.parsePreToolUse
                              → orchestrator.onPreToolUse:
                                  • adapter.extractSubagentId (async, cached)
                                  • store.beginTurnIfNeeded(sid, cwd)
                                  • store.captureOriginal(sid, cwd, relPath, agentId, subagentId)
                                  • if freshlyMinted: history.recordTurnStarted

Claude writes file to disk

Claude → PostToolUse HTTP POST → similar path
                              → orchestrator.onPostToolUse:
                                  • store.recordTouched(sid, cwd, relPath, subagentId)

Claude → Stop HTTP POST → orchestrator.handleStop(sid, stopHookActive, lastAssistantMessage)
                       → debounce 250ms
                       → if not stopHookActive AND touched.size > 0:
                            • for each touched file: read disk, diff against original
                            • build FileReview list
                            • preserve prior decisions via hunksAlignedShallow (Bug B fix)
                            • ReviewPanelManager.openOrFocus(review)
                            • history.recordTurnStopped (awaited, not fire-and-forget)
                       → endTurn (sets lastTurnId = currentTurnId, clears currentTurnId)
```

### Hunk action lifecycle (Reject hunk 1 in file A)
```
Webview button click
  → send({ type: 'reject-hunk', filePath, hunkIndex: 1 })
  → ReviewPanelManager dispatch
  → orchestrator.handleHunkAction(sid, absPath, 1, 'reject')
  → lockFile(absPath, async () => {
      • Pre-check: ignore if hunk already decided
      • Get HunkSetState for this file
      • Push UndoSnapshot to per-session undoStack
      • applyHunkSetChange(state, { kind: 'remove', hunkIndex: 1 })
        → newAcceptedSet = state.acceptedSet \ {1}
        → newContent = renderFromSet(originalSnapshot, allHunks, newAcceptedSet)
      • writeFile(absPath, newContent)
      • history.recordHunkDecisionEvent(sid, turnId, agentId, relPath, 1, 'rejected', postContent, drift, subagentId)
      • file.hunks[1].status = 'rejected', decidedAt = now
      • recomputeFileStatus(file)
      • panel.postFileUpdated(sid, absPath, file)
      • onChange()  → codeLens.refresh + pendingStatusBar.scheduleRefresh
    })
  → if session all-decided: panel.postSessionCompleted, dismissSession
```

### Resume flow (user clicks Resume on a session card)
```
HistoryPanel webview: send({ type: 'resume-session', sessionId })
  → HistoryPanelManager.dispatch
  → orchestrator.getSession(sid) — if live, just openOrFocus, done

  → history.reconstructSessionReview(sid):
      • for await ev of reader.readSession(sid):
          • turn-started: Promise.all blob reads → state.originalSnapshot
          • turn-stopped: Promise.all blob reads → state.afterContent, .hunks, .acceptedSet
          • hunk-decided: toggle state.acceptedSet, set hunk.status
          • file-snapshot-reverted: clear set, mark hunks rejected
          • undo: re-anchor from postBlobs
      • Compute drift per file (clean/drifted/missing) against current disk
      • Return ReconstructedSessionReview

  → orchestrator.adoptReconstructed(recon):
      • store.injectSession(sid, cwd, originals, agentId, currentTurnId: null, lastTurnId: recon.turnId, …)
      • sessions.set, byPath.set, globalByPath.set, hunkSets.set, undoStack.set([])
      • For drifted files: post FileWarning { kind: 'external-edit' }; re-diff against current disk
      • For missing files: post FileWarning { kind: 'vanished' }; offer Restore from snapshot

  → reviewPanel.openOrFocus(review)
  → pendingStatusBar.scheduleRefresh
```

### Live update (HistoryService.addChangeListener channel)
```
Any successful record* / deleteSession write
  → emitChange({ sessionId, kind })
  → Set<Listener> iterated, each in try/catch

Listener 1: HistoryPanelManager.scheduleSessionListRefresh
  → trailing-edge 300ms debounce
  → listSessions() → post({ type: 'init', sessions, root })
  → webview replaces session list, preserves selectedId

Listener 2: PendingStatusBar.scheduleRefresh
  → internal 1s debounce + 1s TTL cache on getPendingReviewsSummary
  → refresh updates the $(history) N pending text + tooltip
```

---

## 9. Security model

### Trust boundaries
- **Claude Code → Extension Host**: bearer-authenticated HTTP. Constant-time compare. 401 logged with length-only signals.
- **Extension Host → Webview**: postMessage; Zod-validated both directions; CSP nonce + `connect-src 'none'`.
- **Extension Host → Filesystem**: atomic writes (tmp+rename) for settings.json, gitignore, blob store, index file.

### Token lifecycle (post-Auth-UX-Wave, 2026-05-19)
- Generated lazily on first activation; stored in `vscode.SecretStorage` (OS keychain).
- Reused across activations and across window reloads (`environmentVariableCollection.persistent = true`).
- Injected into terminals VS Code spawns via `environmentVariableCollection.replace`.
- Explicit rotation via `claudeReview.rotateBearerToken` command (offers Reload Window action because the running server captured `expectedToken` as a Buffer at start time).
- **Known constraint:** terminals spawned BEFORE extension activation don't inherit the env var. Burst-detector toast surfaces recovery within ~10s of the first 401.

### Secret handling discipline
- API key / OAuth token: SecretStorage only; never logged; never crossed to webview. Resolver redacts via `safeAwait`.
- Bearer token: keychain only; auth.failed log records 13-char header prefix (sufficient to distinguish `Bearer …` vs `Basic …` vs raw token; insufficient to brute-force on a rate-limited localhost server).
- Transcript content: read host-side; never crossed to webview; covered by `tests/integration/chat.transcript.test.ts` security assertion.

### Path-traversal guards
- `SnapshotStore.resolveSafe`: rejects relPaths that escape cwd.
- `historyService.joinCwd`: same guard; returns null + logs `path.escape.rejected`.
- `adapter.resolveTranscriptPath`: rejects sessionId containing `..` or path separators before `path.resolve` normalises.
- `transcriptReader.readTranscriptWindow`: doesn't follow symlinks; reads directly.

### Concurrency safety
- `SnapshotStore`: per-(sessionId, AbsPath) Promise-chain mutex.
- `ReviewOrchestrator.lockFile`: per-AbsPath mutex for the action pipeline (reject, accept, undo, revertFileToSnapshot).
- `HistoryWriter.locked`: per-sessionId mutex around append.
- `HistoryIndexFile.update`: per-instance mutex.
- `HistoryService.addChangeListener` callbacks: each in try/catch; broken listener cannot corrupt the write path.

---

## 10. Configuration surface (`package.json` post-Wave-1 audit)

| Key | Default | Purpose |
|---|---|---|
| `installScope` | `user` | `user` writes hooks to `~/.claude/settings.json`; `workspace` writes to `<workspace>/.claude/settings.json`. Migrate via command. |
| `history.enabled` | `true` | Master switch for the event log. Off → no record/replay; existing logs not deleted. |
| `history.retentionDays` | `30` | Sessions older than this are swept every 10 min. |
| `crashRecoveryToast.enabled` | `true` | Deprecated; default flips false in v0.4. Superseded by `PendingStatusBar`. |
| `chat.transcriptContext` | `true` | Inject user prompt + tool calls into hunk chat. Off → hunk-only chat. |
| `port` | `53117` | Preferred loopback port. 0 = always dynamic. |
| `autoOpenPanel` | `true` | Open review panel automatically after Stop. |
| `defaultDiffView` | `split` | `split` or `unified`. |
| `chatModel` | `claude-haiku-4-5-20251001` | Model for hunk chat. Switch to sonnet/opus for deeper reviews. |
| `chatMaxTokens` | `2048` | Max output tokens per chat response. |
| `maxSessionBytes` | `52428800` (50 MB) | Per-session snapshot cap. |
| `maxFilesPerSession` | `200` | File-count cap per session. |
| `telemetry` | `off` | Opt-in. Also gated by VS Code global telemetry setting. |
| `logLevel` | `info` | `debug` | `info` | `warn` | `error`. |

**Removed in v0.2.0** (Wave-1 audit, 2026-05-20): `rotateTokenOnDeactivate` (unused after stable-token migration), `history.crossTurnUndo` (declared but never wired).

---

## 11. Commands surface

| Command | Title | Purpose |
|---|---|---|
| `claudeReview.openPanel` | Open Review Panel | Open existing session panel; if none + recoverable sessions, modal Resume/Open History/Dismiss. Bound to `Ctrl+Shift+R` / `Cmd+Shift+R`. |
| `claudeReview.openHistory` | Open History Panel | Open history webview. |
| `claudeReview.removeHooks` | Remove Hooks | Strip marker entries (and legacy unmarked entries matching our URL pattern) from settings.json. |
| `claudeReview.switchInstallScope` | Switch Install Scope (user ↔ workspace) | Toggle scope, migrate hook config. |
| `claudeReview.setApiKey` / `clearApiKey` | Set/Clear Anthropic API Key | SecretStorage CRUD. |
| `claudeReview.setOAuthToken` / `clearOAuthToken` | Set/Clear Claude OAuth Token (Max plan) | SecretStorage CRUD. |
| `claudeReview.useClaudeCodeAuth` | Use Claude Code Auth (probe & report) | Runs the resolver, reports which source was found (without revealing the token). |
| `claudeReview.rotateBearerToken` | Rotate Bearer Token | Mints fresh token, updates env collection, offers Reload Window. |
| `claudeReview.showLog` | Show Log | Open the Output channel. |

---

## 12. Build + release

### Local build
```
npm install
npm run typecheck        # tsc --noEmit + tsc --noEmit -p tsconfig.webview.json
npm run lint
npm test                 # vitest run
npm run build            # esbuild → dist/
npm run package          # vsce package → claude-code-diff-review-<version>.vsix
```

### Release pipeline
```
npm run release:check    # typecheck + lint + test + audit:licenses + build
npm run audit:sbom       # CycloneDX SBOM → dist/sbom.cdx.json
npm version patch        # bump + commit + tag vX.Y.Z
git push origin main
git push origin vX.Y.Z   # triggers .github/workflows/release.yml
```

`release.yml` verifies tag↔version, runs release:check, regenerates SBOM, packages VSIX, publishes to:
- VS Code Marketplace (needs `VSCE_PAT` secret; Azure DevOps PAT with `All accessible organizations` + `Marketplace → Manage`)
- Open VSX (needs `OVSX_PAT`; **optional** — step is skipped if absent)

Then creates a GitHub Release with VSIX + SBOM attached, body extracted from `CHANGELOG.md` via `scripts/extractChangelog.mjs`.

Full per-release runbook: `docs/RELEASE.md`. QA checklist: `docs/qa.md`.

---

## 13. Locked design decisions

These are the things that were debated and locked, with the **why**. Don't undo them without understanding the prior reasoning.

| # | Decision | Why |
|---|---|---|
| 1 | `agentId` field on session, not `ClaudeSession → AgentSession` rename | Containment of blast radius over naming purity. |
| 2 | `subagentId` on `FileReview` only, not `HunkReview` | Task tool boundary is at the tool-call level; one Task produces one file with N hunks all attributable to the same sub-agent. |
| 3 | File-level mutex granularity (per-AbsPath, not per-session) | Different files can run actions in parallel; same-file serializes. |
| 4 | Default install scope = `user` | Every project picks up hooks automatically; ~95% of users want this. Workspace scope is the power-user escape hatch. |
| 5 | Stable bearer token (no per-activation rotation) | Per-activation rotation broke every terminal on every reload. Keychain reuse + `persistent: true` is the correct trade. |
| 6 | Trailing-edge 300 ms debounce for history-panel live refresh | Absorbs Claude's burst pattern (5–10 events in <50 ms); one post per turn. |
| 7 | 3-in-10s burst-detector threshold | Matches Pre+Post+Stop trio per turn. |
| 8 | 60 s cooldown post-toast | Prevents carpeting the user during recovery. |
| 9 | Resume re-opens the prior turn (currentTurnId: null, lastTurnId: recon.turnId) | User actions after resume attach to the original turn id via the `currentTurnId ?? lastTurnId` fallback path. Audit trail clean. |
| 10 | reDiff gated through `lockFile` | Closes the benign-today race that β.0's drift classification would have made observable. |
| 11 | adoptReconstructed verified via round-trip equivalence harness | Single test enforces "every field reconstruct/adopt knows about" without manual enumeration. |
| 12 | History panel actions confirmed via host-side modal (`{ modal: true }`) | Codebase has no webview-modal pattern; host modal is established. |
| 13 | extractSubagentId async + per-session promise cache | Lazy first-read, sub-ms subsequent lookups. Bounded memory: one TaskEntry array per live session, cleared on dismissSession. |
| 14 | Sub-agent UI: chip + tooltip + flat per-file label | Visible without dominating; tooltip carries full string. |
| 15 | System prompt v2 = minimal addition, not rewrite | Preserves v1's terse/decisive/hunk-focused character; lower regression risk. |
| 16 | Transcript reader is a single module with two exports | `readTranscriptWindow` (Wave 3 chat) + `readTaskEntries` (Wave 4 attribution) share streaming infrastructure. |
| 17 | Live-update emitter is a Set, not a single callback | Multi-listener required (panel + status bar + future). |
| 18 | AgentId source of truth = `src/types.ts` | `historyEvents.ts` and `adapters/agentAdapter.ts` re-export for back-compat. |
| 19 | Path-traversal guard returns null + logs (not throws) | Matches existing ENOENT contract; caller code paths unchanged. |
| 20 | Hook URL pattern as identity for legacy-cleanup | Self-heals stale duplicates from older versions. Logs every strip. |
| 21 | Header-prefix in auth.failed log = first 13 chars | Distinguishes scheme mismatch without leaking enough bytes to brute-force a 64-char hex token. |
| 22 | `feature.png` + screenshots excluded from VSIX | Resolve from GitHub raw URLs in README; saves ~1.3 MB per install. |

---

## 14. Deferred work / known unknowns

### Explicitly deferred (with rationale)

| Item | Rationale | Likely landing |
|---|---|---|
| OpenCode adapter (M9.4b) | OpenCode's HTTP-hook support unverified; shipping stub = dead branches | v0.4+ when verified |
| File-based token (Tier 3) | Cross-platform shell + jq dependency + per-hook subprocess latency | v1.0 if upstream behavior supports |
| Index-write batching | Real ~20-45ms/turn win but P99 budget headroom is large | Future perf slice |
| Keyboard shortcuts (a/r/?/arrows) | Powerful for review-heavy users; not blocking | v0.3 polish wave |
| Pending-only filter in review panel | UX polish for sessions with 200+ hunks | v0.3 |
| Per-session summary card | Closure beat after reviewing many hunks | v0.3 |
| Status-bar disambiguation | $(diff) vs $(history) visual similarity | v0.3 |
| Gitignore prompt delay | Currently fires on first activation; move to first save | v0.3 |
| Multi-root workspace history sharding | First-folder-only is simpler; rare in practice | v1.0+ |
| Remote/SSH/WSL support | Requires server-side install; not trivial | v1.0+ |
| Open VSX publish | User chose to skip initially; can add later | Future |
| Localisation | English only | v1.1+ |
| ReviewOrchestrator god-class split | Churn for churn's sake; file works | Indefinite |

### Active unknowns (need verification)
- **Does Claude Code re-read `~/.claude/settings.json` per tool invocation, or only at process startup?** This single answer determines whether file-based token (Option C) is a true root-cause fix or a partial one. Experiment ready: edit settings.json mid-session to set a decoy Authorization header; check whether the next hook fires with the decoy or the cached value. Pending user runs.

---

## 15. Current state (as of this writing)

- **Last shipped to marketplace:** v0.2.0 on 2026-05-20
- **Local tagged + packaged:** v0.2.1 (commit `5d92a78`, `claude-code-diff-review-0.2.1.vsix` at 4.87 MB)
- **Not pushed:** awaiting user confirmation before `git push origin main && git push origin v0.2.1`
- **Tests:** 343–345 passing (varies by parallel run; one flake in `orchestrator.undoAudit.test.ts` that passes in isolation)
- **Typecheck:** clean
- **Lint:** clean

### v0.2.1 contains
- Audience-first README opening + Roadmap section
- Onboarding "Use claude /login" branch with Verify Now action
- 📜 History button in review panel header
- Stale-claim refresh in README (sub-agent attribution shipped in v0.2; bearer-token persistence reflects keychain reuse)
- New icon (chat-bubble image at 1024×1024)
- New feature image (smaller, same chat-bubble)

### v0.3 currently planned
- Keyboard shortcuts
- Pending-only filter
- Per-session summary
- Status-bar disambiguation
- Proactive running-Claude detector (optional)
- Decision on file-based token vs file-watch architecture (driven by the settings.json re-read experiment)

---

## 16. How to extend (for future Claude sessions)

### When you're asked to add a feature

1. **Read `PROJECT_TRACKER.md` first.** It tracks active waves, deferred items, and design-decision history. The Session Log at the bottom shows what shipped in each commit.
2. **Read this file's Section 7 (data shapes)** to understand the domain.
3. **Read this file's Section 8 (lifecycles)** to know which entry points are affected.
4. **Run `npm test` before any code change.** Baseline of green before you touch anything.
5. **Use plan mode for non-trivial work.** Specifically: the plan file at `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md` is where every wave's plan has lived. Append a new section; don't overwrite.

### When you're asked to debug

1. **Check the Output channel logs first.** The user can usually paste them. `auth.failed`, `hooks.legacy.stripped`, `path.escape.rejected`, `recovery.probe.error` are the high-signal entries.
2. **Read the matching test.** Every feature has at least one. The test usually documents the contract better than the code.
3. **For hook auth issues:** verify `~/.claude/settings.json` doesn't have duplicate marker-less entries. The 2026-05-19 debugging session traced this exact failure.
4. **For credential issues:** trace `credentialResolver.ts` — the 5-stage order is the contract.

### When the user asks "should we ship X"

Apply this hierarchy:
1. **Reliability bugs** (data loss, security holes, crashes) — ship as soon as fixed.
2. **Audit-integrity gaps** (events that should fire but don't, state that should persist but doesn't) — ship in the next patch.
3. **Onboarding friction** (failures that hit users in the first 10 minutes) — ship in the next patch.
4. **Power-user polish** (keyboard shortcuts, filters, summary cards) — batch into a minor release.
5. **Architectural refactors** (god-class splits, abstraction extractions) — only when concrete pain motivates them.

### When in doubt

- The user values **terse + technical** communication. Cite file:line, not vibes.
- The user reasons in **impact + architecture**, not in time-to-ship (per the memory file). Never size in days.
- The user runs **plan mode** explicitly; don't go into it unprompted.
- The user prefers **comprehensive plan docs over splintered commits** — one big chore commit per wave is fine.

---

## 17. Quick reference: "where does X live?"

| Question | File |
|---|---|
| Where does the server bind? | `src/server.ts:47` (HOST = '127.0.0.1') |
| Where does auth happen? | `src/server.ts:63-95` (onRequest hook with `authorize` helper) |
| Where does the bearer token come from? | `src/secretManager.ts:rotateBearerToken` / `getOrCreateBearerToken` |
| Where are hooks installed? | `src/hookConfigurator.ts:ensureHooksInstalled` |
| Where is the session state machine? | `src/reviewOrchestrator.ts` |
| Where is "what's on disk now?" computed for a hunk action? | `src/core/hunkSet.ts:renderFromSet` |
| Where is the event log written? | `src/history/historyWriter.ts:append` |
| Where is reconstruction? | `src/history/historyService.ts:reconstructSessionReview` |
| Where is the History panel UI? | `webview/history/components/SessionDetail.tsx` |
| Where is the chat panel UI? | `webview/components/ChatOverlay.tsx` |
| Where are messages validated? | `src/messages.ts` (Zod schemas) |
| Where does the burst detector live? | `src/authFailureBurstDetector.ts` |
| Where does the transcript get read? | `src/transcript/transcriptReader.ts` |
| Where does the orchestrator know what file a hunk action targets? | `byPath: Map<SessionId, Map<AbsPath, FileReview>>` in `reviewOrchestrator.ts` |
| Where does multi-panel routing happen? | PanelGateway interface — `postFileUpdated/postHunkApplied/postSetConflict` accept `sessionId` as first arg (Bug D fix) |

---

*This document is the entry point. Everything else is supporting detail.*
