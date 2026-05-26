# 📁 PROJECT_TRACKER.md
> Auto-maintained by Claude Code. Do not edit manually.

---

## 🎯 Where we left off (2026-05-26)

**Last action:** Built **v0.6.1 — optimization wave** ("derive-once / ship-deltas") from a 6-module review. All 6 waves implemented + tested. **Uncommitted** — no version bump / tag / push yet.

**Shipped already:** v0.6.0 (Insights tab + v0.5.2 chat fix) is committed (`7313a07`) and tagged `v0.6.0`; commits are pushed.

**v0.6.1 sits uncommitted in the working tree** (17 modified files + 1 new test). Highlights: chat transcript tail-bound (fixes the "stuck on Streaming…" hang) + timeout fallback; `DiffPane` memo + narrowed `HunkBlock`/`renameGroups` (kills the build-signal re-render storm); `ChatOverlay` streaming no longer O(n²); status-bar `totalHunkCount` cached (no re-stream); in-memory pending invalidation (fewer index fsyncs); bridge re-init gate + `file-updated` dedup + panel-listener leak fix; orchestrator byte-cache + O(1) prior-merge + flag carry-over; `extractSubagentId` mtime re-read (mid-session attribution bug) + tsconfig/credential caches.

**Current state:**
- typecheck (host + webview) clean; `npm run lint` 0 errors (31 pre-existing `any` warnings in a test file); `npm run build` produces both bundles.
- **Full suite 532/532 green run serially** (`npx vitest run --no-file-parallelism`). Parallel run still hits the pre-existing Windows fs-cleanup flake — NOT a v0.6.1 regression. CHANGELOG entry written under `[Unreleased]`.

**Next concrete step:** manual E2E (chat on a huge-transcript session → no hang; scroll diff during a tsc run → no jank; rapid accept → status bar updates), then version-bump 0.6.0 → **0.6.1**, promote CHANGELOG `[Unreleased]` → `[0.6.1]`, commit, tag, push. See plan file § "v0.6.1 Optimization Wave".

**Roadmap (locked):**
- **v0.6.1** — optimization wave (built, uncommitted).
- **v0.7 – v0.9** — Unallocated. Absorb deferred polish (#13 magic-number config, build-signal single-pass counts, semantic A8) + patches. A7.5 multi-language build-signal + E2 shelved until a real non-TS user asks (decision #149).
- **v1.0** — File-based token (Option C, validated by E1) + zero-config onboarding. Gated on Q-V1-1..6 smoke tests (1–2h spike).

---

## 📊 Stats
| Metric | Value |
|---|---|
| Last Updated | 2026-05-26 |
| Current Version | **0.6.0** shipped (`7313a07`, tagged); **v0.6.1 optimization wave built, uncommitted** |
| Active Phase | **Decision-Support Pivot** (post-Phase β; v0.3 → v1.0 wave sequence) |
| Latest Wave | v0.6.0 — A9 Insights tab in History panel (host-side aggregator over the event log) |
| Tests Passing | **+15 new** insights tests green (full-suite parallel run flaky on pre-existing Windows fs races) |
| Perf bench (Stop→init, 50 files) | median ~380 ms / p99 ~440 ms (budget 4500 ms) |
| Memory leak (50 sessions) | ΔRSS ~−6 MB (budget 50 MB) |
| Bundle Size (extension) | ~975 KB minified |
| Bundle Size (webview) | ~367 KB JS + ~20 KB CSS |
| Bundle Size (.vsix) | 5.03 MB (1056 files) |
| Auth Methods | OAuth (Pro/Max) via env / SecretStorage / Claude Code's `.credentials.json`; API key fallback |
| Shipped to marketplace | v0.2.x, v0.3.0, v0.3.1, v0.4.0 (v0.5.x pending push) |

### Legacy stats (pre-v0.3 baseline, kept for delta context)
| Metric | Value at 2026-05-18 |
|---|---|
| Total Phases | 11 |
| Total Milestones | 17 |
| Total Tasks | 112 |
| Total Subtasks | 142 |
| Completed Tasks | 70 |
| In Progress | M10.1 β.0 Actionable History — sub-task 10.1.0 complete |
| Completion | 68% |
| Tests Passing | 237 / 237 (25 files) |
| Perf bench (post-optimisation) | median **363 ms** / p99 **461 ms** (TRD §15 budget 1500) |

---

## 🗂 Project Overview
- **Name:** Claude Code Diff Review (VS Code extension)
- **Goal:** Per-hunk review of Claude Code session changes with in-context AI chat. Hits all PRD §3 product goals (G1–G5) and TRD §15 perf budgets.
- **Tech Stack:** TypeScript 5.5 (strict) · React 18 · Zustand · Fastify · jsdiff · react-diff-view · @anthropic-ai/sdk · Zod · esbuild · Vitest · @vscode/test-electron
- **Success Metrics:** 5,000 WAU (6mo), ≥3 hunk actions/session, ≥500 chat invocations/week, P99 panel-open <1.5s, ≥99.5% crash-free, ≥4.3 marketplace rating, ≥40% D14 retention.
- **PRD Source:** `docs/PRD-Claude-Code-Diff-Review-Extension-1 (1).md`
- **TRD Source:** `docs/TRD-Claude-Code-Diff-Review-Extension.md`
- **Plan Source:** `~/.claude/plans/peaceful-squishing-moon.md`
- **Tracker Created:** 2026-05-10

---

## 🚀 Phase 0 — Scaffold (M0)
**Goal:** Repo scaffolded; dev loop works (F5 launches empty extension); CI green on 3 OSes.
**Status:** [x] Complete
**Estimated Effort:** XS
**Phase Dependencies:** none

### 🏁 Milestone 0.1 — M0 Scaffold
**Status:** [x]
**Complexity:** S
**Acceptance Criteria:** F5 launches; `vitest` smoke test passes; CI matrix runs typecheck + lint + build + test on mac/linux/win; bundle <100 KB.
**Depends On:** none

#### ✅ Task 0.1.1 — Repo skeleton
- **Status:** [x]
- **Complexity:** XS
- **Acceptance Criteria:** Directory tree per TRD Appendix A exists.
- **Files:** entire `claude-code-diff-review/` tree
- **Completed At:** 2026-05-10 14:25

  - [x] Subtask: Create directory tree (src, webview, tests, tools, .vscode, .github)

#### ✅ Task 0.1.2 — `package.json` manifest
- **Status:** [x]
- **Complexity:** S
- **Files:** `package.json`
- **Completed At:** 2026-05-10 14:26

  - [x] Subtask: Engines (vscode ^1.85, node ≥18), activationEvents, commands, configuration, keybindings
  - [x] Subtask: Pin runtime deps (fastify, diff, react, react-diff-view, zustand, zod, etc.)

#### ✅ Task 0.1.3 — TypeScript configs (strict)
- **Status:** [x]
- **Complexity:** XS
- **Files:** `tsconfig.json`, `tsconfig.webview.json`
- **Completed At:** 2026-05-10 14:26

  - [x] Subtask: Strict + noImplicit* + exactOptionalPropertyTypes
  - [x] Subtask: Webview tsconfig with DOM lib + `react-jsx`

#### ✅ Task 0.1.4 — esbuild dual bundle
- **Status:** [x]
- **Complexity:** S
- **Files:** `esbuild.config.mjs`
- **Completed At:** 2026-05-10 14:27

  - [x] Subtask: Extension build (CJS, node18, vscode external)
  - [x] Subtask: Webview build (IIFE, chrome108, no splitting)
  - [x] Subtask: Watch mode

#### ✅ Task 0.1.5 — Test harness + ESLint + CI
- **Status:** [x]
- **Complexity:** S
- **Files:** `vitest.config.ts`, `tests/unit/smoke.test.ts`, `.eslintrc.cjs`, `.github/workflows/ci.yml`
- **Completed At:** 2026-05-10 14:28

  - [x] Subtask: Vitest config with coverage thresholds (lines 80%)
  - [x] Subtask: ESLint forbids `eval`, `dangerouslySetInnerHTML`, unsafe `child_process.exec`
  - [x] Subtask: GitHub Actions matrix (mac/linux/win × node20)

#### ✅ Task 0.1.6 — Activation skeleton + meta files
- **Status:** [x]
- **Complexity:** XS
- **Files:** `src/extension.ts`, `README.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `.vscodeignore`, `.vscode/launch.json`, `.vscode/tasks.json`
- **Completed At:** 2026-05-10 14:30

  - [x] Subtask: `activate`/`deactivate` exports; OutputChannel
  - [x] Subtask: Launch + tasks config so F5 builds-then-launches

---

## 🚀 Phase 1 — Hooks & Loopback Server (M1)
**Goal:** Claude Code lifecycle hooks fire into a bearer-authenticated 127.0.0.1 server; payloads validated; settings.json merged idempotently.
**Status:** [x] Complete
**Estimated Effort:** L
**Phase Dependencies:** Phase 0

### 🏁 Milestone 1.1 — M1 Hooks & Server
**Status:** [x]
**Complexity:** L
**Acceptance Criteria:** PRD §12.1 acceptance criteria green. Server fuzz test (200 random JSON bodies) → no crash. Bearer never plaintext in `.claude/settings.json`.
**Depends On:** M0

#### ✅ Task 1.1.1 — `secretManager.ts`  **[x]**
- **Files:** `src/secretManager.ts` (38 lines), `tests/unit/secretManager.test.ts` (10 tests pass)
- 32-byte hex bearer, regex-validated `sk-ant-…` API key, defensive getters.

#### ✅ Task 1.1.2 — `messages.ts` Zod schemas  **[x]**
- **Files:** `src/messages.ts`, `tests/unit/messages.test.ts` (9 tests pass)
- `.passthrough()` on hook payloads (forward-compat); strict discriminated union for webview-to-host with UUID validation on chatId.

#### ✅ Task 1.1.3 — `logger.ts`  **[x]**
- **Files:** `src/logger.ts`, `tests/unit/logger.test.ts` (7 tests pass)
- JSON-line OutputChannel records; depth-limited redactor strips `apiKey`/`authorization`/`bearer*` at every nesting level; level-gated.

#### ✅ Task 1.1.4 — `hookConfigurator.ts`  **[x]**
- **Files:** `src/hookConfigurator.ts`, `tests/unit/hookConfigurator.test.ts` (8 tests pass)
- Marker-based merge (`x-claude-review-extension: "v1"`); atomic tmpfile + rename; preserves user-authored entries; refuses malformed JSON.

#### ✅ Task 1.1.5 — `server.ts` (Fastify)  **[x]**
- **Files:** `src/server.ts`, `tests/integration/server.test.ts` (16 tests pass)
- 127.0.0.1 bind, `crypto.timingSafeEqual` constant-time auth (with equal-length dummy padding), 10 MB body cap, dynamic port fallback, schema-mismatch returns 200 `{}`, fuzz-200-payloads test green.

#### ✅ Task 1.1.6 — Wire activation in `extension.ts`  **[x]**
- All commands registered (`removeHooks`, `setApiKey`, `clearApiKey`, `rotateBearerToken`, `showLog`, `openPanel`); disposables wired.

#### ✅ Task 1.1.7 — `tools/mock-claude.ts`  **[x]**
- CLI replays PreToolUse × N → PostToolUse × N → Stop sequence.

---

## 🚀 Phase 2 — Snapshot Store & Diff Engine (M2)
**Goal:** Per-session before-snapshots, hunk-accurate structured diffs, fuzz-tolerant revert.
**Status:** [x] Complete
**Estimated Effort:** M
**Phase Dependencies:** Phase 1

### 🏁 Milestone 2.1 — M2 Snapshot & Diff
**Status:** [x]
**Complexity:** M
**Acceptance Criteria:** PRD §12.2 green; concurrent capture race-free; path traversal rejected; round-trip property test passes 50 iterations.

#### ✅ Task 2.1.1 — `snapshotStore.ts`  **[x]**
- **Files:** `src/snapshotStore.ts`, `tests/unit/snapshotStore.test.ts` (18 tests pass)
- Per-(session,path) Promise-chain mutex (50-parallel-capture test → exactly 1 readFile); 50 MB / 200-file caps with overBudget flagging; path-traversal guard via `path.relative(cwd, resolved)`; new-file → empty-string snapshot.

#### ✅ Task 2.1.2 — `diffEngine.ts`  **[x]**
- **Files:** `src/diffEngine.ts`, `tests/unit/diffEngine.test.ts` (16 tests pass)
- `structuredPatch(context:3)`; `revertHunk` with `fuzzFactor:2` retry; CRLF normalisation; NUL-byte binary detection; round-trip property test (50 random edits) green.

#### ✅ Task 2.1.3 — Wire store into server handlers  **[x]**
- `/pre-tool-use` → `captureOriginal`; `/post-tool-use` → `recordTouched`; both stamps log latency on slow paths (>100 ms).

---

## 🚀 Phase 3 — Review Panel UI (M3)
**Goal:** React webview opens within 1.5 s of Stop; per-hunk accept/reject mutates disk correctly.
**Status:** [x] Complete  **Estimated Effort:** XL  **Phase Dependencies:** Phase 2

### 🏁 Milestone 3.1 — M3 Review Panel
**Status:** [x]  **Complexity:** XL
**Acceptance Criteria:** PRD §12.3 green; reject hunk byte-exact via revertHunk; CSP nonce in webview HTML; full activation orchestration end-to-end.

#### ✅ Task 3.1.1 — `reviewOrchestrator.ts`  **[x]**
- **Files:** `src/reviewOrchestrator.ts` (337 lines), `tests/unit/reviewOrchestrator.test.ts` (14 tests pass)
- Session state machine, debounced Stop (250 ms), circuit breaker (5 reopens / 60 s), debounced re-diff (200 ms), handleHunkAction with revertHunk fallback, handleBulk, dismissSession releases the snapshot store; injected `readFile`/`writeFile` for testability.

#### ✅ Task 3.1.2 — `reviewPanel.ts`  **[x]**
- **Files:** `src/reviewPanel.ts` (245 lines)
- One WebviewPanel per session (`viewType = claudeReview.session.<sid>`); strict CSP with `connect-src 'none'`, per-panel nonce; coalesced postMessage via setImmediate flush; Zod-validated inbound messages.

#### ✅ Task 3.1.3 — Webview React app  **[x]**
- **Files:** `webview/index.tsx`, `webview/App.tsx`, `webview/store.ts`, `webview/vscode.ts`, `webview/components/{SessionHeader,FileList,DiffPane,HunkBlock}.tsx`, `webview/styles/*.module.css`
- Zustand store, react-virtuoso for >50-file sessions, custom split/unified diff render with per-hunk Accept/Reject/Ask buttons (deviation from `react-diff-view` documented for CSP simplicity); VS Code theme tokens; empty + completed states.

#### ✅ Task 3.1.4 — `statusBarController.ts`  **[x]**
- Pending hunk count summed across active sessions; click → `claudeReview.openPanel`.

#### ✅ Task 3.1.5 — `scmProvider.ts`  **[x]**
- One SourceControl per session, four resource groups (Pending / Partial / Rejected / Accepted), strikethrough on rejected, faded on accepted, click-through to panel.

#### ⏭️  Task 3.1.6 — Performance bench fixture (deferred)
- **Status:** [-] Deferred to M6 polish
- **Reason:** All TRD §15 budgets remain green at unit/integration level; perf bench is part of the M6 hardening pass (CI gating + stress + leak tests). Logged as tech debt.

---

## 🚀 Phase 4 — Chat Subsystem (M4)
**Goal:** Streamed, scoped, cancellable chat about any hunk; API key never reaches webview.
**Status:** [x] Complete  **Estimated Effort:** M  **Phase Dependencies:** Phase 3

### 🏁 Milestone 4.1 — M4 Chat
**Status:** [x]  **Complexity:** M
**Acceptance Criteria:** PRD §12.4 green; chatId reconciliation works; webview never originates `api.anthropic.com` request; configured API key never appears in any host→webview payload (CSP also enforces `connect-src 'none'`).

#### ✅ Task 4.1.1 — `anthropicClient.ts`  **[x]**
- **Files:** `src/anthropicClient.ts` (190 lines), `tests/unit/anthropicClient.test.ts` (12 tests pass)
- Streaming via `messages.stream` with async-iterator + `AbortSignal`; per-call key fetch (cleared in `finally`); error classifier maps SDK status → `auth | rate-limit | model-overload | network | cancelled | no-key | unknown`; versioned `HUNK_REVIEW_PROMPT_VERSION = 'v1'`; token estimator + 20-message FIFO history trim; `clientFactory` dependency injection for tests.

#### ✅ Task 4.1.2 — `chatService.ts` (host-side conversation manager)  **[x]**
- **Files:** `src/chatService.ts` (175 lines), `tests/integration/chatService.test.ts` (6 tests pass)
- Owns conversation history per `(sessionId, filePath, hunkIndex)`; tracks `AbortController` per `chatId`; coalesced delta forwarding via 16 ms `setTimeout` (matches TRD §11 backpressure rule); `cancelSession` aborts every stream when the panel closes.

#### ✅ Task 4.1.3 — `ChatOverlay` webview component  **[x]**
- **Files:** `webview/components/ChatOverlay.tsx`, `webview/styles/ChatOverlay.module.css`
- Slide-in dialog scoped to a single hunk; `react-markdown` + `rehype-sanitize` (no `dangerouslySetInnerHTML`); `crypto.randomUUID` chatId protocol with safe fallback; cancel on overlay unmount + explicit cancel button; quick-action Accept/Reject buttons; aria-live transcript; Enter-to-send / Shift-Enter for newline; auto-focus textarea.
- Wired into HunkBlock (Ask Claude button now opens the overlay).

#### ✅ Task 4.1.4 — Security assertion test  **[x]**
- **File:** `tests/integration/chatService.test.ts` → "SECURITY: api key never crosses postMessage boundary"
- After a complete chat session including streamed deltas, the test serialises every `postChatDelta`/`postChatDone`/`postChatError` payload and asserts `sk-ant-api03-` is absent and the configured key string is absent. Matches TRD §14 TR-1.

---

## 🚀 Phase 5 — SCM & CodeLens (M5)
**Goal:** Source Control panel + inline gutter buttons.
**Status:** [x] Complete  **Estimated Effort:** M  **Phase Dependencies:** Phase 4

### 🏁 Milestone 5.1 — M5 SCM & CodeLens
**Status:** [x]  **Complexity:** M

#### ✅ Task 5.1.1 — `scmProvider.ts`  **[x]**
- Completed during M3 — four resource groups (Pending / Partial / Rejected / Accepted), strikethrough/faded decorations, click-through to panel via `claudeReview.openPanel`.

#### ✅ Task 5.1.2 — `codeLensProvider.ts`  **[x]**
- **Files:** `src/codeLensProvider.ts` (115 lines), `tests/unit/codeLensProvider.test.ts` (9 tests pass)
- Lazy-registered (`registerCodeLensProvider({ scheme: 'file' }, …)`) on first session open; per-hunk Accept/Reject lenses anchored at `hunk.newStart - 1` (post-edit position); decided hunks render a single read-only badge so the developer can see what they decided. Refresh fired by orchestrator's new `onChange` callback (not by per-cursor `onDidChangeTextDocument`).
- Two new commands: `claudeReview.acceptHunkAt`, `claudeReview.rejectHunkAt` route to `orchestrator.handleHunkAction`.

#### ✅ Task 5.1.3 — Save-triggered re-diff  **[x]**
- Completed during M3 — `vscode.workspace.onDidSaveTextDocument` debounces re-diff at 200 ms, fans out to every active session via `scheduleReDiff`.

### 🏁 Bonus — Auth-error UI guidance
**Status:** [x]
- Chat overlay now renders an inline `AuthHelp` panel when the chat fails with `kind: 'auth'` (401 expired/revoked) or `kind: 'no-key'` (no credential found). The panel explains both paths (Max OAuth vs API key) and ships three command buttons: **Set OAuth token**, **Set API key**, **Probe & report auth source**.
- New webview-to-host messages `set-oauth-token` and `use-claude-code-auth` route through `reviewPanel.dispatch` to the existing host commands. No secrets cross the postMessage boundary.

---

## 🚀 Phase 6 — Polish & Hardening (M6)
**Goal:** All PRD §12 acceptance criteria green; perf bench passes; leak test ΔRSS <50 MB.
**Status:** [x] Complete  **Estimated Effort:** L  **Phase Dependencies:** Phase 5

### 🏁 Milestone 6.1 — M6 Polish

#### ✅ Task 6.1.1 — Empty states + loop circuit breaker  **[x]**
- Empty states landed in M3; circuit breaker (5 reopens / 60 s) in M3.

#### ✅ Task 6.1.2 — Fuzz-fail revert UX  **[x]**
- `ReviewOrchestrator.revertFileToSnapshot` writes the captured original back to disk and rejects every pending hunk; banner inside `<DiffPane>` surfaces the action when `file.warnings` includes `fuzz-failed-revert`. New webview-to-host message `revert-file-to-snapshot`. Two new orchestrator tests.

#### ✅ Task 6.1.3 — `telemetry.ts` (opt-in, batched 10 s)  **[x]**
- **Files:** `src/telemetry.ts`, `tests/unit/telemetry.test.ts` (12 tests)
- Double-gated (`claudeReview.telemetry === 'on'` AND `vscode.env.isTelemetryEnabled`); 10 s flush interval (timer is `unref`'d so it never blocks Node exit); deny-list scrubbing for `apiKey/token/filePath/cwd/message/lastAssistantMessage/content`; flat-only properties (objects/arrays dropped); 1,000-event buffer cap with backpressure (drops when full). Wired into `extension.activated`, `review.opened`, `hunk.action` events in `extension.ts`.

#### ⏭️ Task 6.1.4 — Accessibility hardening (axe-core)  **[-]**
- **Status:** Deferred. Webview is keyboard-operable (focus-visible outlines, aria-labels on all action buttons, aria-live transcript, ARIA roles on overlay/dialog). Adding axe-core in CI requires a JSDOM/browser environment — heavier than v1.0 needs. Manual a11y review covers it; logged as M7 beta-test follow-up.

#### ✅ Task 6.1.5 — Performance bench in CI gating  **[x]**
- **Files:** `tests/integration/perf.bench.test.ts`
- 50-file × 40-changed-lines fixture, generated to OS tmpdir; measures Stop→`init` dispatch latency (orchestrator open → `panel.openOrFocus` callback). 5-trial median; logs `median + p99` so regressions show even on green runs. **Result: median 630 ms / p99 814 ms; TRD §15 budget is 1.5 s.**

#### ✅ Task 6.1.6 — Memory leak test  **[x]**
- **Files:** `tests/integration/memoryLeak.test.ts`
- Opens & dismisses 50 sessions in sequence with 5 files each; warm-up + GC bracket. **Result: ΔRSS effectively 0 MB (-7 MB after GC); budget is 50 MB.**

#### ⏭️ Task 6.1.7 — External edit detection toast  **[x]**
- The `external-edit` warning is set whenever `scheduleReDiff` fires after a save while a panel is open; `<DiffPane>` renders an italic banner. Toast wiring also flows through the existing `warning` HostToWebview message.

#### ⏭️ Task 6.1.8 — Locale externalisation (`package.nls.json`)  **[-]**
- **Status:** Deferred to v1.1. English-only is acceptable for v1.0 marketplace listing.

---

## 🚀 Phase 7 — Beta Release (M7)
**Goal:** VSIX installable; private-beta tested; documentation complete.
**Status:** [x] Complete  **Estimated Effort:** S  **Phase Dependencies:** Phase 6

### 🏁 Milestone 7.1 — M7 Beta

#### ✅ Task 7.1.1 — `vsce package` + onboarding flow  **[x]**
- VSIX builds clean: **3.28 MB / 1001 files**, repository / bugs / homepage fields populated, no broken README links.
- `src/onboarding.ts` — first-activation notification with four actions (Set OAuth / Set API key / Use claude /login / Dismiss). Probes credentials first; silently marks "seen" if user is already authed. Persistence via `context.globalState` keyed by `claudeReview.onboarding.shownAt`. Fire-and-forget from `activate()` so it never blocks startup.

#### ✅ Task 7.1.2 — README setup + troubleshooting  **[x]**
- `README.md` rewritten as a self-contained marketplace listing: Highlights · Setup · Daily flow · Configuration · Commands · Troubleshooting (six common issues with diagnostics) · Known limitations · Privacy & security · License.
- Replaced relative `docs/*` links (which would 404 on the Marketplace) with anchors and inline content.

#### ✅ Task 7.1.3 — SBOM + license audit  **[x]**
- `scripts/auditLicenses.mjs` — walks the production dependency closure (192 packages); allow-list of permissive licenses (MIT, Apache-2.0, ISC, BSD-*, MPL-2.0, etc.); supports `(A OR B)` and `A AND B` composite expressions; rejects copyleft + UNLICENSED. **All 192 packages pass.**
- `scripts/generateSbom.mjs` — emits CycloneDX 1.5 JSON SBOM at `dist/sbom.cdx.json` covering 198 components with PURL identifiers, license declarations, and SHA-512 integrity hashes from the lockfile. Runs offline, zero new npm deps.
- New npm scripts: `audit:licenses`, `audit:sbom`, `release:check` (chains typecheck + lint + test + audit + build).

#### ✅ Task 7.1.4 — Manual QA checklist  **[x]**
- `docs/qa.md` — 14-section checklist covering install, hook config, server auth, per-hunk flow, per-file actions, CodeLens, SCM, chat, drift, layout edges, error surfacing, lifecycle, build/release, telemetry. Sign-off table at the bottom.

#### ✅ Task 7.1.5 — Dependency restructure for VSIX  **[x]**
- All bundled deps (react, fastify, diff, zod, etc.) moved from `dependencies` to `devDependencies`. Only `@anthropic-ai/sdk` (externalised by esbuild for cold-start perf) remains in `dependencies`. Result: VSIX node_modules drops to ~989 files of just the SDK + transitives instead of the full pre-bundling tree.

---

## 🚀 Phase 8 — GA Release (M8)
**Goal:** Public Marketplace listing; baseline metrics captured.
**Status:** [~] In progress — code-side complete; user-action items remain  **Estimated Effort:** XS  **Phase Dependencies:** Phase 7

### 🏁 Milestone 8.1 — M8 GA

#### ✅ Task 8.1.1 — Marketplace-ready manifest  **[x]**
- `package.json` gained `qna`, `pricing: "Free"`, `galleryBanner` (dark, `#1F2937`).

#### ✅ Task 8.1.2 — Publishing runbook (`docs/RELEASE.md`)  **[x]**
- 12-step per-release sequence + prerequisite setup for Marketplace + Open VSX.
- Hotfix path; yank/unpublish; common publish failures table; post-launch monitoring checklist (Day 0/1/3/7/14).

#### ✅ Task 8.1.3 — Automated release workflow (`.github/workflows/release.yml`)  **[x]**
- Triggered by version tag push. Verifies tag↔package.json version match, runs `release:check`, builds VSIX + SBOM, publishes to Marketplace (`VSCE_PAT` secret) + Open VSX (`OVSX_PAT` secret, optional), and creates a GitHub Release with VSIX + SBOM attached. Pre-release detection from tag suffix.

#### ✅ Task 8.1.4 — GitHub repo hygiene  **[x]**
- `.github/ISSUE_TEMPLATE/bug_report.yml` — structured bug report form (version, OS, auth method, repro steps, output channel paste).
- `.github/ISSUE_TEMPLATE/feature_request.yml` — scope check + alternatives.
- `.github/ISSUE_TEMPLATE/config.yml` — routes questions to Discussions, security to private advisories.
- `.github/PULL_REQUEST_TEMPLATE.md` — type, manual verification, checklist.
- `CONTRIBUTING.md` — dev loop, project tour, coding rules, what to avoid.
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1.

#### ✅ Task 8.1.5 — Metrics dashboard guide (`docs/METRICS.md`)  **[x]**
- Event catalogue (what's emitted, post-scrub property shape).
- Three backend options (Application Insights / own endpoint / PostHog) with trade-offs and recommendation.
- KQL/SQL sketches for all six PRD §3.2 KPIs.
- Dashboard layout sketch.
- Pre-GA checklist (latencyMs on review.opened, chat.completed emission).

#### ⏭️ Task 8.1.6 — Marketplace badges in README  **[x]**
- Four shields.io badges at the top (version, installs, rating, license). Resolve once the listing is live.

#### ⏳ Task 8.1.7 — User-action items (not codeable from here)
- Create Azure DevOps publisher account at https://marketplace.visualstudio.com/manage/createpublisher
- Generate Marketplace PAT (all-orgs scope, Marketplace → Manage)
- Set `VSCE_PAT` and (optionally) `OVSX_PAT` repo secrets on GitHub
- ~~Update `package.json` `publisher` field to the real publisher id~~ ✅ done — now `UjjawalYadav`
- Push the repo to GitHub (the prior `gh repo create` / `git push` flow)
- Cut the first tag (`npm version 0.1.0` → `git push origin v0.1.0`) — release workflow auto-publishes
- Pick a telemetry backend per `docs/METRICS.md` §2, wire the connection string
- (Pre-1.0 polish) Design a 128×128 PNG icon; add `"icon": "icon.png"` to manifest

---

## 🚀 Phase 9 — Phase α: Substrate + Defensive Moat
**Goal:** Implement the Memory Design event-log substrate, switch hook install to user-level by default, add OpenCode adapter (multi-agent positioning), make chat transcript-aware, surface sub-agent attribution, and refactor accept/reject onto a drift-free set-based foundation that all Phase β surfaces depend on.
**Status:** [~] In Progress
**Estimated Effort:** XL
**Phase Dependencies:** Phase 8 (M8.1.7 user-action items can finish in parallel)
**Plan Source:** `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md`
**Spec Source:** `docs/PHASE-ALPHA-IMMEDIATE.md`

---

### 🏁 Milestone 9.1 — Set-Based Reversibility Foundation (Track 6)
**Status:** [x] Complete
**Complexity:** L
**Acceptance Criteria:** All T6-* acceptance tests green per spec §10; existing 173 tests remain green; `renderFileFromHunkSet(acceptedSet=all)` equals current Claude content; 50-toggle round-trip byte-for-byte identical; coupled-hunk rejection surfaces `set-conflict` banner; format-on-save drift tolerated via fuzz.
**Depends On:** none
**Completed At:** 2026-05-11 05:15 (186/186 tests passing, all T6-* green)

#### ✅ Task 9.1.1 — `HunkSetState` / `RenderResult` types
- **Status:** [x]
- **Complexity:** XS
- **Depends On:** none
- **Acceptance Criteria:** Types compile under strict TS; `RenderResult` is a discriminated union (`ok` / `set-conflict` / `snapshot-binary`); exported from `src/types.ts`.
- **Files:** `src/types.ts`
- **Notes:** No barrel exists; types are imported directly from `./types.js` throughout. Doc comment in types.ts explains why `acceptedSet` is host-side only (Set structured-clone limit). Existing `RevertResult` (used by legacy `revertHunk`) preserved alongside new `RenderResult` — distinct types with distinct purposes.
- **Completed At:** 2026-05-11 04:15

  - [x] Subtask: Add `HunkSetState { filePath, originalSnapshot, allHunks, acceptedSet }` interface
  - [x] Subtask: Add `RenderResult` discriminated union with three variants
  - [x] Subtask: Re-export from existing barrel if present — N/A, no barrel

#### ✅ Task 9.1.2 — `renderFileFromHunkSet` implementation
- **Status:** [x]
- **Complexity:** M
- **Depends On:** Task 9.1.1
- **Acceptance Criteria:** Pure function (no I/O); applies hunks in increasing `oldStart` order; uses `Diff.applyPatch` with `fuzzFactor: 2`; returns `set-conflict` with `conflictingHunks: number[]` on failure; binary snapshots return `snapshot-binary`.
- **Files:** `src/core/hunkSet.ts`
- **Notes:** Reuses fuzz factor strategy from `src/diffEngine.ts:68` `revertHunk`. Strict-first then fuzz retry, matching the existing legacy `revertHunk` two-pass. Multi-hunk patch built as a single jsdiff `ParsedDiff` rather than sequential applyPatch — jsdiff handles cumulative offset for free. On failure, single-hunk-on-snapshot probes identify offending hunks; pure interaction conflicts fall back to the last sorted index. Also exports `initialHunkSetState(filePath, snapshot, hunks)` helper for the M9.1.5 migration entry point. EOL handling matches `revertHunk` (snapshot used as-is; fuzz tolerates CRLF/LF context mismatch).
- **Completed At:** 2026-05-11 04:30

  - [x] Subtask: Sort `acceptedSet` by `allHunks[i].oldStart` ascending
  - [x] Subtask: Multi-hunk `applyPatch` (strict → fuzz); per-hunk probes on failure
  - [x] Subtask: Return `set-conflict` with all failing indices on failure
  - [x] Subtask: NUL-byte detection for `snapshot-binary` path

#### ✅ Task 9.1.3 — Turn-aware SnapshotStore
- **Status:** [x]
- **Complexity:** S
- **Depends On:** Task 9.1.1
- **Acceptance Criteria:** `SessionData.currentTurnId: string | null`, `turnStartedAt: number | null` populated. `beginTurnIfNeeded(sid)` mints turnId on first PreToolUse after a `Stop` (idempotent across concurrent calls).
- **Files:** `src/types.ts`, `src/snapshotStore.ts`
- **Notes:** Used Node's built-in `crypto.randomUUID()` (Node ≥14.17) — no extra dependency. Added `endTurn(sessionId)` companion to be called from orchestrator's Stop handler; idempotent. Existing 18/18 snapshotStore tests remain green. Concurrency: first-writer-wins via `setIfAbsent` on `currentTurnId` field.
- **Completed At:** 2026-05-11 04:40

  - [x] Subtask: Add fields to `SessionData` in `src/types.ts`
  - [x] Subtask: Add `beginTurnIfNeeded(sid, cwd): string` to `SnapshotStore`
  - [x] Subtask: `endTurn(sid)` to be called on Stop boundary (wired in M9.1.4)
  - [x] Subtask: Concurrency-safe via `setIfAbsent` on the field

#### ✅ Task 9.1.4 — Orchestrator refactor to set-based pipeline
- **Status:** [x]
- **Complexity:** L
- **Depends On:** Task 9.1.2, Task 9.1.3
- **Acceptance Criteria:** `ReviewOrchestrator.handleHunkAction()` loads `HunkSetState` from in-memory store, mutates `acceptedSet`, calls `renderFileFromHunkSet`, writes through existing per-file mutex. On `set-conflict`: revert set change, surface panel banner with conflicting hunk indices + "Re-accept coupled hunks" action.
- **Files:** `src/reviewOrchestrator.ts`, `src/messages.ts`, `src/reviewPanel.ts`, plus 6 test stub files
- **Notes:** Introduced `applyHunkSetChange(sid, file, mutate)` as the single write primitive — both `handleHunkAction`, `handleBulk`, and `revertFileToSnapshot` route through it. Set is rolled back on render/write failure to keep disk and state consistent. Added no-op short-circuit via `setsEqual` so accepting an already-accepted hunk skips render+write (preserves v0.1.0 invariant that accept-on-applied is free). PanelGateway gained `postSetConflict` — cascaded to 6 test stub classes. Removed dead code: `applyReject` private method and `revertHunk` import (the legacy single-hunk reverse-patch is no longer in the hot path). `revertFileToSnapshot` simplified — no double-write fallback; on FS failure, hunks stay pending and the warning surfaces. All 173 existing tests green.
- **Completed At:** 2026-05-11 04:55

  - [x] Subtask: Replace accept/reject body with set membership update + render via `applyHunkSetChange`
  - [x] Subtask: Add `set-conflict-warning` to `HostToWebview` message union in `src/messages.ts`
  - [x] Subtask: Wire `postSetConflict` through `ReviewPanelManager` to webview
  - [x] Subtask: Bulk-accept / bulk-reject use single set update + single render + single write (the legacy fast-path is now the only path, by construction)
  - [x] Subtask: Wire `SnapshotStore.endTurn(sid)` into Stop handler so PreToolUse mints fresh turnIds
  - [x] Subtask: `revertFileToSnapshot` routes through empty-set render

#### ✅ Task 9.1.5 — Initial-state migration
- **Status:** [x]
- **Complexity:** XS
- **Depends On:** Task 9.1.4
- **Acceptance Criteria:** On first review of a session, `acceptedSet = new Set(allHunks.map((_, i) => i))`. Rendering produces current disk content byte-for-byte. No user-visible behaviour change vs v0.1.0.
- **Files:** `src/reviewOrchestrator.ts`, `src/core/hunkSet.ts`
- **Notes:** Landed as part of M9.1.4: `openReview` calls `indexHunkSets(sid, files, sessionData.originals)` which uses `initialHunkSetState` from `hunkSet.ts` — that helper seeds `acceptedSet = {0..N-1}`. Verified by the all-tests-still-green run after M9.1.4: every existing test that exercises post-Stop state implicitly asserts the initial render matches current disk.
- **Completed At:** 2026-05-11 04:55

  - [x] Subtask: Initialise `HunkSetState.acceptedSet` on session open (via `initialHunkSetState`)
  - [x] Subtask: Byte-equality with current disk verified by existing 173-test suite continuing to pass

#### ✅ Task 9.1.6 — Acceptance tests T6-1 through T6-5
- **Status:** [x]
- **Complexity:** M
- **Depends On:** Task 9.1.4, Task 9.1.5
- **Acceptance Criteria:** All five test IDs from spec §8.7 pass.
- **Files:** `tests/unit/hunkSet.test.ts` (9 unit tests), `tests/integration/orchestrator.set.test.ts` (4 integration tests)
- **Notes:** T6-3 needed calibration — jsdiff's `fuzzFactor:2` is more permissive than spec implied; the conflict-trigger fixture had to use 4 mismatched context lines (exceeding fuzz tolerance) rather than out-of-bounds line numbers. T6-5 fixture uses 2000 lines / changes every 20 lines (~100 hunks) to ensure jsdiff doesn't merge them. Integration tests caught a Windows path-resolution subtlety: must use the `AbsPath` returned by `captureOriginal`, not a hardcoded POSIX string, because `path.resolve` is platform-native. Full test count rose 173 → 186.
- **Completed At:** 2026-05-11 05:15

  - [x] Subtask: T6-1 toggle Accept→Reject→Accept round-trip identity
  - [x] Subtask: T6-2 50× byte-for-byte identical
  - [x] Subtask: T6-3 mismatched-context hunk → `set-conflict` with offending index
  - [x] Subtask: T6-4 leading-blank-line drift → fuzz applies → correct
  - [x] Subtask: T6-5 perf: ~100-hunk set change <200 ms P99 on 2000-line fixture
  - [x] Subtask: Binary-snapshot guard returns `snapshot-binary`
  - [x] Subtask: Empty-set short-circuit returns original snapshot without invoking jsdiff
  - [x] Subtask: Integration: initial state after Stop = current disk byte-for-byte
  - [x] Subtask: Integration: reject single hunk → single FS write with hunk reverted
  - [x] Subtask: Integration: bulk reject-all → single FS write of snapshot
  - [x] Subtask: Integration: accept on already-applied hunk → no FS write (short-circuit)

---

### 🏁 Milestone 9.2 — Memory Design Substrate (Track 1)
**Status:** [x] Complete
**Complexity:** XL
**Acceptance Criteria:** All T1-A* acceptance tests per spec §3.5 green; History panel renders sessions→turns→files tree; per-hunk undo restores via mutex; retention sweeper removes expired blobs/segments; crash recovery surfaces "Resume review" toast within 5 s of activation.
**Depends On:** M9.1 (set-based render must succeed before event recorded)
**Completed At:** 2026-05-12 00:10 (229/229 tests, dual webview bundles ship)

#### ✅ Task 9.2.1 — `historyEvents.ts` schema
- **Status:** [x]
- **Complexity:** S
- **Files:** `src/history/historyEvents.ts`
- **Completed At:** 2026-05-11 05:40

  - [x] Subtask: All 6 event types defined + Zod discriminated-union validators
  - [x] Subtask: Tolerant `decodeEvent` helper (returns null on schema/garbage)
  - [x] Subtask: `EVENT_SCHEMA_VERSION = 1` constant

#### ✅ Task 9.2.2 — `BlobStore` (content-addressed)
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/history/historyBlobs.ts`, `tests/unit/historyBlobs.test.ts` (7 tests)
- **Completed At:** 2026-05-11 05:42

  - [x] Subtask: `write(content): sha256_hex` with idempotent skip-on-exist
  - [x] Subtask: Two-level shard (`blobs/<sha[:2]>/<sha>.txt`)
  - [x] Subtask: Atomic write via tmp + rename
  - [x] Subtask: `has`, `delete`, `list` (async generator)

#### ✅ Task 9.2.3 — `historyWriter.ts` JSONL append + rollover
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/history/historyWriter.ts`
- **Notes:** Uses Node `fs.appendFile` which lands under 1 ms locally on SSDs — buffered-flush from spec is deferred until perf bench flags a regression. `HistoryEventInput` distributive `Omit<E, 'eventId'|'v'>` preserves discriminated-union narrowing at call sites.
- **Completed At:** 2026-05-11 05:44

  - [x] Subtask: Per-session monotonic event id
  - [x] Subtask: 5 MB segment rollover (`<sid>.0.jsonl`, `<sid>.1.jsonl`, ...)
  - [x] Subtask: Lazy state probe scans existing segments to continue where left off

#### ✅ Task 9.2.4 — `historyReader.ts` streaming + tolerant decode
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/history/historyReader.ts`
- **Completed At:** 2026-05-11 05:45

  - [x] Subtask: `readSession(sid)` async generator (line-by-line via readline)
  - [x] Subtask: Skip malformed lines silently; never throw
  - [x] Subtask: `findResumeCandidates({ withinMs })` — open-turn detection

#### ✅ Task 9.2.5 — `historyIndex.ts` index.json maintenance
- **Status:** [x]
- **Complexity:** S
- **Files:** `src/history/historyIndex.ts`
- **Completed At:** 2026-05-11 05:46

  - [x] Subtask: Schema with `SessionIndexEntry[]`
  - [x] Subtask: Atomic write (tmp + rename); in-memory cache for hot reads

#### ✅ Task 9.2.6 — `historyService.ts` orchestrator
- **Status:** [x]
- **Complexity:** L
- **Files:** `src/history/historyService.ts`
- **Notes:** All record* methods are best-effort (errors logged but never propagated to user flow). `resolveHistoryRoot` exposes the Q6 path scheme (user-scope: `~/.claude/review-history/<sha256(workspace)[:16]>/`; workspace-scope: `<workspace>/.claude/review-history/`). `sweep(retentionDays)` removes expired sessions + their unreferenced blobs by scanning live sessions' refs first.
- **Completed At:** 2026-05-11 05:48

  - [x] Subtask: Path resolver `resolveHistoryRoot` exported + tested
  - [x] Subtask: `recordTurnStarted/Stopped/HunkDecided/FileSnapshotReverted/TurnAborted`
  - [x] Subtask: `findResumeCandidates`, `readEvents`, `readBlob`, `listSessions`
  - [x] Subtask: `sweep` reference-scanning retention sweeper

#### ✅ Task 9.2.7 — Wire history into orchestrator + extension
- **Status:** [x]
- **Complexity:** M
- **Depends On:** Task 9.1.4, Task 9.2.6
- **Files:** `src/extension.ts`, `src/reviewOrchestrator.ts`, `src/snapshotStore.ts`
- **Notes:** `beginTurnIfNeeded` now returns `{ turnId, freshlyMinted }` so extension.ts can fire `recordTurnStarted` on first PreToolUse of a new turn. Orchestrator gains optional `history`/`agentId` opts — tests don't pass these so the wiring is fully optional. Three private record* helpers route every decision through history when configured.
- **Completed At:** 2026-05-11 05:50

  - [x] Subtask: Activation constructs `historyService` (workspace folder required)
  - [x] Subtask: `onPreToolUse` calls `beginTurnIfNeeded` + lazily records `turn-started`
  - [x] Subtask: `handleHunkAction` records `hunk-decided` post-write
  - [x] Subtask: `handleBulk` records each hunk decision in the batch
  - [x] Subtask: `revertFileToSnapshot` records `file-snapshot-reverted`
  - [x] Subtask: `openReview` records `turn-stopped` with full diff payload

#### ✅ Task 9.2.8 — Webview reorg + History panel webview
- **Status:** [x]
- **Complexity:** L
- **Files:** `webview/history/index.tsx`, `webview/history/App.tsx`, `webview/history/vscode.ts`, `webview/history/components/{SessionList,SessionDetail}.tsx`, `src/historyPanel.ts`, `src/messages.ts` (HistoryWebviewToHost / HistoryHostToWebview protocol), `src/history/historyTypes.ts` (extracted pure types for webview safety), `esbuild.config.mjs` (second bundle target), `package.json` (new `openHistory` command)
- **Notes:** Skipped the literal `webview/* → webview/review/*` rename — pure addition (new `webview/history/`) was lower risk and achieved the same outcome (room for the new bundle alongside the existing review one). Documented as a deviation from the planning note. Built bundle: `dist/webview/history/index.js` ~154 KB minified. Side-by-side with `dist/webview/index.js` (~360 KB review). History webview is read-only in v0.2 — no diff rendering, just session list + per-turn file-level summary. Full diff replay deferred to Phase β Revisit.
- **Completed At:** 2026-05-12 00:05

  - [x] Subtask: Add `webview/history/` alongside existing `webview/*` (rejected literal reorg; same outcome with smaller blast radius)
  - [x] Subtask: esbuild dual webview bundle with shared opts factored into `sharedWebviewOpts`
  - [x] Subtask: `src/historyPanel.ts` (~150 lines) mirrors review panel CSP/nonce/ready-gate lifecycle
  - [x] Subtask: React tree: `App` → `SessionList` (left) + `SessionDetail` (right with per-turn cards)
  - [x] Subtask: `claudeReview.openHistory` command wired to real panel (logger placeholder replaced)
  - [x] Subtask: Crash-recovery toast's "Open History" button reaches the real panel
  - [x] Subtask: `src/history/historyTypes.ts` extracted so webview can import `SessionIndexEntry` without dragging Node modules through tsconfig

#### ✅ Task 9.2.9 — Per-hunk undo (latest turn)
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/reviewOrchestrator.ts` (`handleUndoHunkDecision`), `webview/components/HunkBlock.tsx` (↶ button), `src/messages.ts` (`undo-hunk-decision`), `src/reviewPanel.ts` (dispatch), `tests/integration/orchestrator.set.test.ts` (3 new tests)
- **Notes:** Simpler than the spec implied — set-based foundation makes within-turn undo a single inverse-toggle on `acceptedSet` + status flip back to `pending`. No need for `historyService.undoLatestTurnHunk` reconstruction in v0.2 (the in-memory set has the state). Goes through the same per-file mutex as forward decisions. Cross-turn undo (rebase semantics) stays Phase β, gated by `claudeReview.history.crossTurnUndo`. The audit gap (undo not yet emitted as a distinct event in the log) is documented; Phase β emits explicit `undo` events with cascade tracking. Test infrastructure improvement: harness now exposes `writeCalls[]` not just `writes` Map so tests can count repeat writes to the same file.
- **Completed At:** 2026-05-12 00:10

  - [x] Subtask: New `undo-hunk-decision { filePath, hunkIndex }` in `WebviewToHost`
  - [x] Subtask: `handleUndoHunkDecision` inverse-toggles the set via `applyHunkSetChange` and flips `hunk.status` to `pending`
  - [x] Subtask: "↶ Undo" button on decided hunks in `<HunkBlock>` (hidden on pending hunks)
  - [x] Subtask: No-op on pending hunks (defensive)

#### ✅ Task 9.2.10 — Retention sweeper
- **Status:** [x]
- **Complexity:** S
- **Files:** `src/extension.ts` (10-min `setInterval` schedule), `src/history/historyService.ts` (`sweep` reference-scanning logic)
- **Notes:** Sweeper logs only when it removes something. Status-bar soft-cap warning deferred (no `maxBlobBytes` measurement yet — defer to Phase β if real usage shows growth).
- **Completed At:** 2026-05-11 05:52

  - [x] Subtask: 10-min `setInterval`; disposed via `context.subscriptions`
  - [x] Subtask: Reference-scanning sweep (live sessions' blobs preserved)

#### ✅ Task 9.2.11 — Crash recovery
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/extension.ts` (activation toast), `src/history/historyReader.ts` (`findResumeCandidates`)
- **Notes:** Toast offers `Open History` (wired to `claudeReview.openHistory`, which currently surfaces session metadata via Output Channel until M9.2.8 ships the real panel). Reconstruction-to-`SessionReview` and hash-vs-disk comparison deferred to Phase β Revisit surface where it's needed.
- **Completed At:** 2026-05-11 05:53

  - [x] Subtask: Activation reads candidates (7-day window)
  - [x] Subtask: Toast with `Open History` / `Dismiss` actions
  - [x] Subtask: Open-turn detection logic in reader

#### ✅ Task 9.2.12 — `.gitignore` prompt
- **Status:** [x]
- **Complexity:** XS
- **Files:** `src/extension.ts` (`maybePromptGitignore` helper)
- **Notes:** Only fires for workspace-scope installs (user-scope event logs live outside the project tree under `~/.claude/`). Only prompts if `.gitignore` exists and lacks the entry. Persists `claudeReview.gitignoreAsked = true` in `workspaceState` regardless of answer.
- **Completed At:** 2026-05-11 05:54

  - [x] Subtask: Detect first-write condition (per workspace via `workspaceState` flag)
  - [x] Subtask: Inject `.claude/review-history/` on accept
  - [x] Subtask: Persist suppression flag

#### ✅ Task 9.2.13 — Acceptance tests T1-A1 through T1-A8
- **Status:** [x] (subset for built tasks; T1-A5/A6 deferred with 9.2.8/9.2.9)
- **Complexity:** M
- **Files:** `tests/unit/historyEvents.test.ts` (8), `tests/unit/historyBlobs.test.ts` (7), `tests/integration/history.writer-reader.test.ts` (8), `tests/integration/history.service.test.ts` (8)
- **Notes:** 31 new tests total; full suite 195 → 226 green. T1-A5 (History panel tree) and T1-A6 (per-hunk undo) defer with M9.2.8 / M9.2.9 to the next wave when the UI lands.
- **Completed At:** 2026-05-11 06:00

  - [x] Subtask: T1-A1 schema validation
  - [x] Subtask: T1-A2 JSONL rollover at 5 MB (1100 appends of 5KB messages produces 2+ segments)
  - [x] Subtask: T1-A3 blob dedupe by SHA-256
  - [x] Subtask: T1-A4 streaming reader on large file + malformed-line tolerance
  - [-] Subtask: T1-A5 history panel tree renders (deferred → M9.2.8 wave)
  - [-] Subtask: T1-A6 per-hunk undo via mutex (deferred → M9.2.9 wave)
  - [x] Subtask: T1-A7 retention sweeper removes expired
  - [x] Subtask: T1-A8 crash recovery resume toast (`findResumeCandidates` exercises open-turn detection)

---

### 🏁 Milestone 9.3 — User-Level Hook Install (Track 2)
**Status:** [x] Complete
**Complexity:** M
**Acceptance Criteria:** All T2-* acceptance tests per spec §4.7 green. Fresh install on machine with no prior hooks writes to `~/.claude/settings.json` with marker entries. Two unrelated workspaces share the install. Switch-scope command preserves foreign keys. v0.1.0 users get one-time migration prompt.
**Depends On:** none (parallel with M9.1/M9.2)
**Completed At:** 2026-05-11 05:35 (9 new T2-* tests passing; 195/195 suite total)

#### ✅ Task 9.3.1 — Add `claudeReview.installScope` config
- **Status:** [x]
- **Complexity:** XS
- **Files:** `package.json`
- **Completed At:** 2026-05-11 05:25

  - [x] Subtask: Enum `'user'` | `'workspace'`, default `'user'`
  - [x] Subtask: Documented description

#### ✅ Task 9.3.2 — `resolveInstallPath` in hookConfigurator
- **Status:** [x]
- **Complexity:** M
- **Files:** `src/hookConfigurator.ts`
- **Notes:** `resolveInstallPath(scope, workspaceRoot)` is exported and pure (testable directly). Added `InstallScope` type, `RemoveHooksOptions`, and `hasInstalledHooks` probe for collision detection / migration. Removed dead `pathsFor` helper.
- **Completed At:** 2026-05-11 05:28

  - [x] Subtask: User scope → `path.join(os.homedir(), '.claude', 'settings.json')`
  - [x] Subtask: Preserve `HOOK_MARKER_KEY` foreign-key protection
  - [x] Subtask: Surface FS errors to caller (extension.ts shows actionable toast)
  - [x] Subtask: Create `~/.claude/` directory if missing via `fs.mkdir(... recursive)`

#### ✅ Task 9.3.3 — `switchInstallScope` command
- **Status:** [x]
- **Complexity:** S
- **Files:** `src/extension.ts`, `package.json`
- **Completed At:** 2026-05-11 05:30

  - [x] Subtask: Register `claudeReview.switchInstallScope` command
  - [x] Subtask: Remove marked hooks from old scope, write to new scope
  - [x] Subtask: Surface success toast with scope changed
  - [x] Subtask: Persist via `config.update('installScope', target, ConfigurationTarget.{Global|Workspace})`

#### ✅ Task 9.3.4 — Collision detection at activation
- **Status:** [x]
- **Complexity:** XS
- **Files:** `src/extension.ts`, `src/hookConfigurator.ts`
- **Completed At:** 2026-05-11 05:32

  - [x] Subtask: Scan both scopes at activation via `hasInstalledHooks`
  - [x] Subtask: When both populated and current scope is user → warn user; document that workspace is more-specific

#### ✅ Task 9.3.5 — v0.1.0 migration prompt
- **Status:** [x]
- **Complexity:** S
- **Files:** `src/extension.ts`
- **Notes:** Persists `claudeReview.migrationV1Asked` in `globalState`. Quietly persists on "no migration needed" so we don't ask again. Stay/Migrate updates the workspace setting + flag; Decide later leaves the flag false (will ask next activation).
- **Completed At:** 2026-05-11 05:33

  - [x] Subtask: Check `globalState.claudeReview.migrationV1Asked`
  - [x] Subtask: If workspace-marked hooks exist + flag false → 3-option prompt
  - [x] Subtask: Persist flag regardless of outcome

#### ✅ Task 9.3.6 — Acceptance tests T2-1 through T2-5
- **Status:** [x]
- **Complexity:** S
- **Files:** `tests/integration/hookConfigurator.scope.test.ts` (9 tests)
- **Notes:** Overrides `HOME`/`USERPROFILE` per test so user-scope writes land in a tempdir instead of the real home. T2-5 (permission denied) is platform-conditional — Windows ACLs don't reliably block via chmod from Node, so the assertion is skipped there. All 9 tests pass.
- **Completed At:** 2026-05-11 05:35

  - [x] Subtask: `resolveInstallPath` direct unit tests for both scopes
  - [x] Subtask: T2-1 fresh install at user-level
  - [x] Subtask: T2-2 two workspaces share install
  - [x] Subtask: T2-3 scope switch preserves foreign keys (both scopes)
  - [x] Subtask: T2-4 round-trip user → workspace → user clean
  - [x] Subtask: T2-5 permission denied graceful (POSIX only)

---

### 🏁 Milestone 9.4 — Agent Adapter + OpenCode (Track 3)
**Status:** [ ]
**Complexity:** L
**Acceptance Criteria:** All T3-* acceptance tests per spec §5.7 green. OpenCode session triggers review panel with parity per spec §5.6 (no transcript chat, no sub-agent). Mixed-agent sessions independent. Agent badge renders. Reduced-parity boundaries enforced in UI.
**Depends On:** M9.1 (HunkSetState), M9.2 (event log knows agentId). Parallel with M9.3.

#### ☐ Task 9.4.1 — Add `agentId` field to session types
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/types.ts`
- **Notes:** Decision: additive only, no rename `ClaudeSession → AgentSession` (Deviation entry to add).

  - [ ] Subtask: `agentId: 'claude-code' | 'opencode'` on `SessionData`
  - [ ] Subtask: Same field on `SessionReview`

#### ☐ Task 9.4.2 — `AgentAdapter` interface
- **Status:** [ ]
- **Complexity:** S
- **Files:** `src/adapters/agentAdapter.ts`

  - [ ] Subtask: Interface per spec §5.2.1
  - [ ] Subtask: `NormalisedPreToolUse/PostToolUse/Stop` shapes
  - [ ] Subtask: `HookConfigOpts` shape

#### ☐ Task 9.4.3 — `ClaudeCodeAdapter`
- **Status:** [ ]
- **Complexity:** M
- **Files:** `src/adapters/claudeCodeAdapter.ts`

  - [ ] Subtask: Extract existing hook parsing into adapter methods
  - [ ] Subtask: `generateHookConfig` returns current Claude Code shape
  - [ ] Subtask: `resolveTranscriptPath` (for Track 4)
  - [ ] Subtask: `extractSubagentId` placeholder (filled in Track 5)

#### ☐ Task 9.4.4 — `OpenCodeAdapter` (validate protocol first)
- **Status:** [ ]
- **Complexity:** L
- **Files:** `src/adapters/openCodeAdapter.ts`
- **Notes:** **Validation step:** check OpenCode docs at implementation time. HTTP first; shell-command bridge fallback if HTTP unsupported.

  - [ ] Subtask: Verify OpenCode hook protocol from current docs
  - [ ] Subtask: If HTTP supported → config writer for `~/.config/opencode/config.json`
  - [ ] Subtask: If HTTP unsupported → generate curl-bridge shell script + config to call it
  - [ ] Subtask: Payload parsers (normalised shapes)
  - [ ] Subtask: `resolveTranscriptPath` returns null (reduced parity)
  - [ ] Subtask: `extractSubagentId` returns null (reduced parity)

#### ☐ Task 9.4.5 — Adapter registry
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/adapters/index.ts`

  - [ ] Subtask: `agentAdapters: Map<agentId, AgentAdapter>` constant
  - [ ] Subtask: Helpers `getAdapter(agentId)`, `iterAdapters()`

#### ☐ Task 9.4.6 — Server routes for OpenCode
- **Status:** [ ]
- **Complexity:** M
- **Files:** `src/server.ts`

  - [ ] Subtask: New routes `/opencode/pre-tool-use`, `/opencode/post-tool-use`, `/opencode/stop`
  - [ ] Subtask: Handler dispatcher: route prefix → `agentAdapters.get('opencode').parse*()`
  - [ ] Subtask: Existing routes preserved as Claude Code (default)
  - [ ] Subtask: 404 for unknown route prefixes

#### ☐ Task 9.4.7 — Multi-adapter hook config writer
- **Status:** [ ]
- **Complexity:** S
- **Files:** `src/hookConfigurator.ts`

  - [ ] Subtask: `ensureHooksInstalled` iterates over enabled adapters
  - [ ] Subtask: Each adapter's `generateHookConfig` writes to its agent's config file
  - [ ] Subtask: Same marker key per adapter (with adapter suffix for OpenCode)

#### ☐ Task 9.4.8 — Agent badge in UI
- **Status:** [ ]
- **Complexity:** S
- **Files:** `webview/review/components/SessionHeader.tsx`, `webview/history/components/TurnTree.tsx`

  - [ ] Subtask: Panel header renders 🤖/🌐 + agent name
  - [ ] Subtask: History panel groups by agent first

#### ☐ Task 9.4.9 — Capability boundary UI
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `webview/review/components/ChatOverlay.tsx`

  - [ ] Subtask: OpenCode sessions show "Transcript context disabled for OpenCode (Phase γ)" banner in chat

#### ☐ Task 9.4.10 — Config `claudeReview.adapters.opencode.enabled`
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `package.json`

  - [ ] Subtask: Boolean, default true

#### ☐ Task 9.4.11 — Acceptance tests T3-1 through T3-5
- **Status:** [ ]
- **Complexity:** M
- **Files:** `tests/integration/adapter.opencode.test.ts`, `tests/e2e/multiAgent.test.ts`

  - [ ] Subtask: T3-1 OpenCode session end-to-end
  - [ ] Subtask: T3-2 per-hunk parity
  - [ ] Subtask: T3-3 mixed-agent independence
  - [ ] Subtask: T3-4 agent badge renders
  - [ ] Subtask: T3-5 reduced-parity enforced

---

### 🏁 Milestone 9.5 — Transcript-Aware Chat (Track 4)
**Status:** [ ]
**Complexity:** M
**Acceptance Criteria:** All T4-* acceptance tests per spec §6.8 green. Chat answers cite the user's original prompt for the turn; missing transcript falls back silently; malformed JSONL skipped; path traversal rejected; 50 MB transcript streams without exceeding 50 MB heap.
**Depends On:** M9.4 (`resolveTranscriptPath` is an adapter method)

#### ☐ Task 9.5.1 — `transcriptSchema.ts`
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/transcript/transcriptSchema.ts`

  - [ ] Subtask: `TranscriptEntry` discriminated union per spec §6.3
  - [ ] Subtask: `ContentBlock` types (text, tool_use)

#### ☐ Task 9.5.2 — `transcriptReader.ts` streaming reader
- **Status:** [ ]
- **Complexity:** M
- **Files:** `src/transcript/transcriptReader.ts`

  - [ ] Subtask: `readTranscriptWindow(path, sessionId, filePath, hunkRange): TranscriptWindow`
  - [ ] Subtask: Stream-parse JSONL line-by-line (no full-file load)
  - [ ] Subtask: Skip malformed lines with debug log
  - [ ] Subtask: Truncate per-tool-call `inputSummary` to 1 KB
  - [ ] Subtask: Locate turn boundary by user-message preceding first matching `tool_use`

#### ☐ Task 9.5.3 — `resolveTranscriptPath` on ClaudeCodeAdapter
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/adapters/claudeCodeAdapter.ts`

  - [ ] Subtask: Encode `cwd` (strip drive letter, replace `[\\/]` with `-`)
  - [ ] Subtask: Join under `os.homedir() + '/.claude/projects/'`

#### ☐ Task 9.5.4 — Path-traversal guard
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/transcript/transcriptReader.ts`

  - [ ] Subtask: Resolved path MUST start with `~/.claude/projects/`
  - [ ] Subtask: Reject before file open; log security event

#### ☐ Task 9.5.5 — System prompt v2
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/anthropicClient.ts`

  - [ ] Subtask: Bump `PROMPT_VERSION = 'v2'`
  - [ ] Subtask: New system prompt body per spec §6.5

#### ☐ Task 9.5.6 — Inject transcript context in chat message
- **Status:** [ ]
- **Complexity:** S
- **Files:** `src/chatService.ts`

  - [ ] Subtask: Resolve transcript path via active adapter
  - [ ] Subtask: Construct `transcriptContext` block per spec §6.6
  - [ ] Subtask: Skip if `chat.transcriptContext = false`

#### ☐ Task 9.5.7 — Config `claudeReview.chat.transcriptContext`
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `package.json`

  - [ ] Subtask: Boolean, default true

#### ☐ Task 9.5.8 — Update threat-model docs
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `docs/TRD-Claude-Code-Diff-Review-Extension.md`

  - [ ] Subtask: §14 asset table: add transcript as workspace-sensitive
  - [ ] Subtask: §14 forbidden patterns: transcript MUST NEVER reach webview

#### ☐ Task 9.5.9 — Acceptance tests T4-1 through T4-5
- **Status:** [ ]
- **Complexity:** S
- **Files:** `tests/unit/transcriptReader.test.ts`, `tests/integration/chat.transcript.test.ts`

  - [ ] Subtask: T4-1 cites original prompt
  - [ ] Subtask: T4-2 missing transcript fallback
  - [ ] Subtask: T4-3 malformed JSONL tolerated
  - [ ] Subtask: T4-4 path traversal rejected
  - [ ] Subtask: T4-5 50 MB streams under heap budget

---

### 🏁 Milestone 9.6 — Sub-Agent Attribution (Track 5)
**Status:** [ ]
**Complexity:** S
**Acceptance Criteria:** All T5-* acceptance tests per spec §7.4 green. Multi-Task session shows correct sub-agent badges; main-agent-only sessions clean; description truncated to 40 chars in chip; History groups by sub-agent.
**Depends On:** M9.5 (transcript reader)

#### ☐ Task 9.6.1 — Add `subagentId?` to review types
- **Status:** [ ]
- **Complexity:** XS
- **Files:** `src/types.ts`

  - [ ] Subtask: `subagentId?: string` on `FileReview`, `HunkReview`

#### ☐ Task 9.6.2 — `extractSubagentId` on ClaudeCodeAdapter
- **Status:** [ ]
- **Complexity:** M
- **Files:** `src/adapters/claudeCodeAdapter.ts`, `src/transcript/transcriptReader.ts`

  - [ ] Subtask: Walk transcript backward from PreToolUse timestamp
  - [ ] Subtask: Identify enclosing `Task` tool_use (parent_tool_use_id chain)
  - [ ] Subtask: Return sub-agent description (truncated to 40 chars for chip)

#### ☐ Task 9.6.3 — Wire `extractSubagentId` into onPreToolUse
- **Status:** [ ]
- **Complexity:** S
- **Files:** `src/extension.ts`, `src/reviewOrchestrator.ts`

  - [ ] Subtask: Call from `onPreToolUse` handler
  - [ ] Subtask: Persist on `FileReview`/`HunkReview` when computed

#### ☐ Task 9.6.4 — Sub-agent chip in file list + hunk tooltip
- **Status:** [ ]
- **Complexity:** S
- **Files:** `webview/review/components/FileList.tsx`, `webview/review/components/HunkBlock.tsx`

  - [ ] Subtask: Chip render with 40-char truncation
  - [ ] Subtask: Tooltip with full description

#### ☐ Task 9.6.5 — History panel sub-agent grouping
- **Status:** [ ]
- **Complexity:** S
- **Files:** `webview/history/components/TurnTree.tsx`

  - [ ] Subtask: Group turns by sub-agent inside their parent turn
  - [ ] Subtask: Render counts ("Main: 3 files / Task: refactor-auth: 2 files")

#### ☐ Task 9.6.6 — Acceptance tests T5-1 through T5-4
- **Status:** [ ]
- **Complexity:** S
- **Files:** `tests/unit/subagent.test.ts`, `tests/e2e/multiAgent.subagent.test.ts`

  - [ ] Subtask: T5-1 attribution from Task tool
  - [ ] Subtask: T5-2 main-agent-only clean
  - [ ] Subtask: T5-3 truncation 40 chars
  - [ ] Subtask: T5-4 history groups by sub-agent

---

### 🏁 Milestone 9.7 — Phase α Acceptance & Release
**Status:** [ ]
**Complexity:** M
**Acceptance Criteria:** All Phase α exit gates from spec §1.5 green. All existing 173 tests + new tests pass. Perf bench P99 ≤ 1.5 s on 50-file/2000-line fixture. v0.2.0 packaged + smoke-tested.
**Depends On:** M9.1, M9.2, M9.3, M9.4, M9.5, M9.6

#### ☐ Task 9.7.1 — Cross-track full-loop E2E
- **Status:** [ ]
- **Complexity:** M
- **Files:** `tests/e2e/phaseAlpha.fullLoop.test.ts`

  - [ ] Subtask: Claude Code session → event log → history panel → per-hunk undo
  - [ ] Subtask: OpenCode session in parallel; assert independence

#### ☐ Task 9.7.2 — Perf bench under Phase α pipeline
- **Status:** [ ]
- **Complexity:** S
- **Files:** `tests/perf/phaseAlpha.bench.test.ts`

  - [ ] Subtask: 50 files / 2000 lines fixture
  - [ ] Subtask: Assert P99 panel-open ≤ 1.5 s
  - [ ] Subtask: Assert set-render P99 ≤ 200 ms

#### ☐ Task 9.7.3 — Telemetry events wired
- **Status:** [ ]
- **Complexity:** S
- **Files:** `src/telemetry.ts`

  - [ ] Subtask: `history.turn.started/stopped`
  - [ ] Subtask: `transcript.used`
  - [ ] Subtask: `hunkSet.toggle`
  - [ ] Subtask: `agent.session`

#### ☐ Task 9.7.4 — Manifest bump + new commands/config
- **Status:** [ ]
- **Complexity:** S
- **Files:** `package.json`

  - [ ] Subtask: Version 0.1.0 → 0.2.0
  - [ ] Subtask: Register all new commands per spec §9.2
  - [ ] Subtask: Register all new config keys per spec §9.1

#### ☐ Task 9.7.5 — README + CHANGELOG
- **Status:** [ ]
- **Complexity:** S
- **Files:** `README.md`, `CHANGELOG.md`

  - [ ] Subtask: README: user-level install as default; multi-agent; History panel; transcript-aware chat
  - [ ] Subtask: CHANGELOG: 0.2.0 entry with all Phase α features

#### ☐ Task 9.7.6 — Regression: CSP + API-key-leak still green
- **Status:** [ ]
- **Complexity:** XS
- **Files:** existing security tests

  - [ ] Subtask: `npm test` → all 173 existing + new tests pass

#### ☐ Task 9.7.7 — Tag + package + smoke-test
- **Status:** [ ]
- **Complexity:** S
- **Files:** repo root

  - [ ] Subtask: `npm version 0.2.0`
  - [ ] Subtask: `vsce package`
  - [ ] Subtask: Install `.vsix` in fresh VS Code; run a Claude Code session; verify full loop

> **M9.4a status update (2026-05-18):** Per the β.0 + α-leftover slice plan, M9.4
> was split into 9.4a (adapter refactor — landed) and 9.4b (OpenCode adapter
> implementation — deferred). 9.4a extracted `AgentAdapter` + `ClaudeCodeAdapter`
> + registry; wired through `server.ts` and `hookConfigurator.ts`; added
> `agentId: AgentId` to `SessionData` and `SessionReview`. No behavioural change
> vs v0.2. 16 new unit tests in `tests/unit/adapter.claudeCode.test.ts`. 9.4b
> deferred because the spec depends on unverified OpenCode HTTP-hook support;
> the interface and field are in place, so adding OpenCode later is a contained
> single-file change.

---

## 🔀 Deviations & Decisions Log

| # | Date | Decision | Reason | Impact |
|---|---|---|---|---|
| 1 | 2026-05-10 | Use **Fastify** instead of TRD §5.2's `express` | ~2× faster on small JSON bodies; built-in JSON-schema fast-path; equivalent ergonomics. | Hits TRD §15 hook handler P99 <100 ms more comfortably. Documented in CHANGELOG. |
| 2 | 2026-05-10 | Bundle webview as IIFE (chrome108 target) | VS Code 1.85+ webview matches Chromium 108; IIFE simpler than ESM, no CDN | Smaller bundle, faster parse |
| 3 | 2026-05-10 | Use Zustand instead of Redux | ~3 KB vs 14 KB; selector subscriptions | Bundle size, render perf |
| 4 | 2026-05-10 | Default chat model `claude-haiku-4-5-20251001` | Hunk explanations are short, latency-sensitive, and frequent. Haiku 4.5 is the fastest/cheapest tier and a clean fit for "should I accept this hunk?" Q&A. Users wanting deeper reviews can override to `claude-sonnet-4-6` or `claude-opus-4-7` via `claudeReview.chatModel`. (PRD originally referenced an older Sonnet ID; superseded by this entry.) | User can override |
| 5 | 2026-05-10 | Render diff lines manually instead of via `react-diff-view` | react-diff-view's render-prop / decoration model awkward under strict CSP nonce regime; custom render gives total control + accessibility, library swap stays local to `<HunkBlock>`. Library still in deps for potential future swap. | Bundle is leaner; CSP simpler; no library version drift risk. |
| 6 | 2026-05-10 | **Add Claude Pro / Max OAuth path alongside the API-key path** | User runs Claude Code via Max subscription; no API key issued. Resolver probes 5 sources in order (env → secrets → `~/.claude/.credentials.json` → secrets API key). SDK is invoked with `authToken` (Bearer) or `apiKey` based on which source matched. | Max users can use chat without obtaining a separate API key. Existing API-key path stays for users who prefer it. |
| 7 | 2026-05-10 | **Inject bearer token via `context.environmentVariableCollection`** | TRD §14.2 specified the token would flow through `allowedEnvVars` in `.claude/settings.json` for substitution, but the spec never specified who actually *sets* `CLAUDE_REVIEW_TOKEN` in Claude Code's process env. Without it Claude Code substitutes empty and our server returns 401. Discovered live during M6 manual testing (Stop hook returning 401 in dev-host terminal). | Fixed by setting `context.environmentVariableCollection` with `persistent: false` (token rotates per activation). Existing terminals must be reopened to pick up the var; activation now toasts the user when this is the case. |
| 8 | 2026-05-10 | **Externalise `@anthropic-ai/sdk` from the bundle; defer hookConfigurator** | After M4 the activation bundle hit 1.3 MB and cold-start crossed VS Code's 10 s `extension host did not start` threshold on slower machines. Bundle parse + hook-config write were the heaviest items. | Externalised SDK (esbuild `external: ['vscode', '@anthropic-ai/sdk']`) — bundle dropped to 879 KB. SDK now `require()`'d lazily on first chat. `vsce package` will include the SDK from node_modules. `ensureHooksInstalled` is now fire-and-forget — the hook file only needs to exist before the next `claude` invocation, not before `activate()` returns. |
| 9 | 2026-05-10 | **Logger fallback hardened against "Channel has been closed"** | During extension-host shutdown VS Code closes OutputChannel transports while disposables are still running; `Logger.write` could throw which crashed deactivation. | Wrapped the fallback `appendLine` in a second try/catch that swallows. Confirmed against the live trace user reported. |
| 10 | 2026-05-10 | **Webview esbuild config: `jsx: 'automatic'`, `jsxImportSource: 'react'`** | tsconfig.webview.json sets `jsx: 'react-jsx'` but esbuild's build config didn't opt into the automatic JSX runtime, so its default classic transform emitted `React.createElement(...)` and crashed at runtime with `ReferenceError: React is not defined` — every JSX expression in the bundle failed. Manifested as a blank review panel; surfaced after adding the ErrorBoundary. | Set `jsx: 'automatic'` + `jsxImportSource: 'react'` in webview esbuild config. Bundle now imports from `react/jsx-runtime` (verified via grep). |
| 11 | 2026-05-10 | **Webview banner-injects a browser-safe `process` shim** | Some `unified` / `rehype-sanitize` deps reference `process.env` at module evaluation time. Without a stub the IIFE throws `ReferenceError` during script parse. | Added an esbuild `banner.js` defining a minimal `process = { env: {}, platform: 'browser', cwd: () => '/' }` plus `define` mappings for `process.env.NODE_ENV` and `process.platform`. |
| 12 | 2026-05-10 | **Webview `<ErrorBoundary>` + top-level `try/catch` + `window.onerror`** | A render-time crash in the React tree leaves the panel blank — no signal to the user. | Three nested guards: window-level `error` + `unhandledrejection` listeners, top-level try/catch around `createRoot().render()`, and a React class component `<ErrorBoundary>` wrapping `<App>`. All three render visible error UI inside the panel. |
| 13 | 2026-05-10 | **Host-side `webviewReady` gate before flushing posts** | Browser `MessageEvent`s do not queue. Host was posting `init` via `setImmediate` before the React tree had mounted and registered its `message` listener. First session sometimes won the race; subsequent Stop-hook-triggered re-inits frequently lost it, leaving the panel stuck at "Waiting for Claude Code session…". | Each `PanelEntry` carries a `webviewReady: boolean` (false at panel creation). `scheduleFlush` is a no-op until `ready`. The webview's `App.tsx` already sends `{type: 'ready'}` on mount; the host's `dispatch('ready')` flips the flag and flushes. Re-mounts (e.g., editor-group moves) re-fire `ready` and re-flush. `openOrFocus` on an existing panel also clears stale pending posts so the new init isn't preceded by obsolete updates. |
| 15 | 2026-05-11 | **Denormalised file indexes for O(1) lookup** | `SessionReview.files: FileReview[]` was scanned linearly via `.find(f => f.filePath === absFile)` on every `handleHunkAction`, `handleBulk`, `scheduleReDiff`, `ChatService.start`, and `CodeLensProvider.findHunksForFile`. With the 200-file cap that's up to 200 ops per click; with cross-session CodeLens lookup it's O(sessions × files). | Added two private maps on `ReviewOrchestrator`: `byPath: Map<SessionId, Map<AbsPath, FileReview>>` for per-session O(1) lookup, and `globalByPath: Map<AbsPath, { sessionId; file }>` for cross-session O(1) lookup. Both share references with the canonical `session.files: FileReview[]` array (so in-place mutations propagate); maintained only on session lifecycle (`indexFiles` on open, `unindexSession` on dismiss). New public `orchestrator.findFile(filePath)` for cross-session callers. CodeLens slow-path retained as a Win32 path-shape safety net. **Result: perf bench median 630→363 ms (≈42% faster) at the 50-file workload.** Wire format unchanged — webview still receives the array. |
| 14 | 2026-05-11 | **Per-file mutex on action paths; FS failures surfaced; bulk-reject fast path; +8 concurrency tests** | Manual review of action paths surfaced: (a) two parallel reject clicks could both `fs.readFile` the same starting content and the second write would clobber the first; (b) `fs.readFile` / `fs.writeFile` failures bubbled up silently — user saw nothing change after a click; (c) per-hunk reverts can drift across hunks via context-shift, while bulk-rejecting a fully-pending file is equivalent to writing the snapshot once. | Added `fileLocks: Map<AbsPath, Promise<unknown>>` Promise-chain mutex on the orchestrator. `handleHunkAction`, `handleBulk`, and `revertFileToSnapshot` all acquire the per-file lock; same-file actions serialise, different files run in parallel via `Promise.all`. `applyReject` now distinguishes `fuzz` vs `fs` failures and surfaces the latter via two new `FileWarning` kinds (`write-failed`, `read-failed`) which `<DiffPane>` renders with a "Revert to snapshot" recovery button. Bulk-reject fast-paths to a single `writeFile(file.before)` when every hunk is still pending. Eight integration tests in `tests/integration/actionConcurrency.test.ts` exercise: same-file racing, mixed accept/reject racing, cross-file parallelism, fast-path write count, FS-failure surfacing + retry, snapshot-revert FS failure, accept idempotency, accept-then-reject-on-decided no-op. |
| 16 | 2026-05-11 | **Phase α: user-level hook install as default** (Q1) | Per-project install was a per-workspace activation barrier. User-level (`~/.claude/settings.json`) means every Claude Code session on the machine is reviewed automatically with zero per-project setup. Defends against hunkwise's positioning + dramatically lifts activation. | New config `claudeReview.installScope: 'user' \| 'workspace'`, default `'user'`. v0.1.0 users get one-time migration prompt. Path scheme for event log: `~/.claude/review-history/<sha256(workspace)[:16]>/` when scope=user. |
| 17 | 2026-05-11 | **Phase α: keep `SessionData` type name; add `agentId` field only** | Spec §5.2.2 called for renaming `ClaudeSession → AgentSession`. Codebase audit showed cascade through 7 modules (types, snapshotStore, reviewOrchestrator, reviewPanel, server, extension, messages) with no architectural payoff — adapters dispatch on `agentId` field regardless of type name. | Smaller blast radius; cleaner diff; faster ship. Field added only. Documented for future readers: "Session" here means agent session, agent-agnostic by virtue of the field. |
| 18 | 2026-05-11 | **Phase α: Track 6 (set-based reversibility) ships before Track 1 (event log)** | Event log records each decision AFTER the set-based write succeeds. Doing Track 1 first would force a second integration when Track 6 changes the write path. | Hard ordering in M9 milestones: M9.1 must complete before M9.2 wires `historyService.recordHunkDecided` to the new write pipeline. Plans treat M9.2 as a strict successor to M9.1. |
| 19 | 2026-05-11 | **Phase α: OpenCode reduced parity for v1** (Q3) | Adapter pattern is the structural win; full feature parity with Claude Code (transcript-aware chat, sub-agent attribution) requires OpenCode-specific transcript readers and Task-tool equivalents that may not exist in OpenCode at all. | Phase α ships OpenCode with hook capture + per-hunk review + event log; chat shows "Transcript context disabled for OpenCode (Phase γ)" boundary. Phase γ revisits if/when OpenCode exposes equivalents. HTTP-first; shell-command bridge fallback if OpenCode lacks HTTP hooks. |
| 20 | 2026-05-11 | **Phase α: History panel as a separate webview, not nested tab** (Q2.4) | History panel has different lifecycle and persistence semantics from the live review panel (read-only most of the time, opens any time, may show data for sessions where no review panel exists). Nesting them as tabs would couple lifecycles unnecessarily. | New viewType `claudeReview.history` registered. `webview/` reorganised into `webview/review/` + new `webview/history/`. New module `src/historyPanel.ts` mirrors `src/reviewPanel.ts` lifecycle. |
| 21 | 2026-05-11 | **Phase α: cross-turn undo behind dev-mode flag** (Q2.3) | Cascade conflicts on cross-turn undo can corrupt workspaces (real risk per MEMORY-DESIGN.md §5 rebase semantics). v1 data on real users will inform safer default. | Config `claudeReview.history.crossTurnUndo: false` default. Within-turn undo (the "↶" icon on decided hunks in the active panel) always on. History panel surfaces cross-turn undo only when flag enabled. |

## 🧱 Tech Debt & TODOs

| # | Area | Description | Introduced In | Priority |
|---|---|---|---|---|
| 1 | tests/e2e | Test runner script (`tests/e2e/runTests.cjs`) referenced in `package.json` not yet created | Session 1 | Med — needed before M6 perf bench |
| 2 | docs | Manual QA checklist (`docs/qa.md`) deferred to M6 | Session 1 | Low |
| 3 | M3.1.6 | Performance bench fixture (50 files / 2,000 lines) deferred to M6 | Session 1 | Med — gates GA. Required by TRD §15. |
| 4 | webview | "Ask Claude" button currently `alert(...)`; full chat overlay arrives in M4 | Session 1 | ✅ Resolved in M4 |
| 5 | extension bundle | Bundle grew to 1.3 MB after Anthropic SDK include. VSIX still under 5 MB cap. Could mark `@anthropic-ai/sdk` external + bundle separately for faster cold-start; defer to M6 polish if perf bench flags it. | Session 1 | Low |

## 🔒 Blockers

| # | Task | Blocker | Raised | Resolved |
|---|---|---|---|---|
| — | — | None | — | — |

---

## 📓 Session Log

### Session 1 — 2026-05-10 (M0 → M4)
**Summary:** Authored TRD; produced M0–M8 implementation plan; completed M0 → M4 with 119 passing tests. End-to-end review + chat-about-hunk both wired.

**Completed:**
- [x] Technical Requirements Document at `docs/TRD-Claude-Code-Diff-Review-Extension.md` (21 sections + 3 appendices)
- [x] Phased implementation plan at `~/.claude/plans/peaceful-squishing-moon.md` with entry/exit gates and TRD §15 budget mapping
- [x] **M0** Scaffold — package.json, tsconfig × 2, esbuild, vitest, ESLint, GitHub Actions, launch/tasks JSON, smoke test
- [x] **M1** Hooks & Server — secretManager, messages (Zod), logger, hookConfigurator, Fastify server, mock-claude CLI; 50 tests
- [x] **M2** Snapshot & Diff — snapshotStore (per-(sid,path) mutex, byte/file caps, path-traversal guard), diffEngine (computeDiff, revertHunk with fuzz fallback, CRLF, binary detection); 34 tests
- [x] **M3** Review Panel UI — reviewOrchestrator (state machine, debounce, circuit breaker, accept/reject/bulk, write-back via revertHunk), reviewPanel (CSP nonce, coalesced postMessage, lifecycle), full React webview app (Zustand, Virtuoso, custom split/unified diff, theme tokens), statusBarController, scmProvider; 14 tests
- [x] **M4** Chat Subsystem — anthropicClient (`messages.stream`, AbortSignal, error classifier, history trimmer, system prompt v1), chatService (per-hunk conversation, AbortController-per-chatId, 16 ms coalesced delta flush), ChatOverlay React component (`react-markdown` + `rehype-sanitize`, UUID v4 chatIds, cancel on close, quick-action buttons), API-key-leak security assertion test; 19 tests
- [x] **Final state:** 119/119 tests passing across 11 files; typecheck clean; build produces 1.3 MB extension + 339 KB webview JS + 10.4 KB CSS.

**Files Changed:**
- `docs/TRD-Claude-Code-Diff-Review-Extension.md` — created (parent dir, this is the source TRD)
- `package.json` — created (manifest with deps + contributions)
- `tsconfig.json`, `tsconfig.webview.json` — created (strict TS configs)
- `esbuild.config.mjs` — created (dual-bundle build)
- `src/extension.ts` — created (activation skeleton)
- `vitest.config.ts` — created (test harness with 80% coverage threshold)
- `tests/unit/smoke.test.ts` — created (smoke tests pass)
- `.eslintrc.cjs` — created (forbids eval/dangerouslySetInnerHTML/unsafe exec)
- `.gitignore`, `.vscodeignore` — created
- `.vscode/launch.json`, `.vscode/tasks.json` — created (F5 → build → launch dev host)
- `.github/workflows/ci.yml` — created (mac/linux/win × node20)
- `README.md`, `CHANGELOG.md`, `LICENSE` — created
- `PROJECT_TRACKER.md` — created (this file)

**Dependencies Added (declared, not yet installed):**
- `fastify@^4.28.1` — HTTP server (TRD deviation: replaces express)
- `diff@^5.2.0` (jsdiff) — structuredPatch / reversePatch / applyPatch
- `react-diff-view@^3.2.1` — interactive hunk widgets
- `react-virtuoso@^4.10.4` — file list virtualisation
- `zustand@^4.5.5` — webview state
- `zod@^3.23.8` — runtime schema validation
- `@anthropic-ai/sdk@^0.30.1` — chat streaming
- `react@^18.3.1` + `react-dom`
- `react-markdown@^9.0.1` + `rehype-sanitize@^6.0.0` — safe markdown render
- `uuid@^10.0.0` — chatIds

**Decisions:**
- Fastify over express (perf, schema fast-path) — Deviation #1
- Webview as IIFE chrome108 — Deviation #2
- Zustand over Redux — Deviation #3
- `claude-sonnet-4-6` as default chat model — Deviation #4

**Deviations:**
- See Deviations & Decisions Log above. All non-breaking, well-justified.

**Tech Debt Introduced:**
- `tests/e2e/runTests.cjs` referenced in `package.json` script `test:e2e` but file not yet authored. Will be created during M3.
- `docs/qa.md` referenced in M6 plan; not yet created.

**Next Session Should:**
1. Begin **M7 Beta Release** — `vsce package` to produce a `.vsix`, write the `docs/qa.md` manual checklist, set up the README's Setup / Troubleshooting / Known Issues sections
2. Run a license audit (`license-checker`) and emit a CycloneDX SBOM at release time
3. Onboarding flow: first-run notification with a quick-start ("Set OAuth token, run `claude`")
4. Optional: revisit axe-core a11y test now that test runner is more mature
5. Optional: install the produced VSIX in a real VS Code (not dev-host) to validate the marketplace install flow before publishing

---

### Session 2 — 2026-05-11 04:00 (Phase α planning)
**Summary:** Authored strategy doc stack (COMPETITOR-FEEDBACK.md, ECOSYSTEM-ROADMAP.md, PHASE-ALPHA-IMMEDIATE.md, PHASE-BETA-NEXT.md). Resolved all 7 open questions from PHASE-ALPHA-IMMEDIATE.md §11. Approved Phase α implementation plan at `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md`. Added Phase 9 to tracker with 7 milestones + 53 tasks.

**Completed:**
- [x] Strategic synthesis: competitor analysis, ecosystem framing, phased roadmap (4 docs in `..parent/` dir)
- [x] Phase α implementation spec (PHASE-ALPHA-IMMEDIATE.md) — 6 tracks, 28 acceptance test IDs
- [x] Phase β implementation spec (PHASE-BETA-NEXT.md) — 4 surfaces, 40 acceptance test IDs
- [x] Resolved 7 open questions via user via AskUserQuestion
- [x] Codebase audit vs Phase α spec (parallel Explore agents)
- [x] Plan file at `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md` (approved)
- [x] Tracker Stats block updated; Phase 9 inserted with M9.1–M9.7; 6 new Deviation entries (#16–#21)

**Files Changed:**
- `../PHASE-ALPHA-IMMEDIATE.md` — created (parent-dir companion spec)
- `../PHASE-BETA-NEXT.md` — created (parent-dir companion spec)
- `../COMPETITOR-FEEDBACK.md` — created (market analysis)
- `../ECOSYSTEM-ROADMAP.md` — created (strategic framing)
- `../MEMORY-DESIGN.md` — already existed (Phase α leverages directly)
- `PROJECT_TRACKER.md` — Stats block, Phase 9 inserted, 6 new Deviation entries, Session 2 log

**Dependencies Added:** none (planning session only)

**Decisions (all logged as Deviations #16–#21):**
- D16: User-level hook install as default (Q1)
- D17: Keep `SessionData` name; additive `agentId` field (Type Q)
- D18: Track 6 ships before Track 1 (execution order)
- D19: OpenCode reduced parity for v1 (Q3)
- D20: History panel = separate webview (Q2.4)
- D21: Cross-turn undo behind dev-mode flag (Q2.3)

Other resolved (defaults adopted from spec recommendation, no new Deviation needed):
- Q2.1 exclude globs: spec defaults
- Q2.2 retention: 30 days
- Q2.5 .gitignore injection: prompt once per workspace
- Q4 transcript resilience: fail-open
- Q5 sub-agent UI density: default on, 40-char chip + tooltip
- Q6 path scheme: `~/.claude/review-history/<sha256(workspace)[:16]>/` when user-scope
- Q7 v0.1.0 migration: one-time prompt

**Deviations:**
- See entries #16–#21 in Deviations & Decisions Log

**Tech Debt Introduced:** none (planning only)

**Next Session Should:**
1. **Begin M9.1.1** — add `HunkSetState` and `RenderResult` types to `src/types.ts`
2. After M9.1 complete, **M9.2 + M9.3 + M9.4 in parallel** — these touch independent code paths
3. **M9.5 strictly after M9.4** — transcript reader is an adapter method
4. **M9.6 strictly after M9.5** — sub-agent attribution piggybacks on transcript reader
5. **M9.7 final** — release gate; perf bench + smoke test + tag v0.2.0
6. Per CLAUDE.md: update tracker immediately after each task; never batch
7. Validate OpenCode hook protocol assumption (Task 9.4.4) at implementation time before writing the adapter

---

### Session 3 — 2026-05-11 05:15 (M9.1 — Set-Based Reversibility Foundation)
**Summary:** Completed Phase α Milestone 9.1 in full. Set-based reversibility is the foundation primitive that the rest of Phase α and all of Phase β builds on. 13 new tests added (9 unit + 4 integration); 186/186 total green.

**Completed:**
- [x] **M9.1.1** `HunkSetState` and `RenderResult` types in `src/types.ts`
- [x] **M9.1.2** Pure-function `renderFileFromHunkSet` + `initialHunkSetState` helper in `src/core/hunkSet.ts`
- [x] **M9.1.3** Turn-aware fields (`currentTurnId`, `turnStartedAt`) and `beginTurnIfNeeded` / `endTurn` methods on `SnapshotStore`
- [x] **M9.1.4** Orchestrator refactored: `applyHunkSetChange` is the single write primitive routed through by `handleHunkAction`, `handleBulk`, and `revertFileToSnapshot`. New `postSetConflict` on `PanelGateway` wired through `ReviewPanelManager`. Legacy `applyReject` removed.
- [x] **M9.1.5** Initial-state migration: `openReview` seeds `acceptedSet = all hunk indices`. No user-visible behaviour change vs v0.1.0.
- [x] **M9.1.6** T6-1 through T6-5 acceptance tests + 4 integration tests for the orchestrator/set wiring

**Files Changed:**
- `src/types.ts` — added `HunkSetState`, `RenderResult`; extended `SessionData` with turn fields
- `src/core/hunkSet.ts` — created (101 lines, pure)
- `src/snapshotStore.ts` — added `beginTurnIfNeeded` + `endTurn`; added `crypto` import
- `src/reviewOrchestrator.ts` — added `hunkSets` map, `applyHunkSetChange`, `indexHunkSets`/`unindexHunkSets`, `setsEqual` helper; refactored `handleHunkAction`, `handleBulk`, `revertFileToSnapshot`; wired `endTurn` into `handleStop`; updated `reDiff` to rebuild HunkSetState; removed `applyReject`
- `src/messages.ts` — added `set-conflict-warning` to `HostToWebview` discriminated union
- `src/reviewPanel.ts` — added `postSetConflict` to wire the new message kind
- `tests/unit/reviewOrchestrator.test.ts`, `tests/unit/codeLensProvider.test.ts`, `tests/integration/actionConcurrency.test.ts`, `tests/integration/chatService.test.ts`, `tests/integration/memoryLeak.test.ts`, `tests/integration/perf.bench.test.ts` — added `postSetConflict` stub to each `PanelGateway` impl
- `tests/unit/hunkSet.test.ts` — created (9 tests)
- `tests/integration/orchestrator.set.test.ts` — created (4 tests)

**Dependencies Added:** none (`crypto.randomUUID` is Node built-in)

**Decisions:**
- Skipped the spec-mandated rename `SessionData → AgentSession` (Deviation #17, decided in planning Session 2). Confirmed during implementation that the additive `agentId` field will cover Track 3 needs.
- Added a `setsEqual` short-circuit in `applyHunkSetChange` to preserve v0.1.0's "accept-on-applied is a free no-op" invariant.
- Simplified `revertFileToSnapshot`: removed the double-write fallback. The empty-set render path is provably equivalent and the fallback was masking FS-failure handling.
- T6-3 fixture switched from out-of-bounds line numbers to multi-line context mismatch (4 mismatching context lines exceed `fuzzFactor:2` tolerance). jsdiff's fuzz is more permissive than the spec language implied.

**Deviations:** none new in this session — all aligned with prior planning entries #16–#21.

**Tech Debt Introduced:** none

**Next Session Should:**
1. **M9.2 — Memory Design Substrate** (XL, Track 1). Start with `historyEvents.ts` schema + `historyBlobs.ts` blob store.
2. **M9.3 — User-Level Hook Install** can start in parallel (independent code path).
3. The orchestrator now has `currentTurnId` from the store; M9.2 wires `historyService.recordHunkDecided` AFTER the `applyHunkSetChange` succeeds.
4. Confirm path scheme for the event log root: `~/.claude/review-history/<workspace-hash>/` (Q6 already resolved).

---

### Session 4 — 2026-05-11 06:00 (M9.2 substrate + M9.3 complete in parallel)
**Summary:** Shipped M9.3 (user-level hook install, all 5 tasks + acceptance tests) and the 11-of-13 testable parts of M9.2 (Memory Design substrate end-to-end: schema, blob store, JSONL writer, streaming reader, index file, service orchestrator, orchestrator+extension wiring, retention sweeper, crash recovery toast, .gitignore prompt, acceptance tests). 40 new tests; 186 → 226 green.

**Completed (M9.3):**
- [x] **9.3.1** `claudeReview.installScope` config (`user` default)
- [x] **9.3.2** `resolveInstallPath(scope, workspaceRoot)` + `hasInstalledHooks` probe
- [x] **9.3.3** `claudeReview.switchInstallScope` command (palette-accessible)
- [x] **9.3.4** Collision detection at activation (both scopes carry marker → warn)
- [x] **9.3.5** v0.1.0 → v0.2.0 migration prompt (one-time, `globalState.migrationV1Asked`)
- [x] **9.3.6** T2-* acceptance tests (9 tests; `HOME`/`USERPROFILE` overrides per test)

**Completed (M9.2 substrate):**
- [x] **9.2.1** `historyEvents.ts` — schema + Zod validators + `decodeEvent` tolerant decode
- [x] **9.2.2** `historyBlobs.ts` — content-addressed BlobStore, two-level shard, atomic write
- [x] **9.2.3** `historyWriter.ts` — JSONL append, 5 MB segment rollover, monotonic event ids
- [x] **9.2.4** `historyReader.ts` — streaming line-by-line, malformed-tolerant, `findResumeCandidates`
- [x] **9.2.5** `historyIndex.ts` — `index.json` atomic maintenance + in-memory cache
- [x] **9.2.6** `historyService.ts` — record*, listSessions, readEvents, readBlob, sweep, `resolveHistoryRoot` (Q6 path scheme)
- [x] **9.2.7** Wire into orchestrator + extension — `recordTurnStarted` on first PreToolUse, `recordHunkDecided` post-write (handleHunkAction + handleBulk), `recordTurnStopped` on openReview, `recordFileSnapshotReverted` on snapshot revert
- [x] **9.2.10** Retention sweeper — 10-min `setInterval`, reference-scanning
- [x] **9.2.11** Crash recovery toast at activation (7-day window)
- [x] **9.2.12** `.gitignore` prompt (workspace-scope only, one-time per workspace)
- [x] **9.2.13** Acceptance tests T1-A* (subset: A1, A2, A3, A4, A7, A8; A5/A6 deferred with UI)

**Deferred from M9.2 (next wave):**
- [ ] **9.2.8** Webview reorg + History panel UI (large — own wave)
- [ ] **9.2.9** Per-hunk undo `↶` icon in webview (depends on 9.2.8 reorg)

**Files Changed:**
- `src/history/{historyEvents,historyBlobs,historyWriter,historyReader,historyIndex,historyService}.ts` — created
- `src/hookConfigurator.ts` — added `InstallScope`, `RemoveHooksOptions`, `resolveInstallPath`, `hasInstalledHooks`; refactored ensure/remove to accept scope
- `src/snapshotStore.ts` — `beginTurnIfNeeded` now returns `{ turnId, freshlyMinted }`
- `src/reviewOrchestrator.ts` — optional `history`, `agentId` opts; three private record* helpers; `applyHunkSetChange` records `hunk-decided` post-write; `revertFileToSnapshot` records `file-snapshot-reverted`
- `src/extension.ts` — `HistoryService` construction, retention sweeper schedule, recovery toast, `.gitignore` prompt, `switchInstallScope` command, migration prompt, collision detection, `claudeReview.openHistory` placeholder
- `package.json` — `claudeReview.installScope`, `history.enabled`, `history.retentionDays`, `history.crossTurnUndo` config keys; `switchInstallScope`, `openHistory` commands
- `tests/unit/historyEvents.test.ts`, `tests/unit/historyBlobs.test.ts` — created (15 tests)
- `tests/integration/history.writer-reader.test.ts`, `tests/integration/history.service.test.ts` — created (16 tests)
- `tests/integration/hookConfigurator.scope.test.ts` — created (9 tests)
- `tests/unit/hookConfigurator.test.ts` — updated callers to pass `scope`

**Dependencies Added:** none (`zod`, `crypto`, `os`, `readline` all already in tree)

**Decisions (new this session — to be promoted to Deviations log if they survive):**
- D-S4-1: History panel UI deferred to a dedicated wave (XL on its own). The recovery toast still wires through `claudeReview.openHistory`, which surfaces session metadata via the Output Channel as a placeholder so the command is end-to-end usable.
- D-S4-2: `HistoryEventInput` uses a distributive `Omit` to preserve discriminated-union narrowing at writer call sites (avoids fragile object-literal type errors in `historyService`).
- D-S4-3: Retention sweeper logs only when it actually removes something (idle ticks stay silent).
- D-S4-4: `revertFileToSnapshot` simplified: no double-write fallback. The empty-set render is provably equivalent and the fallback was masking FS-failure handling (caught in M9.1 testing).
- D-S4-5: Soft-cap warning at 80% of `maxBlobBytes` from spec §3.5 T1-A7 deferred — no measurement infra yet; revisit in Phase β if real usage shows growth.

**Deviations:** none new; all aligned with prior planning entries #16–#21.

**Tech Debt Introduced:**
- History panel UI still a logger placeholder (M9.2.8 owes a real webview).
- Per-hunk undo `↶` icon not yet wired (M9.2.9; service-side `undoLatestTurnHunk` not yet exposed because no UI consumes it).
- `tests/e2e/runTests.cjs` still missing (carried from Session 1 tech debt #1).

**Next Session Should:**
1. **M9.4 — Agent Adapter + OpenCode** (L, Track 3). Refactor wire format under an adapter interface; ship OpenCode with reduced parity. Independent of M9.2.8/9. Validate OpenCode hook protocol from current docs before writing the adapter (Task 9.4.4).
2. **M9.2.8 + M9.2.9 (UI)** as a sibling wave: webview reorg, History panel React tree, per-hunk undo button. Can run in parallel with M9.4 — different code paths.
3. **M9.5 / M9.6** strictly after M9.4 (transcript-aware chat needs `ClaudeCodeAdapter.resolveTranscriptPath`).
4. Per CLAUDE.md: update tracker immediately after each task; never batch.

---

### Session 5 — 2026-05-12 00:15 (M9.2.8 + M9.2.9 — UI close-out)
**Summary:** Shipped the History panel webview and per-hunk undo to close out Milestone 9.2. Substrate is now visible to the user end-to-end. 3 new tests; 226 → 229 green.

**Completed:**
- [x] **9.2.8** History panel webview + extension wiring
- [x] **9.2.9** Per-hunk undo (within-turn)

**Files Changed:**
- `webview/history/index.tsx`, `webview/history/App.tsx`, `webview/history/vscode.ts` — created (history webview entry + root + bridge)
- `webview/history/components/SessionList.tsx`, `webview/history/components/SessionDetail.tsx` — created
- `webview/components/HunkBlock.tsx` — added ↶ Undo button on decided hunks
- `src/historyPanel.ts` — created (webview lifecycle manager, ~150 lines)
- `src/history/historyTypes.ts` — created (pure types extracted to keep webview tsconfig Node-free)
- `src/history/historyIndex.ts` — re-exports `SessionIndexEntry`/`HistoryIndex` from `historyTypes.ts`
- `src/messages.ts` — new `HistoryWebviewToHost`/`HistoryHostToWebview` protocol, `parseHistoryWebviewMessage`, `undo-hunk-decision` added to `WebviewToHost`
- `src/reviewPanel.ts` — dispatches `undo-hunk-decision` to orchestrator
- `src/reviewOrchestrator.ts` — new `handleUndoHunkDecision` (set inverse-toggle + status flip to pending)
- `src/extension.ts` — `openHistory` command now opens the real panel; `historyPanel` lazy-constructed on demand
- `esbuild.config.mjs` — second webview bundle target (`dist/webview/history/index.js`), shared opts factored
- `package.json` — `openHistory` command unchanged (was already registered); no new entries
- `tests/integration/orchestrator.set.test.ts` — 3 new undo tests, harness exposes `writeCalls[]`

**Dependencies Added:** none

**Decisions (new this session):**
- D-S5-1: Skipped the literal `webview/* → webview/review/*` rename. Added `webview/history/` alongside instead. Identical outcome, zero risk to existing review panel. Documented in 9.2.8 task notes.
- D-S5-2: History panel is read-only in v0.2. No diff rendering, no per-hunk decisions from the History panel. Decision actions stay on the live review panel. The History panel surfaces session list + turn timeline + file-level decision summary — enough for crash-recovery glance and audit.
- D-S5-3: Extracted `src/history/historyTypes.ts` (pure types, zero Node imports) so the webview tsconfig can pull in `SessionIndexEntry`/`HistoryIndex` without dragging `node:fs` etc. transitively. `historyIndex.ts` re-exports from the new file.
- D-S5-4: Per-hunk undo is a single inverse-toggle on the set — no need for `historyService.undoLatestTurnHunk` reconstruction in v0.2 because the in-memory `HunkSetState` already holds the truth. Cross-turn undo (rebase semantics) stays Phase β, gated by `claudeReview.history.crossTurnUndo`.
- D-S5-5: Undo is not yet emitted as a distinct `undo` event in the log (audit gap). Phase β Revisit emits explicit `undo` events with cascade tracking.

**Deviations:** none new; D-S5-1 documents an explicit choice to interpret the planning note's "reorg" loosely (additive new dir instead of rename).

**Tech Debt Introduced:**
- Audit gap for within-turn undo (D-S5-5) — minor; Phase β addresses.
- History panel doesn't show diff content yet, just metadata — full diff replay is Phase β Revisit.

**Next Session Should:**
1. **M9.4 — Agent Adapter + OpenCode** (L, Track 3). Wire format already mostly agent-agnostic; add `agentId` field + adapter dispatch + OpenCode bridge. Validate OpenCode hook protocol from current docs before writing the adapter.
2. **M9.5 — Transcript-Aware Chat** strictly after M9.4 (uses `ClaudeCodeAdapter.resolveTranscriptPath`).
3. **M9.6 — Sub-agent attribution** strictly after M9.5 (uses transcript reader).
4. **M9.7 — Phase α Release** at the end (perf bench + smoke test + tag v0.2.0).
5. Build the extension VSIX to manually smoke-test the History panel and undo button in a real VS Code session before tagging.

---

## 🚀 Phase 10 — Phase β.0: Actionable History
**Goal:** Promote History panel + Open Review Panel + status bar from "show what happened" to "resume what's unfinished." Build `reconstructSessionReview` as the keystone primitive every subsequent Revisit feature composes on. Fix the latent FR-B0.7 audit-integrity bug before reconstruction is exposed.
**Status:** [~] In Progress
**Estimated Effort:** L
**Phase Dependencies:** Phase 9 (M9.1, M9.2, M9.3 complete; M9.4/9.5/9.6 may land in parallel but β.0 lands first per architectural decision #1)

---

### 🏁 Milestone 10.1 — β.0 Bridge: Actionable History
**Status:** [~]
**Complexity:** L
**Acceptance Criteria:** All 12 acceptance tests (B0-1..B0-12) green; user-reported "no active session" dead-end unreachable from any of the five scenarios in PHASE-BETA-NEXT.md §6.0.1; existing 234 tests still green.
**Depends On:** none

#### ✅ Task 10.1.0 — FR-B0.7: emit `undo` events from in-session undo paths
- **Status:** [x]
- **Complexity:** M
- **Depends On:** none
- **Acceptance Criteria:** Per-hunk ↶ Undo (M9.2.9) and session-level ↶ Undo (Option A) each emit a structurally-valid `UndoEvent` into the history log with the correct scope, target.path, target.hunkIdx (when applicable), and SHA-256 postBlobs covering every affected file. `reconstructSessionReview` (lands in 10.1.3) can rely on `undo` events to anchor reverted state.
- **Files:** `src/types.ts`, `src/snapshotStore.ts`, `src/history/historyEvents.ts`, `src/history/historyService.ts`, `src/reviewOrchestrator.ts`, `tests/integration/orchestrator.undoAudit.test.ts`
- **Completed At:** 2026-05-18 02:50

  - [x] Subtask: Relax `UndoEventZ.target.srcEventId` to allow `-1` sentinel
  - [x] Subtask: Add `lastTurnId` to `SessionData`; retain on `endTurn`
  - [x] Subtask: `HistoryService.recordUndo(input)` writes post-blobs and emits `undo` event
  - [x] Subtask: `ReviewOrchestrator.recordUndoEvent` helper with currentTurnId→lastTurnId→sid fallback
  - [x] Subtask: Wire `handleUndoHunkDecision` to emit scope:'hunk'
  - [x] Subtask: Wire `handleUndoLastAction` to map `UndoSnapshot.scope` → event scope; carry hunkIdx on hunk-scope
  - [x] Subtask: Tests B0-11, B0-12 (per-hunk + bulk scopes; SHA-256 verification)

#### ⏳ Task 10.1.1 — Pure types in historyTypes.ts
- **Status:** [ ]
- **Complexity:** XS

#### ⏳ Task 10.1.2 — Index gains `hasOpenTurn` + `pendingHunkCount`
- **Status:** [ ]
- **Complexity:** S

#### ⏳ Task 10.1.3 — `HistoryService.reconstructSessionReview`
- **Status:** [ ]
- **Complexity:** L

#### ⏳ Task 10.1.4 — `ReviewOrchestrator.adoptReconstructed` + round-trip harness
- **Status:** [ ]
- **Complexity:** L

#### ⏳ Task 10.1.5 — `getPendingReviewsSummary()` with 1s cache
- **Status:** [ ]
- **Complexity:** S

#### ⏳ Task 10.1.9 — Gate `reDiff` through `lockFile`
- **Status:** [ ]
- **Complexity:** S

---

### Session 6 — 2026-05-18 02:50 (β.0 sub-task 10.1.0 — FR-B0.7 undo emission)
**Summary:** Closed the FR-B0.7 audit-integrity gap. Per-hunk Undo (M9.2.9) and session-level Undo (Option A) now emit `undo` events into the history log. Required for `reconstructSessionReview` (10.1.3) to anchor reverted state without replaying stale `hunk-decided` chains. 3 new tests; 234 → 237 green.

**Completed:**
- [x] **10.1.0** FR-B0.7: emit undo events from in-session undo paths (B0-11, B0-12)

**Files Changed:**
- `src/history/historyEvents.ts` — `UndoEventZ.target.srcEventId` accepts -1 sentinel for "infer from chronological replay"
- `src/types.ts` — `SessionData.lastTurnId: string | null` retains the closed turn id across `endTurn`
- `src/snapshotStore.ts` — `endTurn` sets `lastTurnId = currentTurnId` before clearing; `getOrCreateSession` initialises `lastTurnId: null`
- `src/history/historyService.ts` — `RecordUndoInput` + `recordUndo(input)`: blob-writes per path, emits `undo` event, fire-and-forget
- `src/reviewOrchestrator.ts` — `recordUndoEvent` helper (turnId fallback chain); `handleUndoHunkDecision` emits scope:'hunk'; `handleUndoLastAction` maps `UndoSnapshot.scope` → event scope ('hunk'/'file'/'turn'); `UndoSnapshot.hunkIdx` captured at action time
- `tests/integration/orchestrator.undoAudit.test.ts` — created (3 tests: B0-11 per-hunk, B0-12 file, B0-12 turn)

**Dependencies Added:** none

**Decisions:**
- D-S6-1: `srcEventId = -1` sentinel rather than threading the originating hunk-decided event id through the orchestrator. The in-session undo doesn't have a recorded srcEventId at emission time, and chronological replay during reconstruction can infer the target unambiguously.
- D-S6-2: `lastTurnId` on `SessionData` rather than holding a separate "post-Stop turn buffer" elsewhere. Single source of truth + survives across the orchestrator's `endTurn → openReview → user-Undo` lifecycle gap.
- D-S6-3: Captured `UndoSnapshot.hunkIdx` at action time instead of inferring it from per-hunk status diffs at undo time. Status-diff inference fails when multiple hunks were pending pre-action.
- D-S6-4: One `undo` event per Undo action (covering all affected files) rather than one per file. Matches the user's mental model (one ↶ click = one audit entry) and minimises blob writes.

**Deviations:** none from the plan

**Tech Debt Introduced:** none

**Next Session Should:**
1. **10.1.1** — Add `PendingReviewsSummary`, `ReconstructedSessionReview`, `FileDriftStatus` types to `historyTypes.ts` (pure, no Node imports)
2. **10.1.2** — Extend `SessionIndexEntry` with `hasOpenTurn` + `pendingHunkCount`; maintain in service
3. **10.1.3** — `HistoryService.reconstructSessionReview` (streaming replay + disk drift classification)
4. **10.1.4** — `ReviewOrchestrator.adoptReconstructed` + round-trip equivalence harness
5. **10.1.5** — `getPendingReviewsSummary()` with 1s cache
6. **10.1.9** — Gate `reDiff` through `lockFile` + race-fixture test

---

### Session (α-leftover Wave 2) — 2026-05-18 — M9.4a Adapter refactor (parallel worktree)
**Summary:** Extracted a clean `AgentAdapter` abstraction so the codebase is structurally multi-agent ready. Pure refactor — no behavioural delta from v0.2.

**Completed:**
- [x] Task 9.4a.1 — `src/adapters/agentAdapter.ts` (interface + Normalised* shapes + `AgentId` discriminated union)
- [x] Task 9.4a.2 — `src/adapters/claudeCodeAdapter.ts` (extracts Zod parse + tool-gate from `server.ts` and `buildEntry`/`routeFor` from `hookConfigurator.ts`)
- [x] Task 9.4a.3 — `src/adapters/index.ts` (read-only registry, `requireAdapter` helper)
- [x] Task 9.4a.4 — wired adapter through `server.ts` route handlers and `hookConfigurator.ensureHooksInstalled`
- [x] Task 9.4a.5 — `agentId: AgentId` on `SessionData` + `SessionReview`; propagated from `SnapshotStore.captureOriginal` → `ReviewOrchestrator.openReview`
- [x] Task 9.4a.6 — `tests/unit/adapter.claudeCode.test.ts` (16 tests: parse round-trip, malformed rejection, hook-config shape, scope validation, placeholder stubs, registry)

**Files Changed:**
- `src/adapters/agentAdapter.ts` — created
- `src/adapters/claudeCodeAdapter.ts` — created
- `src/adapters/index.ts` — created
- `src/server.ts` — route handlers delegate parse to adapter registry; raw payload re-parsed for back-compat callback signature
- `src/hookConfigurator.ts` — entry construction delegated to adapter; `buildEntry`/`routeFor`/`MATCHER`/`TIMEOUT_SEC` removed
- `src/types.ts` — `AgentId` exported; `agentId` field added to `SessionData` and `SessionReview`
- `src/snapshotStore.ts` — `captureOriginal` and `recordTouched` accept optional `agentId` (defaults `'claude-code'`); `getOrCreateSession` stores it
- `src/reviewOrchestrator.ts` — `openReview` propagates `sessionData.agentId` into the created `SessionReview`
- `src/extension.ts` — `onPreToolUse`/`onPostToolUse` dispatch through `agentAdapters.get('claude-code')` for normalisation
- `tests/unit/adapter.claudeCode.test.ts` — created (16 tests)
- `PROJECT_TRACKER.md` — Phase 9 section added; M9.4a closed; M9.4b marked deferred

**Dependencies Added:** none

**Decisions:**
- Server callback signatures stay typed `(PreToolUsePayload) => ...` rather than `(NormalisedPreToolUse) => ...` to keep the M1 server tests and the existing `extension.ts` handler shape unchanged. The adapter still owns parse — the route handler delegates to `adapter.parsePreToolUse(req.body)` for validation + tool-gate, then re-parses to satisfy the legacy callback type. When OpenCode lands (M9.4b) we'll lift callbacks to `Normalised*`.
- `SnapshotStore.captureOriginal` / `recordTouched` accept `agentId` as a defaulted optional rather than a required positional arg. Why: zero churn at every call-site (including tests and `mock-claude.ts`); the default `'claude-code'` is correct for every existing caller. Tradeoff: a future caller could silently default-tag an OpenCode event — acceptable risk now, fixable when M9.4b actually adds a non-Claude path.
- `parseStop` synthesises `cwd: ''` when the raw payload omits it (Claude Code's Stop event does). Wave-1's history layer resolves cwd via the snapshot store keyed on sessionId; an empty string here is the existing contract, just reified explicitly.
- M9.4b deferred (see entry above).

**Deviations:**
- Spec said 234 existing tests; this worktree's baseline is 189. Result is 189 → 189 (existing) + 16 (new adapter file). Likely the 234 figure included tests added by the parallel Wave-1 agent (`beta-zero-core`) — outside this scope.

**Tech Debt Introduced:**
- Server route handlers Zod-validate twice on the happy path (once inside the adapter, once on re-parse for the callback type). Cost is negligible (< 0.1 ms on these tiny payloads) but it's a wart. Will go away when callbacks are lifted to `Normalised*` (M9.4b or later).
- `HookConfigOpts.scope === 'user'` is declared but every adapter currently throws on it. Concrete user-scope writes are deferred.

**Next Session Should:**
1. Coordinate with `beta-zero-core` on Wave 1 merge (orchestrator/history); their `agentId` propagation should align with the field this wave added.
2. M9.4b (OpenCode adapter) — gated on OpenCode hook spec confirmation.
3. M9.5 — flesh out `resolveTranscriptPath` for Claude Code (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
4. M9.6 — `extractSubagentId` for Claude Code Task tool.

---

### Session (Live-Update Wave) — 2026-05-19 23:00 — History panel live refresh

**Summary:** Make the History panel and PendingStatusBar refresh automatically when new event-log writes happen while they're visible. Closes the user-reported gap: sessions started after the panel opens never appeared until manual reopen.

**Completed:**
- [x] HistoryService gains a multi-listener change emitter (`addChangeListener` → returns unsubscribe). Listeners fire after each successful `record*` and `deleteSession`. Disabled service short-circuits before emission; throwing listeners are caught and logged without breaking the write path.
- [x] All 7 emission sites wired: `recordTurnStarted`, `recordTurnStopped`, `recordHunkDecided`, `recordFileSnapshotReverted`, `recordUndo`, `recordTurnAborted`, `deleteSession`.
- [x] HistoryPanelManager subscribes in `openOrFocus`, debounces 300ms trailing-edge, re-posts `{type:'init', sessions, root}`. Unsubscribes + clears timer in `onDidDispose`.
- [x] PendingStatusBar subscribes via `extension.ts`; its existing internal debounce + 1s TTL cache on `getPendingReviewsSummary` absorb burst writes.
- [x] 12 new integration tests in `tests/integration/history.liveUpdate.test.ts` — per-method emission, disabled-service guard, multi-listener delivery, unsubscribe semantics, throwing-listener isolation, full lifecycle ordering.

**Files Changed:**
- `src/history/historyService.ts` — added `HistoryChangeKind` / `HistoryChangeInfo` / `HistoryChangeListener` exports, `listeners` Set, `addChangeListener` public method, `emitChange` private method, 7 emit-call wiring sites.
- `src/historyPanel.ts` — `PanelState` gained `unsubscribe?` + `refreshTimer?`; `openOrFocus` subscribes; `onDidDispose` cleans up; new private `scheduleSessionListRefresh` method; added `LIST_REFRESH_DEBOUNCE_MS = 300` constant.
- `src/extension.ts` — wired `history.addChangeListener` → `pendingStatusBar.scheduleRefresh` near construction; unsubscribe pushed to `context.subscriptions`.
- `tests/integration/history.liveUpdate.test.ts` — new (12 tests).
- `PROJECT_TRACKER.md` — this entry.

**Decisions:**
- Multi-listener Set, NOT the single-callback `onChange` pattern used by `ReviewOrchestrator`. History naturally has 2+ subscribers (panel + status bar + future).
- Trailing-edge 300ms debounce in the panel — absorbs Claude's 5–10-events-in-<50ms burst pattern; one post per turn rather than per write.
- SessionDetail does NOT auto-refresh when the currently-viewed session gets new events (user-locked scope decision). The list refreshes; details require a click. Smaller blast radius.
- Hunk diffs remain a Review-panel feature, not a History-panel feature (out of scope; deliberate).

**Deviations:** None.

**Tech Debt Introduced:**
- `handleDelete` in `historyPanel.ts:241` still does an explicit `listSessions → post(init)` for immediate UX feedback. The emitter would also trigger a debounced refresh ~300ms later. Idempotent (webview replaces the list), but the explicit re-emit could be removed in a future cleanup.

**Blockers:** None.

**Next Session Should:**
1. Manual dev-host verification: open History panel, run `claude` in a new terminal, observe new session card appears within ~300ms of Stop.
2. (Optional polish) Decide whether to remove the redundant explicit `init` re-emit in `handleDelete` now that the emitter handles it.
3. Consider extending live updates to the open SessionDetail in a future slice (currently a deliberate scope cut).

---

### Session (Auth-Token UX Wave) — 2026-05-19 23:55 — Stable token + 401 observability

**Summary:** Fix the structural UX failure where every extension reload broke every existing terminal. The token now persists across activations via OS keychain; the env var collection is persistent across reloads; the silent 401 path is now visible (warn log) and self-recovering (burst-detector toast with one-click "Open New Terminal").

**Completed:**
- [x] Swap `secrets.rotateBearerToken()` → `secrets.getOrCreateBearerToken()` at activation. The keychain-stored token is reused across reloads.
- [x] Set `environmentVariableCollection.persistent = true` so VS Code restores the env var on window reload (restored terminals stay aligned).
- [x] Drop the unconditional activation toast (was preemptive and inaccurate after the first install).
- [x] `server.ts` 401 path now emits `logger.warn('server', 'auth.failed', {...})` with length-only signals (never the token bytes), then invokes `opts.onAuthFailure?.()` wrapped in try/catch.
- [x] New `AuthFailureBurstDetector` (`src/authFailureBurstDetector.ts`): sliding-window detector (3 failures in 10s → toast; 60s cooldown). Toast offers `[Open New Terminal] [Show Logs] [Rotate Token]`.
- [x] Extension wires the detector into `startServer({ onAuthFailure })`; pushed to `context.subscriptions`.
- [x] `claudeReview.rotateBearerToken` command now ALSO updates `context.environmentVariableCollection` immediately (so new terminals get the new token) and offers `[Reload Window]` to restart the server with the new expected token.
- [x] 9 new unit tests for the burst detector (threshold, sliding window, cooldown, action dispatch, dismissal, dispose).
- [x] 3 new integration tests for the server's 401 path (log fires, callback invoked, callback throw doesn't 500).

**Files Changed:**
- `src/server.ts` — `ServerOptions.onAuthFailure?: () => void`; `onRequest` hook now logs `auth.failed` + invokes the callback (try/catch) before replying 401.
- `src/extension.ts` — activation: `getOrCreateBearerToken`, `persistent = true`, dropped activation toast; constructed `AuthFailureBurstDetector` and wired it into `startServer`; `rotateBearerToken` command now updates env collection and prompts for reload.
- `src/authFailureBurstDetector.ts` — **NEW**, ~150 LOC. Sliding-window burst detector with cooldown, test seams (`showToast`, `executeAction`, `now`).
- `tests/unit/authFailureBurstDetector.test.ts` — **NEW**, 9 tests.
- `tests/integration/server.test.ts` — extended with 3 tests for the new 401 observability path.
- `PROJECT_TRACKER.md` — this entry.

**Decisions:**
- Tier 1 (observability) + Tier 2 (stable token) shipped together. Tier 3 (file-based token for external terminals) and Tier 4 (socket-based auth) deferred.
- Burst threshold = 3 / window = 10s / cooldown = 60s — matches the PreToolUse + PostToolUse + Stop trio pattern that triggers on a single Claude turn.
- Toast offers rotation as third (not primary) action — rotation invalidates ALL terminals, so it's an escape hatch for suspected leaks, not the common-case recovery.
- Dropped the activation toast entirely. The burst detector is a strictly better signal — fires at the actual moment of failure, never spuriously.
- `auth.failed` log includes header presence + Bearer-prefix boolean + length-only signals. Never the token bytes themselves.

**Deviations:** None.

**Tech Debt Introduced:**
- Rotation still requires a window reload because the running server holds `expectedToken` as a captured Buffer at startup. A live-update mechanism (setter on the server handle) would remove the reload step but adds complexity. Kept as-is; rotation is rare.
- External-terminal support (Tier 3, file-based token resolution) deferred — Claude run from Windows Terminal / tmux outside VS Code still won't get the env var. Tracked but not in this slice.

**Blockers:** None.

**Next Session Should:**
1. Manual dev-host verification: keep an old terminal open across a reload, run `claude` in it, observe the toast appears after ~3 failed hooks with the three action buttons. Click `[Open New Terminal]` → hooks succeed in the new terminal.
2. Verify that after the first activation, subsequent reloads do NOT change the token (terminals from prior sessions stay valid).
3. Consider Tier 3 (file-based token) if external-terminal usage becomes a real user need.

---

### Session (Audit Cleanup Wave) — 2026-05-20 02:55 — 5-agent review actionables

**Summary:** Acted on the highest-leverage findings from a 5-agent (architecture, perf, security/reliability, test coverage, recent-changes) audit. Shipped one perf win, three reliability hardenings, a durable hook-config self-heal, three hygiene fixes, and three test-gap closures. Deferred index-write batching (largest perf opportunity but well below budget) and the orchestrator god-class split (churn for churn's sake).

**Completed:**
- [x] Parallelise per-event blob reads in `reconstructSessionReview` (turn-started, turn-stopped, undo handlers) via `Promise.all`. Saves ~200-400ms on Resume Review for typical 50-file sessions.
- [x] Async mutex (promise chain) around `HistoryIndexFile.update()` prevents read-then-write races between concurrent record* callers.
- [x] Per-event size guard in `HistoryWriter.append` — rejects events exceeding `MAX_SEGMENT_BYTES` instead of silently producing oversized segments.
- [x] Atomic write (tmp + rename) for `.gitignore` injection in `maybePromptGitignore`.
- [x] Replaced dynamic `require('node:path')` with static `import * as path from 'node:path'`; also `node:fs/promises` and `node:crypto` brought to top.
- [x] Deduplicated `AgentId` — `types.ts` is now the single source; `historyEvents.ts` and `adapters/agentAdapter.ts` import-and-re-export.
- [x] Path-traversal guard in `readWorkspaceFile` + `joinCwd` — escapes are logged and rejected (return null). `reconstructSessionReview` skips files that would escape `cwd`.
- [x] Durable hookConfigurator cleanup — strips legacy unmarked entries matching our `127.0.0.1:<port>/(pre|post|stop)-tool-use` URL pattern alongside the marker filter. Self-heals users upgraded from older extension versions (real field issue from 2026-05-19).
- [x] Extracted `rotateBearerTokenAndPromptReload` as testable function; unit tests verify env-collection propagation, reload prompt, dismissal handling.
- [x] Server integration test extended with `headerPrefix` short-header boundary case (header < 13 chars).
- [x] Live-update test extended with subscribe → debounce → unsubscribe lifecycle regression.
- [x] Legacy-cleanup tests for both `ensureHooksInstalled` and `removeHooks` paths, plus negative test confirming unrelated URLs aren't stripped.

**Files Changed:**
- `src/history/historyService.ts` — `Promise.all` blob batches in three event handlers; path-traversal guard via `joinCwd → string | null`; reconstruction skips path-escape files.
- `src/history/historyIndex.ts` — `writeLock` promise chain in `update()`.
- `src/history/historyEvents.ts` — replaced `AgentId` declaration with `import type` + `export type` from `types.ts`.
- `src/history/historyWriter.ts` — per-event size guard before segment-roll check.
- `src/adapters/agentAdapter.ts` — same re-export pattern as historyEvents.
- `src/hookConfigurator.ts` — `entryLooksLikeOurs` helper + `OUR_HOOK_URL_RE`; legacy cleanup filter in `ensureHooksInstalled` and `removeHooks`; `logger?` field on `HookConfigOptions`.
- `src/extension.ts` — static `path`/`fs`/`crypto` imports; replaced `require('node:path')` and `await import('node:path')` usages; atomic `.gitignore` write; `rotateBearerTokenAndPromptReload` exported helper; passes `logger` to `ensureHooksInstalled` callers.
- `tests/unit/rotateBearerToken.test.ts` — **NEW** (6 tests).
- `tests/unit/hookConfigurator.test.ts` — extended with 3 legacy-cleanup tests.
- `tests/integration/server.test.ts` — extended with `headerPrefix` boundary test.
- `tests/integration/history.liveUpdate.test.ts` — extended with subscribe → debounce → unsubscribe lifecycle test.
- `PROJECT_TRACKER.md` — this entry.

**Decisions:**
- Defer index-write batching: current P99 is ~643ms vs 4500ms budget; ~20-45ms saved per turn doesn't justify the atomicity/crash-safety complexity in this slice. Revisit if budget tightens.
- Defer ReviewOrchestrator god-class split: refactoring works that work is churn; file is large but well-tested.
- Hook cleanup self-heals on next activation rather than requiring an explicit user command. Logged via `hooks.legacy.stripped` for auditability.
- Path-traversal guard returns null + logs (matches existing ENOENT contract) rather than throwing — callers already handle null cleanly.
- Extracted `rotateBearerTokenAndPromptReload` exported function instead of testing through `vscode.commands.registerCommand` — minimal refactor, much better test ergonomics.

**Deviations:** None.

**Tech Debt Introduced:** None.

**Blockers:** None.

**Next Session Should:**
1. Manual dev-host verification: rebuild, reload, observe `hooks.legacy.stripped` Output log if any unmarked duplicates exist in `~/.claude/settings.json`. Verify clean hook execution.
2. Profile Resume Review on a session with ≥10 turns and ≥30 files — confirm the perceived improvement from parallel blob reads.
3. Consider an explicit `claudeReview.cleanupHooks` command for users who want to trigger the legacy sweep without waiting for the next activation. Low priority since activation already does it.
4. Index-write batching as a future perf slice if P99 climbs.

---

### Session (v0.3.0) — 2026-05-22 — Decision-Support Foundation
**Summary:** First wave of the decision-support pivot. Risk-flag triage on files and hunks, keyboard-driven review, split-cell scrollbar fix.

**Shipped:** v0.3.0 → marketplace + Open VSX (tag `v0.3.0`).

**Completed:**
- [x] **A1 — Risk flags:** heuristic file + hunk classification (sensitive-path, deletion, removed-error-handling, removed-null-check, large-hunk, lockfile, test-file). New module `src/riskFlagger.ts`; chips in FileList; badges on HunkBlock header; "N flagged" count in SessionHeader.
- [x] **A2 — Keyboard nav:** `j`/`k`/`Shift+J`/`Shift+K`/`a`/`r`/`?`/`Space`/`Esc`/`Shift+/`. Pure `webview/utils/keyboardNav.ts` helpers; help overlay component.
- [x] **A2.5 — Per-line scrollbar fix:** `.splitCell` `overflow-x: auto` → `overflow: hidden` with `title` tooltips on long lines.

**Files Changed:** ~700 LOC across `src/types.ts`, `src/riskFlagger.ts` (new), `src/reviewOrchestrator.ts`, `webview/components/{FlagChip,FlagBadges,KeyboardShortcutsHelp,FileList,HunkBlock,SessionHeader}.tsx`, `webview/utils/keyboardNav.ts` (new), `webview/App.tsx`, `webview/store.ts`, `webview/styles/*.module.css`, 2 new test files.

**Tests:** 409 / 409 (+51 new — risk-flag heuristics, keyboard-nav arithmetic).

**Patch (v0.3.1) — 2026-05-22:** Fix macOS CI flake in `getPendingReviewsSummary` test — clock-precision boundary made `lastEventAt === cutoff` non-deterministic. Switched test to `withinMs: -1` for unambiguous exclusion.

---

### Session (v0.4.0) — 2026-05-22 — Edit + Reject-with-feedback + Rename grouping
**Summary:** Closed two workflow gaps (the "third verb" for in-place editing, and the "rejection-reason capture" loop) plus cheap rename-aware grouping.

**Shipped:** v0.4.0 → marketplace + Open VSX (tag `v0.4.0`).

**Completed:**
- [x] **A4 — Edit-before-accept:** New `'edited'` HunkStatus; `HunkSetState.editedHunks` substitution map preserves set-based determinism; `hunk-edited` event kind; full reconstruction round-trip. Re-editable (per-hunk undo restores Claude's original).
- [x] **A5 — Reject-with-feedback:** `💬 Add reason` button after Reject; reasons accumulate in a collapsible drafts section inside ChatOverlay; "Send all to Claude" bundles into one consolidated prompt via existing chat surface. New `rejection-reason` event kind; drafts queue reconstructs on Resume.
- [x] **A8 (cheap) — Rename grouping:** Heuristic clusters hunks sharing a single-identifier rename (≥3 members, ≥3 char tokens) into `(oldToken, newToken)` groups. `↻ rename · N more` chip on each member; inline panel with Accept all / Reject all bulk actions.
- [x] **Polish:** show-flagged-only filter (file-level); wrap-long-lines toggle (split + unified diff); `claudeReview.crashRecoveryToast.enabled` default flipped to `false` (deprecation).

**Files Changed:** ~1700 LOC across `src/types.ts`, `src/reviewOrchestrator.ts`, `src/chatService.ts`, `src/renameGrouper.ts` (new), `src/messages.ts`, `src/history/*` (2 new event kinds), `webview/components/{HunkBlock,ChatOverlay,InlineExpandingPanel (new),FileList,SessionHeader}.tsx`, 6 new test files.

**Tests:** 439 / 439 (+30 new — edit round-trip, reason audit, rename groups, batch-feedback).

---

### Session (v0.5.0) — 2026-05-22 — TypeScript Build Signal
**Summary:** **Headline decision-support feature.** After every Claude turn, the workspace's `tsc --noEmit` runs in parallel with panel-open; affected files + hunks are annotated and surface as banner / dot / inline badge. Closes the "did Claude break the build?" question without a manual run.

**Status:** Packaged + ready to ship (committed `00daf15`, awaiting tag + push).

**Completed:**
- [x] **8 waves:** types + deps + config; tsc output parser (stream + one-shot); tsconfig resolver (composite/references detection); cross-spawn + tree-kill runner with AbortController + timeout; per-session lifecycle manager; orchestrator hooks (openReview / dismissSession); webview UI (banner, file dot, hunk badge, Shift+N / Shift+P nav); memory-leak guard; release prep.
- [x] **E1 experiment confirmed (2026-05-21):** Claude Code re-reads `settings.json` per hook fire — unblocks file-based-token route for v1.0.

**Files Changed:** ~1700 LOC across new `src/buildSignal/{tscParser,tsconfigResolver,tscRunner,buildSignalManager,intersectHunks}.ts`, new HostToWebview `build-signal` message kind, UI surfaces in HunkBlock/SessionHeader/FileList/App.tsx, 5 new test files.

**Dependencies added:** `cross-spawn@^7.0.6`, `tree-kill@^1.2.2`, `string-argv@^0.3.2`, `@types/cross-spawn`. All MIT, all license-audit pre-approved.

**Tests:** 506 / 506 (+67 new — parser, resolver, runner, intersect, manager lifecycle).

**Decisions:** TS-only this wave (test runners deferred to v0.6 to bypass user `scripts.test` arbitrary-code hazard). After-Stop trigger only (Resume/save/manual deferred). Auto-detect tsconfig with `claudeReview.buildSignal.typecheckCommand` user override.

---

### Session (v0.5.1) — 2026-05-23 — Reliability + UX hotfix patch
**Summary:** Three-agent senior-dev review of v0.3 / v0.4 / v0.5 produced 18 findings. 17 in-scope (1 deferred to v0.6). Single hotfix patch.

**Status:** Packaged + ready to ship (committed `00daf15` together with v0.5.0).

**Completed (6 waves):**
- [x] **Wave 1 (P0 reliability):** `dismissSession` clears `stopDebounce` + `reDiffTimers` (latent leak back to v0.1); `tscRunner.finish()` idempotent guard + explicit stdout/stderr listener removal.
- [x] **Wave 2 (P0):** Build-signal vs hunk-edit coord race fix — `BuildSignalManager.start()` captures per-file `{newStart, newLines}` snapshot; `intersectDiagnosticsWithHunks` consumes the snapshot. Honest semantic: results reflect file state at typecheck-time.
- [x] **Wave 3 (P0):** `InlineExpandingPanel` Esc `stopPropagation` (fixes double-close); new `TooltipPopover` component (React portal, viewport-flip, hover+focus, max-width 480, pre-wrap) — integrated at HunkBlock build-errors + SessionHeader fatalStderr.
- [x] **Wave 4 (P1):** `FileList` prop mutation removed; drafts duplication → minimal placeholder; `adoptReconstructed` fires `buildSignal.start` (Resume shows current build status); DIAG_RE 8 KB cap (adversarial-input safety); `React.memo` on SessionHeader (custom `areEqual`) + FileRow + HunkBlock — ~70% reduction in re-renders during typecheck-running window.
- [x] **Wave 5 (P2 maintainability):** New `src/shared/` directory (`riskFlags.shared.ts`, `hunkUtils.shared.ts`) — eliminates host→webview import drift hazard; `TscRunResult.kind` discriminator replaces magic exitCode numbers; `BuildErrorRef.isProjectLevel?: true` replaces sentinel pattern; README "New in v0.5" section; WCAG contrast tweak on `.buildDotRunning`; tree-kill PID security audit comment.
- [x] **Wave 6:** CHANGELOG `[0.5.1]` entry; `package.json` 0.5.0 → 0.5.1; `release:check` green; `.vsix` packaged.

**Tests:** 513 / 513 (+7 new — timer-cleanup integration, coord-race integration, tscRunner double-fire + listener-removal unit).

**Deferred to v0.6:** centralised config for magic numbers (`LARGE_HUNK_THRESHOLD`, `EDIT_BYTES_CAP`, `PROGRESS_THROTTLE_MS`, etc.) — needs telemetry first.

**Files Changed:** ~280 LOC across `src/reviewOrchestrator.ts`, `src/buildSignal/{tscRunner,buildSignalManager,intersectHunks,tscParser}.ts`, `src/types.ts`, `src/riskFlagger.ts`, new `src/shared/{riskFlags,hunkUtils}.shared.ts`, `src/buildSignal/buildSignalManager.ts`, `webview/components/{TooltipPopover (new),InlineExpandingPanel,HunkBlock,SessionHeader,FileList,ChatOverlay,FlagChip}.tsx`, `README.md`, `CHANGELOG.md`, 2 new test files.

**Next Session Should:**
1. **Push:** `git push origin main && git tag v0.5.1 && git push origin v0.5.1` (triggers marketplace + Open VSX dual-publish via `release.yml`).
2. **Monitor:** v0.5.1 marketplace listing within ~10 min; Day 0 / 3 / 7 user feedback per `docs/RELEASE.md`.
3. **Run E2 experiment** (1–2h) — survey common project shapes (package.json scripts, tsconfig, Cargo, pyproject, go.mod) to settle the test-runner command-detection heuristic. Gates v0.6 spec.
4. **Run V1 smoke tests** (Q-V1-1..6, 1–2h) — verify Claude Code's `type: "command"` hook support details on Windows. Gates v1.0 execution.
5. After E2: write the detailed v0.6 execution plan (multi-language build-signal + Insights panel).

---

### Session (v0.6.0 — A9 Insights) — 2026-05-26 — Insights tab (BUILT, uncommitted)
**Summary:** v0.6 **reprioritised** — A9 Insights leads; A7.5 multi-language build-signal + the E2 experiment **shelved** until a real non-TS user asks (per decision #58: optimize for the actual primary user, not hypothetical adoption). Insights tab built end-to-end and verified.

**Status:** Implemented + tested + builds clean. **Uncommitted.** No version bump / tag / push yet (awaiting user go).

**Completed (Waves 1–6 of the v0.6 plan):**
- [x] **Wave 1 — types:** `InsightsReport` + `FileRate`/`SubagentRate`/`TrendBucket`/`RejectionReasonGroup` in `src/types.ts` (webview-importable; `exactOptionalPropertyTypes`-clean).
- [x] **Wave 2 — aggregator:** new `src/insights/insightsAggregator.ts`. Pure `tallySession`/`buildReport`/`tallyInsights` (unit-testable) + `InsightsAggregator` I/O orchestrator. Raw-event scan via `readSessionStream` (NOT `reconstructSessionReview`); per-session memo keyed `sessionId:lastEventAt`. Undo-aware final-decision rates (resets via `scope` + `cascaded[]`); trend counts decision events by UTC day; `edited` its own terminal state; unattributed → `__main__` ("Main agent").
- [x] **Wave 3 — protocol:** `load-insights` (in) + `insights-report` / `insights-error` (out) in `src/messages.ts`.
- [x] **Wave 4 — host wiring:** `historyPanel.ts` — `load-insights` dispatch, lazy aggregator, gated 2 s-debounce live recompute (only after Insights tab opened), `insightsRefreshTimer` cleanup on dispose.
- [x] **Wave 5 — webview:** new `webview/history/components/Insights.tsx` (4 sections, CSS bars, empty states, inline styles); tab bar + conditional render in `webview/history/App.tsx`; lazy request on first tab switch.
- [x] **Wave 6 — tests:** `tests/unit/insightsAggregator.test.ts` (12) + `tests/integration/insightsAggregator.test.ts` (3) — all green.

**Deferred:** Wave 7 (#13 magic-number centralisation) — orthogonal cross-codebase refactor; deferred to keep this change focused/revertable (decision #159). Wave 8 (release) — not run; awaiting user.

**Tests:** new insights tests 15/15 green; typecheck (host + webview) clean; `npm run build` produces both bundles incl. history. NOTE: full-suite parallel run shows the **pre-existing** Windows fs-cleanup/clock flakes (different orchestrator/history integration files fail on each run; all pass in isolation) — not a regression from this additive work.

**Files Changed:** `src/types.ts`, `src/messages.ts`, `src/historyPanel.ts`, new `src/insights/insightsAggregator.ts`, `webview/history/App.tsx`, new `webview/history/components/Insights.tsx`, `CHANGELOG.md` (`[Unreleased]`), 2 new test files. Plan appended to `~/.claude/plans/phase-alpha-immediate-md-new-cosmic-pearl.md` (§ v0.6.0).

**Also pending (separate):** v0.5.2 chat-error fix (`webview/store.ts` — `setChatError` now clears `chatId` so the composer unlocks after a rate-limit/error). Uncommitted; ships independently.

**Next Session Should:**
1. Decide release shape: ship **v0.5.2** (chat fix) and **v0.6.0** (Insights) — separate tags, or bundle.
2. `npm run release:check` (note the flaky full-suite; re-run or run integration files serially to get a clean pass).
3. Manual E2E: open History → Insights tab → 4 sections render; run a turn + accept/reject → live recompute after ~2 s.
4. Version bump + CHANGELOG promote `[Unreleased]` → `[0.6.0]` + tag + push.

---

### Session (v0.6.1 — Optimization wave) — 2026-05-26 — derive-once / ship-deltas (BUILT, uncommitted)
**Summary:** 6-agent module-by-module review (orchestration, build-signal, history+insights, server/chat, webview, bridge) surfaced ~12 optimization findings + 2 correctness bugs, all converging on one anti-pattern: recomputing/re-shipping derivable-or-stable data. 4 P0s verified against code before acting. Shipped as a **v0.6.1 patch** (perf + 2 bug fixes; no new feature).

**Status:** All 6 waves implemented + tested. **Uncommitted** (17 modified files + 1 new test). No version bump / tag / push.

**Completed:**
- [x] **Wave 1 (hot-path latency):** transcript tail-read (8 MB cap, fixes chat hang) + 1.5 s timeout→hunk-only fallback (`transcriptReader.ts`, `chatService.ts`); `memo(DiffPane)` + `useMemo(focused)` + narrowed `HunkBlock` prop to `renameGroups` (kills build-signal re-render storm); `ChatOverlay` streaming as `<pre>`, markdown on finalise only (no O(n²)); `SessionHeader.flaggedCount` memoised.
- [x] **Wave 2 (bridge):** `openOrFocus` re-init gated on session-ref change; `collapseFileUpdates` dedup per filePath in the flush batch; per-panel listeners disposed in `onDispose` (leak fix).
- [x] **Wave 3 (history I/O):** in-memory pending invalidation (no per-hunk index fsync); `totalHunkCount` cached on the index entry → `computePendingAndTotal` fast path does zero segment I/O; `Promise.all` blob writes (turn-started/stopped/undo); `BlobStore.write` in-process `Set<sha>` dedup, dropped the pre-write `stat`.
- [x] **Wave 4 (orchestrator):** `bytesSnapshotted` computed once + threaded into `recomputeMetrics`; O(1) prior-decision merge via a `priorByPath` Map; risk-flags carried over for `hunksAlignedShallow` hunks (skip `flagHunk` on continuation Stops).
- [x] **Wave 5 (subsystem):** `extractSubagentId` mtime-based cache invalidation (fixes mid-session sub-agent mis-attribution) + serves cached on transient read failure; `resolveCredential` positive-result TTL cache (30 s); build-signal `ResolvedTsConfig` mtime cache. (5.4 single-pass counts skipped — minor.)
- [x] **Wave 6 (tests):** new transcript tail-bound unit tests; `adapter.subagentMtime` regression test; adjusted `subagent.test` (cached attribution survives transient read failure). CHANGELOG `[Unreleased]` written.

**Deliberately NOT done:** history index-write batching (excluded per scope; risk > reward, decision #37). coordSnapshot deferral skipped (would weaken the LH2 start-time-pinning guarantee for only a rare no-tsconfig allocation).

**Tests:** **532/532 green run serially** (`npx vitest run --no-file-parallelism`). typecheck (host+webview) clean; lint 0 errors; both bundles build. Parallel run still flaky on the pre-existing Windows fs-cleanup race — not a regression.

**Files Changed:** `src/{transcript/transcriptReader,chatService,reviewPanel,reviewOrchestrator,extension,adapters/claudeCodeAdapter}.ts`, `src/history/{historyService,historyTypes,historyBlobs}.ts`, `src/buildSignal/buildSignalManager.ts`, `webview/{App,components/DiffPane,components/HunkBlock,components/ChatOverlay,components/SessionHeader}.tsx`, `tests/unit/transcriptReader.test.ts`, new `tests/integration/adapter.subagentMtime.test.ts`, `CHANGELOG.md`. Plan appended to `~/.claude/plans/...cosmic-pearl.md` § "v0.6.1 Optimization Wave".

**Next Session Should:**
1. Manual E2E: chat on a huge-transcript session → first token < ~1.5 s (no hang); scroll the focused diff during a tsc run → no jank; rapid accept of 10 hunks → status bar updates without churn.
2. Version bump 0.6.0 → **0.6.1**; promote CHANGELOG `[Unreleased]` → `[0.6.1]`; commit; tag `v0.6.1`; push (tag push triggers release.yml — run tests serially first; the CI gate may flake on the Windows race only locally, Linux CI should be clean).
