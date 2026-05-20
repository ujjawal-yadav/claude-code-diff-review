# QA Checklist — Claude Code Diff Review

Run before each beta cycle. **Every item must pass before publishing.** Tick boxes inline; failures block release.

---

## A. Install & first activation

- [ ] **Fresh-install path.** Uninstall any prior copy of the extension. Run `code --install-extension claude-code-diff-review-<version>.vsix`. Reload VS Code. **Expect:** Extensions panel shows the extension as enabled.
- [ ] **Activation timing.** Open the **Claude Code Review** Output channel. Reload window. **Expect:** `activate.start` and `activate.done` log entries within ~2 s of each other on a baseline machine.
- [ ] **Onboarding prompt.** On a workspace with no credentials configured, the first-run notification appears with four buttons: **Set OAuth Token**, **Set API Key**, **Use claude /login**, **Dismiss**. Subsequent reloads do **not** re-prompt.
- [ ] **No env-var bleed.** Open a new integrated terminal. `$env:CLAUDE_REVIEW_TOKEN.Length` (PowerShell) or `echo ${#CLAUDE_REVIEW_TOKEN}` (bash) returns `64`.

## B. Hook configuration

- [ ] **First-run hook write.** Open a fresh workspace. Reload. **Expect:** `<workspace>/.claude/settings.json` exists with three entries (`PreToolUse`, `PostToolUse`, `Stop`), each carrying `"x-claude-review-extension": "v1"`. The bearer is `Bearer $CLAUDE_REVIEW_TOKEN`, not plaintext.
- [ ] **Idempotent re-run.** Reload twice in a row. **Expect:** still three entries, no duplicates.
- [ ] **User-hook preservation.** Manually add an unrelated hook entry (no marker) to `.claude/settings.json`. Reload. **Expect:** the user entry is still present alongside the extension's entries.
- [ ] **Hook removal.** Run **Claude Review: Remove Hooks**. **Expect:** only marked entries removed; user entries preserved; if no entries remain, the `hooks` block is dropped entirely.
- [ ] **Malformed JSON refuses to overwrite.** Corrupt the file (e.g., remove a closing brace). Reload. **Expect:** error toast, file untouched, reload-window-and-fix banner.

## C. Loopback server

- [ ] **Bind address.** `netstat -ano | findstr 53117` (or whatever port the Output channel reports). **Expect:** state `LISTENING` on `127.0.0.1`. Should **not** appear on `0.0.0.0` or any external IP.
- [ ] **Auth: missing header.** `Invoke-WebRequest http://127.0.0.1:53117/stop -Method POST -Body '{}' -ContentType application/json`. **Expect:** HTTP 401.
- [ ] **Auth: wrong token.** Send with a wrong bearer. **Expect:** HTTP 401.
- [ ] **Auth: correct token.** With the live token: 200.
- [ ] **Health.** `GET /health` with valid bearer returns `{ ok: true, version }`.
- [ ] **Body limit.** Post a >10 MB body. **Expect:** HTTP 413 / 400 *or* connection reset; handler is **not** invoked (verified via Output channel).

## D. Per-hunk review flow

Run a real Claude session: edit a file with at least 2 distinct hunks. Review the panel.

- [ ] **Panel auto-opens.** Within ~1.5 s of Claude finishing the turn.
- [ ] **Header.** Shows session id (truncated), file count, hunk count, last assistant message banner.
- [ ] **File list.** Every touched file appears with status dot (orange = pending), file path, and pending-hunk pill.
- [ ] **Diff view.** Split view shows BEFORE | AFTER columns; lines colored correctly.
- [ ] **View toggle.** Click `Split view` ↔ unified. Layout switches without losing scroll.
- [ ] **Sidebar resize.** Drag the splitter; sidebar resizes within [160, 600] px. Double-click resets. Width persists across panel reload.
- [ ] **Per-hunk Accept.** Click ✓ Accept. **Expect:** hunk badge → "✓ accepted"; on-disk content unchanged; CodeLens above the hunk in the editor switches to a read-only "✓ accepted" badge.
- [ ] **Per-hunk Reject.** Click ✗ Reject on a different hunk. **Expect:** that hunk's reverse patch applied to disk *only*; other hunks untouched (verify via `git diff` in a git workspace, or by manual inspection).
- [ ] **Decided idempotency.** Click Accept on an already-accepted hunk. No state change; no log spam.
- [ ] **Bulk accept.** Click `Accept all`. All pending hunks → accepted in one update.
- [ ] **Bulk reject (fast path).** Open a new session. Click `Reject all`. **Expect:** exactly one `fs.writeFile` per file (verify via `[orchestrator] write` log entries) restoring the captured `before` content.

## E. Per-file actions

- [ ] **`✓ File`** marks every pending hunk in that file as accepted.
- [ ] **`✗ File`** rejects every pending hunk in that file (drift fast-path if all-pending).

## F. CodeLens

- [ ] **Lazy registration.** Before any session opens, no CodeLenses appear in editors.
- [ ] **Accept/Reject lenses appear.** Open a file in the active session; `✓ Accept` and `✗ Reject` show above each hunk.
- [ ] **CodeLens click.** Mirrors the panel button: state updates everywhere; the lens flips to a read-only badge.
- [ ] **Decided badge.** After a decision, `✓ accepted` / `✗ rejected` badge replaces both lenses.

## G. SCM panel

- [ ] **Source Control tab populated.** Four resource groups (`Pending` / `Partially reviewed` / `Rejected` / `Accepted`).
- [ ] **Click resource.** Focuses the review panel.
- [ ] **Decoration: rejected** files show with strike-through; accepted with faded text.

## H. Chat (💬 Ask)

- [ ] **Auth gating.** With **no** credential resolvable, click 💬 Ask → chat overlay opens → submit a message → **expect:** auth-help panel renders inline with three buttons (Set OAuth, Set API key, Probe & report).
- [ ] **Happy path.** With Pro/Max OAuth resolvable from `~/.claude/.credentials.json`, click 💬 Ask, type "should I accept?". Streamed response arrives within ~1.5 s.
- [ ] **Cancel.** Click `Cancel` mid-stream. **Expect:** `chat-error { kind: 'cancelled' }`; panel error banner.
- [ ] **Quick actions.** `✓ Accept hunk` / `✗ Reject hunk` from the chat overlay perform the same action as the panel buttons.
- [ ] **Multi-turn.** Send two messages in the same chat. Both responses preserved in transcript.
- [ ] **Close-while-streaming.** Cancel via the X button. Stream aborts; panel still usable.
- [ ] **API key never crosses postMessage.** With chat overlay open and DevTools network panel inspecting the webview: **expect zero requests to `api.anthropic.com` from the webview**. All traffic comes from the extension host.

## I. External edits & drift

- [ ] **External save → re-diff.** While review panel open, manually edit a file and save. **Expect:** within ~200 ms the file's diff refreshes; `external-edit` banner appears.
- [ ] **Fuzz fail recovery.** Run a formatter (e.g. `prettier --write`) on a file with pending hunks while review is open. Try to reject a hunk. **Expect:** banner with `Could not cleanly revert a hunk` + `Revert file to original snapshot` button. Click → entire file reverts to captured `before`; all pending hunks marked rejected.

## J. Resize / layout edge cases

- [ ] **Narrow window.** Reduce VS Code width to ~600 px. Sidebar caps at min width; diff pane scrolls horizontally inside its column without overflowing the layout.
- [ ] **Theme switching.** Toggle `Workbench: Toggle Light/Dark Theme`. Panel restyles instantly via VS Code theme tokens.
- [ ] **High-contrast theme.** Switch to a high-contrast theme. All text legible; focus rings visible.

## K. Error surfacing

- [ ] **Read-only file write.** Mark a tracked file read-only. Reject a hunk in it. **Expect:** `write-failed` banner with `Revert file to original snapshot` button. Hunk stays pending.
- [ ] **Retry after fix.** Restore write permission. Reject again. **Expect:** banner clears, hunk → rejected.

## L. Activation & lifecycle

- [ ] **Reload during review.** Reload the dev host while a review is open with pending hunks. After reload, panel state is gone (v1 doesn't persist mid-review state).
- [ ] **Deactivate cleanly.** Close VS Code. **Expect:** no orphaned Node process listening on the loopback port (`netstat | findstr 53117` returns empty).
- [ ] **Bearer rotation across activations.** Reload. The new activation's bearer differs from the prior. Hooks fire correctly post-reload.

## M. Build & release

- [ ] `npm test` — 173/173 (or current count) green.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — no errors.
- [ ] `npm run audit:licenses` — every production package on the allow-list.
- [ ] `npm run audit:sbom` — produces `dist/sbom.cdx.json`.
- [ ] `npm run package` — produces `claude-code-diff-review-<version>.vsix` ≤ 5 MB.
- [ ] **Install the produced VSIX in a non-dev VS Code window** (`code --install-extension <path>`). Activate against a real workspace. Smoke-test items A, B, D.

## N. Telemetry

- [ ] **Off by default.** With `claudeReview.telemetry: "off"`: no `telemetry.*` events in the Output channel.
- [ ] **On + global on.** Set `claudeReview.telemetry: "on"` AND ensure `Telemetry: Telemetry Level` ≠ `off`. Trigger a review. **Expect:** `extension.activated`, `review.opened`, `hunk.action` events log within 10 s (batched flush).
- [ ] **Global off wins.** Set telemetry "on" but VS Code global = "off". **Expect:** no events.
- [ ] **PII scrubbed.** Inspect any logged event payload. **Expect:** no `apiKey`, no `filePath`, no message content.

## O. History panel (v0.2)

- [ ] **Opens with sessions.** Run **Claude Review: Open History Panel** with at least 2 past sessions in the event log. **Expect:** left list shows both, sorted newest-first.
- [ ] **Selection populates detail.** Click a session. **Expect:** right pane shows session id, agent, status, started/last-event timestamps, turn timeline with file counts.
- [ ] **Resume Review.** Click **Resume Review** on a session with pending hunks. **Expect:** review panel opens with the prior accept/reject state preserved (decided hunks render with their badge, not as pending).
- [ ] **Resume — already-live focus.** Open the review panel for a live session, then open the history panel and click Resume on the same session. **Expect:** panel just focuses (no reconstruction churn).
- [ ] **Rollback this turn.** On a session with at least one file, click **Rollback this turn**. **Expect:** modal confirm appears; on accept, every file in the session is restored to its pre-edit content on disk; `file-snapshot-reverted` events are appended.
- [ ] **Delete from history.** Click **Delete from history**. **Expect:** modal confirm; on accept, the session disappears from the list and its segments + unreferenced blobs are removed from `~/.claude/review-history/<workspaceHash>/`.
- [ ] **Pending-count badge.** Sessions with pending hunks show a `N pending` badge on the card. Decided sessions show none.

## P. Live updates (v0.2)

- [ ] **New session appears.** With the history panel open, run a new `claude` session that finishes a turn. **Expect:** a new card appears in the left list within ~300 ms of Stop, without reopening the panel.
- [ ] **Pending status bar updates live.** With at least one in-flight hunk decision, observe the `↶ N pending` status bar item update count as you Accept / Reject hunks.
- [ ] **Selection preserved across refresh.** Click a session in the list; trigger a record (e.g., make a hunk decision via the review panel). **Expect:** the detail pane stays on the selected session; doesn't snap back to the list.

## Q. Sub-agent attribution (v0.2)

- [ ] **Chip renders.** Run a Claude session where the assistant uses the `Task` tool to delegate editing one or more files. **Expect:** the review panel's file list shows `via Task: <description>` chip (truncated to 32 chars) on every file edited inside the Task call.
- [ ] **Tooltip + hunk header.** Hover the chip. **Expect:** full sub-agent description tooltip. The hunk header carries the same tooltip via `title=`.
- [ ] **History panel label.** Open the history panel for the same session. **Expect:** the affected files show a `· via Task: <description>` inline label next to the file path.
- [ ] **No false positives.** Run a non-Task session. **Expect:** no chip rendered (files show no `via Task` label).
- [ ] **Survives reconstruction.** Resume the same session. **Expect:** the chip is still present (sub-agent attribution is event-log-persisted).

## R. Transcript-aware chat (v0.2)

- [ ] **Citation present.** Ask a non-obvious question on a hunk via `💬 Ask Claude`. **Expect:** the streaming response references the user's original prompt or Claude's prior tool calls (verifiable by reading the response).
- [ ] **Toggle off.** Set `claudeReview.chat.transcriptContext: false`. Re-ask the same question. **Expect:** response is hunk-only; no citations of the user's prompt.
- [ ] **Missing transcript graceful.** Delete `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` for the active session. Ask a hunk question. **Expect:** chat completes successfully; no transcript citations; no error.
- [ ] **Security: no transcript bytes cross to webview.** Open DevTools on the review panel webview (Developer: Open Webview Developer Tools). Filter network for `postMessage`. Make a chat query with a known unique string in the transcript. **Expect:** the string does NOT appear in any host→webview message.

## S. Auth recovery (v0.2)

- [ ] **Burst-detector toast fires.** Open a terminal BEFORE the extension activates (i.e., open one then reload the dev host). Run `claude` and make 3 edits in a row. **Expect:** within ~10 s of the 3rd 401, a warning toast appears: "hooks are returning 401" with `[Open New Terminal]`, `[Show Logs]`, `[Rotate Token]` actions.
- [ ] **Open New Terminal works.** Click `[Open New Terminal]`. **Expect:** a fresh terminal spawns; running `claude` in it succeeds against the hooks (no 401).
- [ ] **Show Logs works.** Click `[Show Logs]`. **Expect:** the Output channel for Claude Code Review opens.
- [ ] **Rotate Token works.** Click `[Rotate Token]`. **Expect:** secondary toast appears prompting `[Reload Window]`; after reload, the new token is active.
- [ ] **Cooldown holds.** Trigger another burst within 60 s of the first toast. **Expect:** NO additional toast (cooldown active). After 60 s, a new burst re-fires the toast.
- [ ] **`auth.failed` log entries.** Open the Output channel after a burst. **Expect:** warn-level entries with `route`, `hadHeader`, `headerLooksLikeBearer`, `suppliedLen`, `expectedLen`, `headerPrefix` (first 13 chars). Token bytes are NOT logged.

## T. Hook self-heal (v0.2)

- [ ] **Legacy entry stripped on activation.** Manually add an unmarked HTTP hook entry to `~/.claude/settings.json` whose URL matches `http://127.0.0.1:<port>/(pre|post|stop)-tool-use`. Reload. **Expect:** Output channel shows `hooks.legacy.stripped { count: 1 }` (or higher); the entry is gone from settings.json; our marked entry remains.
- [ ] **Unrelated URLs preserved.** Add an unmarked hook entry pointing at a DIFFERENT URL (e.g., `http://127.0.0.1:9999/my-hook`). Reload. **Expect:** the entry is still present.
- [ ] **Persistent token survives reload.** Restart VS Code without closing the terminal. Run `claude` in the same terminal. **Expect:** hooks succeed without 401 (terminal's env var matches the still-valid keychain token).

---

## Sign-off

| Tester | Date | Build | All checks pass? |
|---|---|---|---|
| | | | |
