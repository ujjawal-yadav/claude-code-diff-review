# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: SemVer.

## [Unreleased]

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
