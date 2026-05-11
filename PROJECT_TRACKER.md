# 📁 PROJECT_TRACKER.md
> Auto-maintained by Claude Code. Do not edit manually.

---

## 📊 Stats
| Metric | Value |
|---|---|
| Total Phases | 9 |
| Total Milestones | 9 |
| Total Tasks | 47 |
| Total Subtasks | 132 |
| Completed Tasks | 44 |
| In Progress | 1 (M8.1.7 — user actions) |
| Completion | 94% |
| Last Updated | 2026-05-11 03:00 |
| Active Phase | Phase 8 — GA Release |
| Active Milestone | M8 — GA (code complete; awaiting user-action items) |
| Tests Passing | 173 / 173 (17 files) |
| Perf bench (post-optimisation) | median **363 ms** / p99 **461 ms** (was 630/814 — TRD §15 budget 1500) |
| Perf bench (Stop→init, 50 files) | median 630 ms / p99 814 ms (budget 1500 ms) |
| Memory leak (50 sessions) | ΔRSS ≈ 0 (budget 50 MB) |
| Bundle Size (extension) | 1.3 MB minified (incl. Anthropic SDK) |
| Bundle Size (webview) | 339 KB JS + 10.4 KB CSS |
| Auth Methods | OAuth (Pro/Max) via env / SecretStorage / Claude Code's `.credentials.json`; API key fallback |

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
- Update `package.json` `publisher` field to the real publisher id (currently placeholder `claude-code-tools`)
- Push the repo to GitHub (the prior `gh repo create` / `git push` flow)
- Cut the first tag (`npm version 0.1.0` → `git push origin v0.1.0`) — release workflow auto-publishes
- Pick a telemetry backend per `docs/METRICS.md` §2, wire the connection string
- (Pre-1.0 polish) Design a 128×128 PNG icon; add `"icon": "icon.png"` to manifest

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
