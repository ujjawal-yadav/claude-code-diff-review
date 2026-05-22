# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: SemVer.

## [Unreleased]

_No unreleased changes yet._

## [0.3.0] — 2026-05-22

The first **decision-support** release. Prior releases optimised the mechanics of reviewing each hunk; v0.3 starts adding signal about which hunks are worth your attention in the first place. The headline additions are risk-flag triage on files and hunks, keyboard-driven review for rapid pass-through, and a fix for the per-line scrollbar mess in split view.

### Added

- **Risk flags** — heuristic triage surfaces in the review panel. Files get a chip in the left list; hunks get inline badges on the header; the session header shows an "N flagged" count. Categories:
  - 🔴 **sensitive-path** — paths matching `.env`, `secrets`, `credentials`, `migrations`, `auth`, `crypto`, `cert`, `private-keys`, `access-tokens`
  - ⚠ **removed-error-handling** — hunk removes `try`/`catch`/`throw`/`finally`/`raise`/`except`
  - ⚠ **removed-null-check** — hunk removes `!= null` / `!== null` / `?.` / `??` / `isnil` / `is None`
  - 🟡 **deletion** — pure-deletion hunk (no additions)
  - 🟡 **large-hunk** — hunk changes more than 50 lines
  - 🧪 **test-file** — test/spec file (lower risk than production)
  - 🔒 **lockfile** — generated lockfile (`package-lock.json`, `yarn.lock`, `Cargo.lock`, …)
  - Multiple flags compose; chip shows the most-severe one; tooltip lists all.
  - Toggle via `claudeReview.riskFlags.enabled` (default `true`).

- **Keyboard-driven review** — global keybindings for the review panel:
  - `j` / `↓` next hunk · `k` / `↑` previous hunk
  - `Shift+J` next flagged hunk · `Shift+K` previous flagged hunk
  - `a` accept selected hunk · `r` reject selected hunk
  - `?` open chat for selected hunk
  - `Space` toggle expand/collapse selected file
  - `Esc` close chat overlay / help overlay
  - `Shift+/` (`?`) show keyboard shortcuts help overlay
  - Selected hunk gets a visible outline and auto-scrolls into view.
  - Help overlay also reachable via the new `⌨` button in the session header.
  - Inputs (chat textarea) keep their keys — handler skips when focus is in an input/textarea/contenteditable.

### Fixed

- **Per-line horizontal scrollbars in split view** (UI). The `.splitCell` element was set to `overflow-x: auto`, producing a scrollbar under every line in the BEFORE | AFTER columns. Changed to `overflow: hidden`; long lines now clip silently and a native `title` tooltip on hover reveals the full text. A larger restructure (one scrollbar per hunk, or a wrap toggle) is queued for v0.4+.

### Changed

- `FileReview.flags` and `HunkReview.flags` are new optional fields on the core review types. Forward-compatible with the v0.2.x event log (the orchestrator never persists flags — they're recomputed at `openReview` time).

### Tests

- 51 new tests (31 for risk-flag heuristics covering each pattern + non-false-positive cases; 20 for keyboard-navigation arithmetic covering same-file, file-boundary spill, last-file edge, flagged-only filter, null-start cases). Total 409 / 409 passing.

## [0.2.2] — 2026-05-21

A small patch that fixes a real-world dual-scope hook-config bug surfaced during E1 experiment work on 2026-05-21.

### Fixed
- **Dual-scope hook auto-resolve.** Previously, when both `~/.claude/settings.json` AND `<workspace>/.claude/settings.json` carried our marker entries (a state that can arise when multiple VS Code windows collide on the default port 53117 and fall back to dynamic ports), the extension warned but took no action. Claude Code's hook precedence (workspace > user) then routed hook fires to one extension instance while orphaning the other — a confusing state with no self-service fix.
  - On activation, the extension now auto-detects the dual-scope state and removes hooks from the inactive scope (the one that doesn't match `claudeReview.installScope`). Logged as `hooks.dual-scope.resolved`.
  - If removal fails (e.g., file locked), falls back to a warning toast with a `[Switch Install Scope]` action button — degrades to the v0.2.1 behaviour.
  - Handles both directions symmetrically: previously only the `installScope='user'` + stale workspace case was flagged. The `installScope='workspace'` + stale user case is now handled too.

### Added
- **`claudeReview.dualScope.allow` config** (undocumented power-user gate, default `false`). Set `true` to deliberately keep both scopes active (e.g., for multi-version testing). When enabled, the auto-resolve is skipped and a warning toast surfaces on activation so the user knows dual-scope mode is intentional.
- **`decideDualScopeAction` pure function** in `src/hookConfigurator.ts` — the decision logic is now unit-testable without VS Code mocks. 10 new unit tests cover the case matrix.

### Changed
- The legacy collision-warning toast at `extension.ts:340-348` is replaced by the new auto-resolve logic. Same end-user experience for users who'd previously dismissed the warning; better outcome for users who hadn't seen it.
- Migration prompt at `extension.ts:354-385` (v0.1→v0.2) now runs sequentially AFTER the dual-scope auto-resolve, so it sees the post-resolve world (no double-prompting).

## [0.2.1] — 2026-05-20

A small post-release polish patch driven by senior-product review of v0.2.0.

### Added
- **📜 History button in the review panel header.** The History panel is now discoverable from any active review session without the command palette. Backed by a new `open-history` webview-to-host message routed through `claudeReview.openHistory` so panel lifecycle stays single-sourced.

### Changed
- **Onboarding "Use claude /login" branch** now sets clearer expectations: "Run `claude /login` in any terminal. Once you have, click **Verify Now** — the extension reads `~/.claude/.credentials.json` automatically." A new Verify Now action re-probes the credential resolver and reports detection (with the source) or guides the user to the next option. Previously the message said "no further setup needed" which mis-set expectations if the user forgot to actually run `claude /login`.
- **README opens audience-first.** New paragraph after the value tagline anchors the user-state ("If you let Claude Code edit dozens of files…") so visitors immediately know if the tool fits their workflow.
- **README has a Roadmap section** linking to GitHub Issues — signals active development and clarifies what v0.3 / v1.0 will bring.
- **README "Known limitations"** updated: removed the stale "Sub-agent attribution planned for v1.1" claim (shipped in v0.2). Added "External terminals" entry to acknowledge the env-var inheritance limit + the burst-detector recovery path.
- **README "Privacy & security"** updated: bearer-token description now reflects keychain persistence + reuse across reloads (was "regenerated per activation" — outdated since the auth-token UX wave).

### Fixed
_None — no shipped bugs were identified in v0.2.0 post-release. A claimed P0 credential-probe bug was investigated and refuted: the credential resolver is lazy + per-call and already reads `~/.claude/.credentials.json` on first chat use._

## [0.2.0] — 2026-05-20

A substantial feature release. The headline additions are the **History panel** (every Claude session reviewable any time, with Resume / Rollback / Delete actions), **transcript-aware chat** (hunk chat cites your original prompt and Claude's surrounding tool calls), and **sub-agent attribution** (files edited inside a Task call are labelled with the sub-agent description). Major reliability work too: bearer token now persists across reloads, hooks self-heal stale legacy entries on activation, and a burst-detector toast surfaces actionable recovery on auth failures.

### Added

- **History panel** (M9.2 + β.0). Every past session reviewable any time: turn timelines, per-file decision counts, sub-agent labels. Open via `Claude Review: Open History Panel`.
- **Resume Review** (β.0 / 10.1.8). Reopen a session you closed mid-review — the panel reconstructs the prior state with all accept/reject decisions preserved, replaying the event log.
- **Rollback this turn** (β.0). Restores every file in a session to its pre-edit content, atomically per file. Modal confirm before destructive action.
- **Delete from history** (β.0). Permanently removes the event log + content-addressed blobs (cross-session blob sharing preserved). Modal confirm.
- **Pending status bar** (β.0 / 10.1.6). A second status-bar item — `↶ N pending` — surfaces the total unfinished-hunk count across recoverable sessions in the last 7 days. Click to open the panel.
- **`Open Review Panel` resume prompt** (β.0 / 10.1.7). When invoked with no live session but recoverable sessions on disk, shows a modal `Resume / Open History / Dismiss`.
- **Transcript-aware chat** (M9.5). `💬 Ask Claude` queries are augmented with the user's original prompt and Claude's surrounding tool calls, sourced from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Toggle with `claudeReview.chat.transcriptContext` (default on). Transcript content stays host-side; never crosses to the webview (covered by an integration test).
- **Sub-agent attribution** (M9.6). Files edited inside a `Task` tool invocation display a `via Task: <description>` chip in the review panel's file list, a tooltip on the hunk header, and a `· via Task: <description>` label in the history panel's turn cards.
- **Live-update History panel** (2026-05-19). Sessions started while the panel is open appear within ~300 ms; pending-count badges update in real-time. Backed by a `HistoryService.addChangeListener` channel with multi-listener support; the `PendingStatusBar` subscribes too.
- **Burst-detector toast** (2026-05-19). When ≥3 hook auth failures land in a 10s window, a warning toast surfaces `[Open New Terminal]`, `[Show Logs]`, `[Rotate Token]` action buttons for one-click recovery. Cooldown 60s after a fire to prevent toast spam.
- **`auth.failed` log entries** (2026-05-19). Server's 401 path now emits structured warn-level logs with length-only token signals (`hadHeader`, `headerLooksLikeBearer`, `suppliedLen`, `expectedLen`) plus a 13-char header prefix for diagnosing scheme mismatches without leaking enough bytes to brute-force.
- **`Rotate Bearer Token` command** improved (2026-05-19). Updates the env-var collection immediately and prompts `[Reload Window]` so the running server re-derives the expected token in one click.
- **Set-based reversibility** (M9.1). Reject pipeline replays the snapshot through an `acceptedSet` rather than re-running individual reverts, eliminating the fuzz-factor cliff on multi-hunk rejects. Session-level `Undo last action` operates over the same set.
- **Memory Design substrate** (M9.2). Content-addressed JSONL event log + SHA-256 blob store at `~/.claude/review-history/<workspaceHash>/`. Default 30-day retention via a sweeper that runs every 10 minutes. Cross-session blob sharing for storage efficiency.
- **User-scope hook install by default** (M9.3). `~/.claude/settings.json` is now the default install target so every workspace inherits the hook config. `Switch Install Scope` command toggles to workspace scope on demand.
- **Agent-adapter groundwork** (M9.4a). `AgentAdapter` interface extracted; Claude Code is the only adapter today, but the structure is ready for multi-agent. (OpenCode adapter deferred to a future release.)
- **Sub-agent transcript reader** (M9.5 + M9.6). Heap-bounded JSONL streaming via `readline`, ring-buffer windowing. Per-session cache with Promise coalescing so concurrent reads share one disk pass.
- **`claudeReview.openHistory`** + **`claudeReview.rotateBearerToken`** + **`claudeReview.showLog`** commands.

### Changed

- **Bearer token now persists across activations** via OS keychain (`vscode.SecretStorage`), replacing the per-activation rotation that broke every existing terminal on every reload. Explicit rotation remains available via `Claude Review: Rotate Bearer Token`.
- **`environmentVariableCollection.persistent = true`** so restored terminals across window reloads inherit the env var. With the stable token above, terminals from prior VS Code sessions stay aligned.
- **`reconstructSessionReview` is materially faster** — per-event blob reads batched via `Promise.all` (turn-started, turn-stopped, undo). Saves ~200-400 ms on Resume Review for typical 50-file sessions.
- **History panel session-list re-renders live** when new events arrive. Trailing-edge 300 ms debounce absorbs Claude's burst-write pattern (5–10 events in <50 ms during a turn).
- **`HistoryIndexFile.update()` is now serialized** via a per-instance promise-chain mutex; concurrent record* callers no longer clobber each other's mutations.
- **`HistoryWriter.append` rejects events exceeding 5 MB** up-front rather than producing oversized segments that violate the cap.
- **`.gitignore` injection now uses atomic write** (tmp + rename); concurrent edits from other tools don't race.
- **Path-traversal guard** in `readWorkspaceFile` + `joinCwd` — escapes are logged and rejected.
- **Single source of truth for `AgentId`** in `types.ts`; `historyEvents.ts` and `adapters/agentAdapter.ts` re-export.
- **System-prompt for hunk chat** updated to v2 (M9.5). When transcript context is present, the model is instructed to cite it specifically for "why did Claude do this?" questions.
- **Hook config installs are now self-healing**: legacy unmarked entries that point at our `127.0.0.1:<port>/(pre|post|stop)-tool-use` URL pattern are auto-stripped on each activation. Logged as `hooks.legacy.stripped` for auditability.

### Fixed

- **Bug B**: `openReview` no longer wipes prior hunk decisions when Claude continues editing in a resumed session. The `hunksAlignedShallow` preservation pattern from `reDiff` is now applied on every panel rebuild.
- **Bug C**: `adoptReconstructed` sets `currentTurnId: null` (was leaking the prior turn id), so the next PreToolUse mints a fresh turn id and produces clean per-turn event boundaries in the log.
- **Bug D**: `PanelGateway` methods accept `sessionId` explicitly; multi-panel routing no longer relies on the last-write-wins `globalByPath` heuristic that mis-routed events when two sessions touched the same file.
- **Bug E**: concurrent `extractSubagentId` calls coalesce via a Promise cache; the transcript is parsed once per session, not once per call.
- **Audit-integrity bugs in `record*` helpers**: `recordHunkDecisionEvent`, `recordSnapshotRevertEvent`, `recordTurnStoppedEvent`, `recordUndoEvent` now route through `currentTurnId ?? lastTurnId` so post-Stop emissions don't silently drop. `recordTurnStoppedEvent` is now awaited (not fire-and-forget).
- **`reDiff` runs through the per-file mutex** — the race between scheduled re-diff and in-flight hunk actions is closed.
- **Sub-agent cache lifetime** — cleared on `dismissSession` to bound memory.
- **Webview-side `init` re-emission** preserves the currently-loaded `SessionDetail` if its session still exists in the refreshed list.
- **Multi-panel routing in `postFileUpdated` / `postHunkApplied` / `postSetConflict`** — events route to the correct panel by sessionId, not by URL pattern match.

### Removed

- **`claudeReview.rotateTokenOnDeactivate` config key** — was unused after the stable-token migration; removing it eliminates a user-facing toggle that did nothing.
- **`claudeReview.history.crossTurnUndo` config key** — declared as a developer-mode flag but the runtime gate was never wired. Cross-turn undo remains future work; the flag will be re-added when implemented.
- **Unconditional activation toast** advising terminal restart — replaced by the burst-detector toast that fires only on actual auth failures (more accurate, never spurious).

### Security

- Bearer token persists in OS keychain (`vscode.SecretStorage`) only; never written to env files, never logged, never crossed to the webview.
- Transcript content is read host-side via `readTranscriptWindow` + `readTaskEntries`; never crosses to the webview. An integration test asserts the postMessage stream contains no transcript bytes.
- `auth.failed` log redacts to length signals + 13-char prefix only. Sufficient to distinguish scheme mismatches without leaking enough bytes to brute-force a 64-char hex token against a rate-limited localhost server.
- Hook URL pattern (`http://127.0.0.1:<port>/(pre|post|stop)-tool-use`) is the identity for the auto-cleanup of legacy unmarked entries. Documented in code; logged on every strip.
- Path-traversal guard in `readWorkspaceFile` is defence-in-depth — `relPath` is extension-controlled today.

### Performance

- Resume Review on a 50-file / ~5-decision-per-file session: ~200–400 ms faster after the `Promise.all` blob-read batching.
- `Stop → init` dispatch budget (50 files / 2000 changed lines): observed P99 ~643 ms vs the 4500 ms target. Well within budget; no regression vs 0.1.0.
- Live-update debounce: 300 ms trailing-edge. Coalesces Claude's burst writes into one re-post per turn rather than one per event.

### Tests

- **343 / 343 passing** (172 added since 0.1.0). New suites: `history.reconstruction.test.ts`, `history.actions.test.ts`, `history.liveUpdate.test.ts`, `orchestrator.adoptReconstructed.test.ts`, `orchestrator.undoAudit.test.ts`, `resume-and-continue.test.ts`, `subagent.test.ts`, `chat.transcript.test.ts`, `authFailureBurstDetector.test.ts`, `rotateBearerToken.test.ts`, plus extensions to `server.test.ts`, `hookConfigurator.test.ts`, `chatService.test.ts`, `memoryLeak.test.ts`, `perf.bench.test.ts`.

### Upgrade notes

- **First activation after upgrade** will reuse your existing bearer token (read from keychain). Hooks written by 0.1.0 are stripped + replaced by marked entries — you'll see `hooks.legacy.stripped` in the Output channel if any legacy entries existed.
- **Existing terminals** opened in a 0.1.0 session don't have the new env var. If a hook returns 401, click `[Open New Terminal]` in the burst-detector toast (or just open a fresh terminal manually). New terminals inherit the persistent token.
- **History opt-out:** event logging is on by default. Set `claudeReview.history.enabled: false` to disable; existing logs are not deleted.
- **Transcript context:** chat queries automatically include transcript context. Disable with `claudeReview.chat.transcriptContext: false` if you want hunk-only queries.

## [0.1.0] — 2026-05-11

Initial public release. Highlights:

- Per-hunk Accept / Reject / Ask Claude review of every Claude Code session.
- Claude Pro / Max OAuth auth (reads `~/.claude/.credentials.json`) **and** Anthropic API key support.
- Streaming chat about any hunk via the Anthropic SDK, with sanitised Markdown rendering.
- CodeLens gutter buttons, SCM panel integration, status bar pending-hunks indicator.
- Per-file mutex on action paths; FS-failure surfacing; bulk-reject fast path.
- Hardened webview: strict CSP with `connect-src 'none'`, ErrorBoundary, automatic JSX runtime.
- Perf bench median 363 ms / p99 461 ms for the 50-file Stop→panel critical path (TRD budget 1500 ms).
- 173 / 173 tests, license audit clean, CycloneDX SBOM attached.

### Added — M0 Scaffold
- Repo skeleton, package manifest, dual esbuild config, strict TS configs, ESLint with eval/dangerouslySetInnerHTML/unsafe-exec bans, Vitest harness, GitHub Actions matrix (mac/linux/win × node20), launch + tasks JSON, smoke tests.

### Added — M1 Hooks & Server
- `SecretManager` — bearer rotation per activation, regex-validated Anthropic API key, OS-keychain backed.
- `messages.ts` — Zod schemas for hook payloads and webview ↔ host discriminated union.
- `Logger` — JSON-line OutputChannel with depth-limited secret redactor.
- `hookConfigurator.ts` — atomic, marker-based, idempotent merge of `.claude/settings.json`. Refuses to overwrite malformed JSON.
- `server.ts` — Fastify on 127.0.0.1, constant-time bearer compare with equal-length-Buffer dummy, 10 MB body cap, 8 s handler timeout, dynamic port fallback, 200-payload fuzz green.
- `tools/mock-claude.ts` — CLI that replays a canonical hook sequence for development testing.

### Added — M2 Snapshot Store & Diff Engine
- `SnapshotStore` — per-(session,path) Promise-chain mutex, 50 MB / 200-file caps with `overBudget` flagging, path-traversal guard, `release()` for GC eligibility.
- `diffEngine.ts` — `structuredPatch(context: 3)`, `revertHunk` with `fuzzFactor: 2` retry, CRLF detection, NUL-byte binary detection. Round-trip property test (50 iterations) green.
- Wired into live hook handlers in `extension.ts`.

### Added — M3 Review Panel UI
- `ReviewOrchestrator` — session state machine (TRD §8.1), 250 ms Stop debounce, circuit breaker (5 reopens / 60 s), debounced re-diff on save (200 ms), `handleHunkAction` writes the reverted file via injected `writeFile` (so it stays unit-testable), `handleBulk` for file-level / session-level Accept/Reject, `dismissSession` releases the snapshot store.
- `ReviewPanelManager` — one `WebviewPanel` per session, CSP nonce regenerated per panel, `connect-src 'none'`, Zod-validated inbound messages, coalesced `postMessage` flush via `setImmediate` (TRD §15 backpressure rule).
- Full React webview app: Zustand store, `<SessionHeader>`, `<FileList>` (virtualised at >50 files via `react-virtuoso`), `<DiffPane>` with lazy file-expansion, `<HunkBlock>` with custom split/unified renderers and per-hunk Accept / Reject / Ask Claude buttons. Theme tokens via `var(--vscode-*)`.
- `StatusBarController` — sums pending hunk counts across all active sessions; click → focus the panel.
- `ClaudeReviewScmProvider` — file-level resource groups (Pending / Partial / Rejected / Accepted) with strikethrough/faded decorations.
- 14 new orchestrator tests (path-resolution-agnostic; works on win/linux/mac).

### Added — M8 GA Release readiness
- `package.json` marketplace polish: `qna: "marketplace"`, `pricing: "Free"`, `galleryBanner` (dark, `#1F2937`).
- `docs/RELEASE.md` — 12-step per-release runbook with hotfix path, yank procedure, common-failure table, and Day 0/1/3/7/14 post-launch monitoring checklist.
- `.github/workflows/release.yml` — tag-triggered CI release: tag↔version verification, full `release:check` gate, SBOM regeneration, VSIX packaging, parallel publish to VS Code Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`, optional), GitHub Release creation with VSIX + SBOM attached. Pre-release detection from tag suffix.
- GitHub repo hygiene: structured bug-report and feature-request issue templates (auth method, OS, version, output-channel paste), PR template with verification checklist, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1).
- `docs/METRICS.md` — telemetry event catalogue, three backend trade-offs (Application Insights / own endpoint / PostHog), KQL queries for all six PRD §3.2 KPIs, dashboard layout sketch, pre-GA emission checklist.
- README marketplace badges (version / installs / rating / license).

### Added — M7 Beta Release packaging
- VSIX builds at **3.28 MB** via `npm run package` (`vsce package`). All required manifest fields populated (`repository`, `bugs`, `homepage`).
- `src/onboarding.ts` — first-activation notification with four actions (Set OAuth / Set API key / Use claude /login / Dismiss). Skips silently if a credential resolves on first probe; persists "seen" in `globalState`.
- `README.md` rewritten as a self-contained marketplace listing: Highlights · Setup · Daily flow · Configuration · Commands · Troubleshooting (6 common issues) · Known limitations · Privacy.
- `scripts/auditLicenses.mjs` — walks the production dependency closure; allow-list of permissive licenses; **192 / 192 packages pass**. Composite expression handling (`A OR B`, `A AND B`).
- `scripts/generateSbom.mjs` — emits CycloneDX 1.5 JSON SBOM at `dist/sbom.cdx.json` (198 components, PURL identifiers, SHA-512 hashes from lockfile). Zero new npm deps.
- `docs/qa.md` — 14-section manual QA checklist for beta cycles.
- `package.json` dependency restructure: only `@anthropic-ai/sdk` (externalised) stays in `dependencies`; everything bundled by esbuild moved to `devDependencies`. Keeps VSIX node_modules lean.
- New npm scripts: `audit:licenses`, `audit:sbom`, `release:check`.

### Optimised — O(1) file lookup via denormalised indexes
- Added two private maps on `ReviewOrchestrator`: `byPath: Map<SessionId, Map<AbsPath, FileReview>>` for per-session lookup, `globalByPath: Map<AbsPath, ...>` for cross-session lookup. Both share references with `session.files`; maintained only on session open/dismiss. Replaces five `.find(f => f.filePath === absFile)` linear scans across `handleHunkAction`, `handleBulk`, `scheduleReDiff`, `ChatService.start`, and `CodeLensProvider`.
- New public `orchestrator.findFile(path)` for cross-session callers.
- CodeLens slow-path retained as a Win32 path-shape safety net only.
- Wire format unchanged — webview still receives the array.
- **Perf bench**: median 630 ms → **363 ms** (≈42% faster) at the 50-file × 2,000-changed-lines workload. p99 814 → 461. TRD §15 budget remains 1,500 ms.

### Hardened — Action-path correctness (per-file mutex, FS-failure surfacing, bulk-reject fast path)
- **Per-file Promise-chain mutex** on the orchestrator. `handleHunkAction`, `handleBulk`, and `revertFileToSnapshot` all acquire the lock for the file they touch. Same-file actions serialise (no more lost-write race when two clicks land in quick succession); different files run in parallel via `Promise.all` for bulk operations.
- **FS-failure surfacing.** `applyReject` distinguishes `fuzz` vs `fs` failures. New `FileWarning` kinds `write-failed` / `read-failed`. `<DiffPane>` renders a banner with a "Revert file to original snapshot" recovery button. On successful retry, the FS-failure warning is automatically cleared.
- **Bulk-reject fast path.** When `handleBulk('reject')` targets a file whose hunks are all still pending, it skips per-hunk reverse-patch (which can drift across hunks via context shift) and writes the captured `before` snapshot in a single `fs.writeFile`. Same end state, can't drift, fewer disk writes.
- **+8 integration tests** in `tests/integration/actionConcurrency.test.ts`: parallel rejects on the same file (5-way race), mixed accept+reject racing, cross-file parallelism, fast-path write count, FS-failure surfacing + retry, snapshot-revert FS failure, accept idempotency, no-op on already-decided hunks.

### Fixed — Panel stuck at "Waiting for Claude Code session…" after a re-open
- Host-side `PanelEntry` now carries a `webviewReady: boolean` flag. `scheduleFlush` is a no-op until the React tree signals `{type: 'ready'}`. Browser `MessageEvent`s don't queue, so posting `init` before the listener is registered silently dropped the message — first session sometimes won the race; subsequent Stop-hook re-inits frequently lost it. The `ready` handler now flips the flag and drains the buffer; webview re-mounts (e.g., moving the tab to a new editor group) re-fire `ready` and re-flush. `openOrFocus` on an existing panel also clears stale pending posts before queuing the new init.

### Fixed — Blank webview / "React is not defined"
- esbuild's webview build now sets `jsx: 'automatic'` + `jsxImportSource: 'react'` so JSX compiles to `react/jsx-runtime` imports rather than the classic `React.createElement(...)` form. Without this every JSX expression in the bundle threw at runtime with no React in scope, and the panel rendered blank.
- Added an `<ErrorBoundary>` around `<App>`, plus top-level `try/catch` and `window.onerror` / `unhandledrejection` listeners in `webview/index.tsx`. Any future render-time crash now shows a red error block inside the panel rather than going dark.
- esbuild banner now injects a minimal browser-safe `process` shim (`env`, `platform`, `cwd`) for unified / rehype-sanitize deps that read `process.env` during module evaluation.

### Fixed — Activation hitting VS Code's 10-second timeout
- Externalised `@anthropic-ai/sdk` from the extension bundle (esbuild `external: ['vscode', '@anthropic-ai/sdk']`). Bundle dropped from 1.3 MB → 879 KB. SDK is `require()`'d lazily by Node on first chat. `vsce package` pulls the SDK from `node_modules` into the VSIX so production installs still resolve it.
- `ensureHooksInstalled` is now fire-and-forget — the hook file only has to exist before the user next invokes `claude`, not before `activate()` returns. Saves ~2 s of file I/O off the critical path.

### Fixed — Logger crash during extension deactivation
- VS Code closes the OutputChannel's transport before disposables finish running, so `appendLine` could throw "Channel has been closed". The fallback path also called `appendLine`, re-throwing. Wrapped the fallback in a second try/catch that swallows.

### Fixed — 401 from Stop hook in dev-host terminal
- `extension.ts` activation now sets `context.environmentVariableCollection.replace('CLAUDE_REVIEW_TOKEN', bearerToken)` with `persistent: false`. Previously the bearer was generated and stored in SecretStorage but never made available to Claude Code's process environment, so Claude Code's `$CLAUDE_REVIEW_TOKEN` substitution resolved to empty and the loopback server returned 401 on every hook call. A one-time activation toast prompts the user to reopen any pre-existing terminal so the var takes effect.

### Changed — Default chat model: Sonnet 4.6 → Haiku 4.5
- `claudeReview.chatModel` default flipped from `claude-sonnet-4-6` to `claude-haiku-4-5-20251001`. Rationale: hunk-level chat is short, latency-sensitive, and frequent. Haiku 4.5 is the fastest/cheapest tier and well-suited to "should I accept this hunk?" Q&A. Users wanting deeper reviews override the setting to `claude-sonnet-4-6` or `claude-opus-4-7`.

### Added — M6 Polish & Hardening
- **`telemetry.ts`** — opt-in, double-gated (`claudeReview.telemetry === 'on'` AND `vscode.env.isTelemetryEnabled`), 10 s batched flush via an unref'd interval, deny-list PII scrubbing (`apiKey/token/filePath/cwd/message/content/...`), flat-only properties, 1,000-event buffer with backpressure. Wired into `extension.activated`, `review.opened`, `hunk.action`.
- **`ReviewOrchestrator.revertFileToSnapshot`** — catastrophic-failure escape hatch (TRD NFR-2.2): writes the captured original back to disk and rejects every pending hunk. Surfaced in `<DiffPane>` as a button inside the fuzz-fail banner. New webview-to-host message `revert-file-to-snapshot`.
- **External-edit detection** — `scheduleReDiff` now drops a stale `fuzz-failed-revert` warning when a re-diff succeeds, and tags `external-edit` so the diff pane renders a status banner.
- **Performance bench** (`tests/integration/perf.bench.test.ts`) — 50 files × 40-changed-lines, 5-trial median, logs result on every run. **median 630 ms / p99 814 ms** vs TRD §15 budget 1.5 s.
- **Memory leak test** (`tests/integration/memoryLeak.test.ts`) — 50 sessions sequential, warm-up + GC bracket. **ΔRSS ≈ 0 MB** vs 50 MB budget.

### Deferred (intentionally) for v1.1
- axe-core a11y in CI (heavy dep; manual a11y review for v1.0).
- `package.nls.json` locale externalisation (English only v1.0).

### Added — M5 SCM & CodeLens
- `HunkCodeLensProvider` — gutter Accept/Reject CodeLenses anchored at each hunk's post-edit line range; decided hunks render a single read-only badge. Lazy-registered on first session open; refresh driven by orchestrator's new `onChange` callback (not by per-cursor change events).
- New commands `claudeReview.acceptHunkAt` / `claudeReview.rejectHunkAt` route gutter clicks to the orchestrator (same path as panel buttons + "Ask Claude" quick actions).
- 9 new tests for the provider; mock VS Code API gained `EventEmitter`, `Range`, `Position`, `CodeLens`, `languages.registerCodeLensProvider` to support unit-testing without Electron.

### Added — Auth-error UI guidance
- Chat overlay renders an inline `AuthHelp` panel when the chat fails with `kind: 'auth'` or `kind: 'no-key'`. Panel surfaces both auth paths (Max OAuth vs API key), includes three command buttons (**Set OAuth token**, **Set API key**, **Probe & report auth source**), and references the `~/.claude/.credentials.json` and `CLAUDE_CODE_OAUTH_TOKEN` resolution sources.
- `WebviewToHost` schema gained `set-oauth-token` and `use-claude-code-auth` message kinds; routed through `reviewPanel.dispatch` to the existing host commands. No secrets cross the postMessage boundary.

### Added — Claude Pro / Max OAuth support
- `credentialResolver.ts` — five-source resolver: `CLAUDE_CODE_OAUTH_TOKEN` env → `CLAUDE_REVIEW_OAUTH_TOKEN` env → SecretStorage OAuth token → `~/.claude/.credentials.json` (tree-walked for any `sk-ant-oat01-…` shaped string, depth-bounded to 8) → SecretStorage API key. Returns `{ kind: 'oauth' | 'api', token, source }` so callers and telemetry can distinguish without ever logging the value.
- `SecretManager` gained `getOAuthToken / setOAuthToken / clearOAuthToken` with `sk-ant-oat01-…` regex validation.
- `AnthropicClient` now takes `resolveCredential()` instead of `getApiKey()`; on each call it routes the credential to `new Anthropic({ authToken })` (OAuth) or `new Anthropic({ apiKey })` (API key).
- New commands: **Claude Review: Set Claude OAuth Token (Max plan)**, **Clear Claude OAuth Token**, **Use Claude Code Auth (probe & report)** — the last reports which source the resolver found so you can verify Max-plan auth is in use without ever revealing the token.
- 18 new tests: resolution-order coverage, malformed-file recovery, depth-bounded extraction, OAuth/API routing through the SDK factory.

### Added — M4 Chat Subsystem
- `AnthropicClient` — wraps `@anthropic-ai/sdk` `messages.stream` with `AbortSignal`, async-iterator delta forwarding, per-call API key resolution (cleared in `finally`), versioned hunk-review system prompt (`HUNK_REVIEW_PROMPT_VERSION = 'v1'`), error classifier (auth / rate-limit / model-overload / network / cancelled / no-key / unknown), 4-chars/token heuristic, 20-message FIFO history trim.
- `ChatService` — owns conversation history per `(sessionId, filePath, hunkIndex)`, tracks `AbortController` per `chatId`, 16 ms `setTimeout`-coalesced delta forwarding (TRD §11 backpressure), `cancelSession` aborts every stream when the panel closes.
- Webview `ChatOverlay` — slide-in dialog scoped to one hunk, `react-markdown` + `rehype-sanitize` (no `dangerouslySetInnerHTML`), `crypto.randomUUID` chatIds with safe fallback, cancel on close, quick-action Accept/Reject, aria-live transcript, Enter-to-send.
- HunkBlock "💬 Ask" button now opens the overlay (was a placeholder `alert()`).
- Security assertion test: serialises every host→webview payload after a complete chat round-trip and asserts both the configured key and `sk-ant-api03-` are absent.

### Notes
- **HTTP framework deviation from TRD §5.2:** Fastify replaces `express` (~2× faster on small JSON payloads; same ergonomics).
- **UI deviation from TRD §10.2:** custom split/unified diff render replaces `react-diff-view` for v1.0 — keeps strict CSP simple, removes library version drift risk, `<HunkBlock>` is the swap point if we ever want to revisit.
- **Bundle size:** extension grew from 887 KB → 1.3 MB minified after pulling in `@anthropic-ai/sdk`. Still well under the 5 MB VSIX cap. Marking the SDK external is an option for M6 if perf bench flags activation cost.
- **Deferred:** performance bench fixture (M3.1.6) → still in M6.
- **Test count:** 119 tests across 11 files; typecheck clean; bundle 1.3 MB extension + 339 KB webview JS + 10.4 KB CSS.
