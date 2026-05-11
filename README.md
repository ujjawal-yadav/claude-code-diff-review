# Claude Code Diff Review

[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/claude-code-tools.claude-code-diff-review?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=claude-code-tools.claude-code-diff-review)
[![Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/claude-code-tools.claude-code-diff-review)](https://marketplace.visualstudio.com/items?itemName=claude-code-tools.claude-code-diff-review)
[![Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/claude-code-tools.claude-code-diff-review)](https://marketplace.visualstudio.com/items?itemName=claude-code-tools.claude-code-diff-review&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> Per-hunk review of every change Claude Code makes. Accept, reject, or ask "why?" — without leaving VS Code, and without touching git.

Claude Code can autonomously edit dozens of files in a single session. This extension surfaces every change as a session-aware review panel with **per-hunk Accept / Reject / Ask Claude** controls. No git required.

---

## Highlights

- **Session-aware review** — every file Claude touched in one turn, grouped together.
- **Per-hunk granularity** — accept one refactor, reject an unrelated formatting change in the same file.
- **In-context AI chat** — click 💬 Ask on any hunk; chat streams in a side panel scoped to that hunk.
- **Pro / Max plan support** — uses your `claude /login` OAuth credentials automatically. API key still supported for those who have one.
- **Source Control integration** — files appear in a dedicated SCM panel grouped by review status.
- **CodeLens gutter buttons** — Accept / Reject directly above each hunk in the editor.
- **Resilient** — per-file mutex on actions, fuzz-tolerant hunk revert with snapshot fallback, drift detection on external edits.

---

## Setup

### 1. Install
Install the extension from the VS Code Marketplace.

### 2. Open a workspace
Open the project folder you want Claude to edit. The extension writes its hooks to `<workspace>/.claude/settings.json` automatically.

### 3. Authenticate Claude
Three options, in resolution order:

| Method | When to use | How |
|---|---|---|
| **Claude Pro / Max OAuth** *(recommended)* | You signed in with `claude /login` | Already done — the extension reads `~/.claude/.credentials.json` automatically |
| **OAuth token paste** | You have a `sk-ant-oat01-…` token | Command palette → **Claude Review: Set Claude OAuth Token (Max plan)** |
| **Anthropic API key** | You have a `sk-ant-api03-…` key | Command palette → **Claude Review: Set Anthropic API Key** |

Verify which auth path the extension picked: **Claude Review: Use Claude Code Auth** prints the active source as a toast (without revealing the token).

### 4. Run a Claude session
Open the integrated terminal in your workspace and run:
```
claude
```
Ask Claude to make some edits. When it finishes the turn, the review panel opens automatically.

---

## Daily flow

1. Claude finishes a turn → **review panel opens** in a new editor tab.
2. **File list** on the left shows every file touched, color-coded by status.
3. **Diff pane** on the right shows split or unified view. Each hunk has three buttons:
   - **✓ Accept** — keep the change, mark the hunk reviewed
   - **✗ Reject** — revert *just that hunk* on disk, mark reviewed
   - **💬 Ask** — open chat scoped to the hunk
4. **CodeLens** above each hunk in the underlying editor mirrors Accept / Reject.
5. **Status bar** shows total pending hunks across all sessions.

Bulk: per-file `✓ File` / `✗ File` and per-session `Accept all` / `Reject all` in the panel header. Bulk-reject takes a fast path that writes the captured original snapshot in one disk write.

---

## Configuration

| Setting | Default | What |
|---|---|---|
| `claudeReview.port` | `53117` | Loopback port for the hook server. `0` = always dynamic. |
| `claudeReview.autoOpenPanel` | `true` | Open the panel on Stop hook. |
| `claudeReview.defaultDiffView` | `"split"` | Initial diff view (`"split"` or `"unified"`). |
| `claudeReview.chatModel` | `"claude-haiku-4-5-20251001"` | Model used for hunk chat. Override for deeper review (e.g. `"claude-sonnet-4-6"`). |
| `claudeReview.chatMaxTokens` | `2048` | Max output tokens per chat response. |
| `claudeReview.maxSessionBytes` | `52428800` | Per-session snapshot byte cap (50 MB). |
| `claudeReview.maxFilesPerSession` | `200` | Per-session file count cap. |
| `claudeReview.telemetry` | `"off"` | Opt in to anonymous usage telemetry. Also gated by VS Code's global telemetry setting. |
| `claudeReview.logLevel` | `"info"` | Output channel verbosity. |

---

## Commands

| Command | What |
|---|---|
| Claude Review: Open Review Panel | Bring the most recent session's panel to the front |
| Claude Review: Use Claude Code Auth | Probe credentials and report which source is active |
| Claude Review: Set Anthropic API Key | Store an API key in OS keychain |
| Claude Review: Set Claude OAuth Token (Max plan) | Store an OAuth token directly |
| Claude Review: Clear Anthropic API Key | Remove the stored API key |
| Claude Review: Clear Claude OAuth Token | Remove the stored OAuth token |
| Claude Review: Remove Hooks | Strip the extension's entries from `.claude/settings.json` |
| Claude Review: Rotate Bearer Token | Force a new bearer for the local hook server (reload window after) |
| Claude Review: Show Log | Open the structured Output Channel |

---

## Troubleshooting

### Stop hook returns 401
**Cause:** the integrated terminal predates the extension's activation, so it doesn't have `CLAUDE_REVIEW_TOKEN` in its environment.

**Fix:**
1. `Developer: Reload Window`
2. Close every existing integrated terminal
3. Open a fresh terminal and re-run `claude`

Verify by running `$env:CLAUDE_REVIEW_TOKEN.Length` (PowerShell) or `echo ${#CLAUDE_REVIEW_TOKEN}` (bash). Expect `64`.

### Review panel is blank
Open the webview's DevTools: command palette → **Developer: Open Webview Developer Tools** → Console tab. Any unhandled error renders inside the panel via the built-in `<ErrorBoundary>`. If it's blank with no error, the React tree may have un-mounted; reload the window.

### "Extension host did not start under 10 seconds"
On slower machines the activation may flirt with VS Code's 10 s timeout. The extension externalises the Anthropic SDK and defers the hook-config write to keep activation fast (~1–2 s typical). If you still hit this, file an issue with the **Output → Claude Code Review** panel contents.

### Chat says "No Claude credential found"
Run **Claude Review: Use Claude Code Auth**. It prints which source the resolver picked, or a warning if none matched. Resolution order:
1. `CLAUDE_CODE_OAUTH_TOKEN` env var
2. `CLAUDE_REVIEW_OAUTH_TOKEN` env var
3. SecretStorage OAuth (set via the command)
4. `~/.claude/.credentials.json` (the file `claude /login` creates)
5. SecretStorage API key

### Reject says "Could not cleanly revert a hunk"
A formatter (or another tool) ran after Claude's edit and the post-edit content has drifted too far for jsdiff's `fuzzFactor: 2`. The banner offers a **Revert file to original snapshot** button — that writes the captured `before` content back in one disk write.

### Port `53117` already in use
The server falls back to an OS-assigned dynamic port automatically and rewrites the hook URL accordingly. Check the **Output → Claude Code Review** panel for the actual port. To force a fixed port, set `claudeReview.port` to a number that's free.

---

## Known limitations

- **Single workspace folder.** Multi-root workspaces use the first folder for `.claude/settings.json` and history. v1.1 may shard.
- **Remote / SSH / Dev Container / WSL.** v1.0 is local-only. The hook server binds to `127.0.0.1`; remote development needs the server to live in the remote host. Out of scope for v1.0.
- **Claude Code version.** Requires Claude Code ≥ 2.1.47 for `last_assistant_message` and `stop_hook_active` fields in the Stop hook payload.
- **Sub-agent attribution.** Claude Code sub-agents share the parent session ID; per-sub-agent attribution requires JSONL transcript parsing. Planned for v1.1.
- **Localisation.** English only in v1.0.

---

## Privacy & security

- **API keys / OAuth tokens** are stored exclusively in VS Code's `SecretStorage` (OS-keychain backed). They never cross into the webview, never appear in logs, and never get written to a file.
- **Loopback server** binds to `127.0.0.1` only. Bearer authentication uses a 256-bit token, regenerated per activation, compared in constant time.
- **Webview CSP** sets `connect-src 'none'` — the webview cannot make network calls. All chat traffic flows through the extension host.
- **Telemetry** is opt-in (`claudeReview.telemetry`) and additionally gated by VS Code's global telemetry setting. Events are scrubbed for PII (file paths, message content, tokens) before emission.

---

## License

MIT. See `LICENSE`.

---

*Built to make Claude Code more reviewable. If something's off, run **Claude Review: Show Log** and file an issue with the output.*
