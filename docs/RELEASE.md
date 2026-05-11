# Release Runbook — Claude Code Diff Review

The exact sequence to publish a new version to the VS Code Marketplace and Open VSX. Follow top-to-bottom; **don't skip the pre-flight gate** — it has caught real bugs.

---

## Prerequisites — one-time setup

These are needed only once per publisher account.

### A. VS Code Marketplace publisher

1. **Sign in to Azure DevOps** at https://dev.azure.com (free account).
2. Create a **publisher** at https://marketplace.visualstudio.com/manage/createpublisher
   - Publisher ID becomes part of every extension URL (e.g. `UjjawalYadav.claude-code-diff-review`). Pick deliberately — it's not easily renameable.
   - Set the same ID in `package.json` → `"publisher"`.
3. Generate a **Personal Access Token (PAT)** at https://dev.azure.com/<your-org>/_usersSettings/tokens
   - **Organization:** `All accessible organizations` (this is mandatory — a single-org PAT won't authenticate Marketplace publishing).
   - **Scopes:** custom defined → enable **Marketplace → Manage**.
   - **Expiration:** 1 year (rotate annually).
   - Copy the token immediately.
4. Login `vsce` locally:
   ```powershell
   npx vsce login <publisher-id>
   # paste PAT when prompted
   ```
   The token is stored in your OS keychain by `vsce`.

### B. Open VSX registry (optional but recommended)

Open VSX hosts extensions for VS Codium, Cursor, Theia, Gitpod, etc. Same VSIX, different gallery.

1. Sign in at https://open-vsx.org/ via GitHub.
2. Generate an Open VSX access token at https://open-vsx.org/user-settings/tokens.
3. Install `ovsx`: `npm i -g ovsx`.
4. `npx ovsx create-namespace <publisher-id> --pat <token>` (one-time per namespace).

### C. GitHub repository readiness

1. Public visibility (or a clear note in README if intentionally private during beta).
2. `Issues` enabled. `Discussions` recommended for Q&A.
3. Apply `.github/ISSUE_TEMPLATE/*` (already in repo) so reports come in structured.
4. Add a `Releases` page workflow (already in `.github/workflows/release.yml`).

---

## Per-release sequence

### 1. Pre-flight gate (run from a clean checkout)

```powershell
cd "<repo-root>"
git status                       # must be clean
npm ci                           # install from lockfile, not package.json
npm run release:check            # typecheck + lint + test + audit + build
```

The `release:check` script chains every gate. If it fails, **stop**. Don't publish a broken build to attract early users.

### 2. Bump the version

```powershell
# Decide patch / minor / major based on SemVer:
#   patch — bug fixes only, no behavioural change
#   minor — backwards-compatible new features
#   major — breaking changes (config keys removed, hook schema bumped, etc.)
npm version patch                # or `minor` / `major`
```

`npm version` updates `package.json`, `package-lock.json`, and creates a git commit + tag (`vX.Y.Z`).

### 3. Update the changelog

Promote the **`## [Unreleased]`** block to a numbered version at the top of `CHANGELOG.md`:

```markdown
## [0.2.0] — 2026-05-15

### Added
- ...

### Fixed
- ...
```

Add a fresh **`## [Unreleased]`** block above it. Commit and amend the version tag:

```powershell
git add CHANGELOG.md
git commit --amend --no-edit
git tag -f v$(node -p "require('./package.json').version")
```

### 4. Generate the SBOM for the release

```powershell
npm run audit:sbom               # writes dist/sbom.cdx.json
```

You'll attach this to the GitHub Release in step 7.

### 5. Build the VSIX

```powershell
npm run package                  # produces claude-code-diff-review-X.Y.Z.vsix
```

**Sanity-inspect what's inside before you publish:**

```powershell
npx vsce ls --tree
```

Confirm:
- No `node_modules/.bin/*` cruft (rare but possible)
- No `.env*`, `.credentials*`, `.claude/` stowaways
- VSIX size < 5 MB
- Only `@anthropic-ai/sdk` and its transitive deps in `node_modules/`

### 6. Test-install the produced VSIX in a non-dev VS Code

```powershell
code --install-extension claude-code-diff-review-X.Y.Z.vsix
```

Reload, then run the **A**, **B**, **D**, **H** sections of `docs/qa.md`. Don't skip this — installing a private VSIX hits a different code path than F5 debug. Real bugs hide here (missing files, native module misses, etc.).

If smoke fails: `code --uninstall-extension UjjawalYadav.claude-code-diff-review`, fix, restart from step 1.

### 7. Publish to the Marketplace

```powershell
npx vsce publish --packagePath claude-code-diff-review-X.Y.Z.vsix
```

`vsce` validates the package once more (license fields, README references, etc.) and uploads. The first publish creates the listing; subsequent ones bump the version. Live in ~5 minutes.

### 8. Publish to Open VSX (optional, recommended)

```powershell
npx ovsx publish claude-code-diff-review-X.Y.Z.vsix -p <ovsx-token>
```

### 9. Push the version tag to GitHub

```powershell
git push origin main
git push origin v$(node -p "require('./package.json').version")
```

If the `.github/workflows/release.yml` is in place, this triggers an automated GitHub Release with the VSIX + SBOM attached.

### 10. Manual GitHub Release (if not automated)

```powershell
gh release create v0.2.0 `
  --title "v0.2.0" `
  --notes-file <(node scripts/extractChangelog.mjs 0.2.0) `
  claude-code-diff-review-0.2.0.vsix `
  dist/sbom.cdx.json
```

### 11. Post-publish verification

```powershell
# Marketplace listing live?
start https://marketplace.visualstudio.com/items?itemName=<publisher>.claude-code-diff-review

# Open VSX live?
start https://open-vsx.org/extension/<publisher>/claude-code-diff-review
```

Click "Install" from a clean VS Code and confirm the install flow works end-to-end. **The Marketplace listing is your product page**; double-check the banner color, screenshots, and category placement.

### 12. Announce

- Pin the release commit on GitHub.
- Post to the support channel (Discussions / Discord / etc.) with the changelog.
- Update internal docs / Slack with the new version.

---

## Hotfix path

If a critical bug ships:

```powershell
# 1. Branch from the latest tag
git checkout -b hotfix/0.2.1 v0.2.0

# 2. Fix + commit (small, surgical)
git commit -m "fix: <one-line>"

# 3. Re-run the full sequence above starting from step 1
#    Version bump should be `patch` (npm version patch)

# 4. Cherry-pick the fix back to main after publishing
git checkout main
git cherry-pick <hotfix-commit-sha>
git push origin main
```

Don't merge `main → hotfix` — keep the hotfix surgical to minimise risk surface.

---

## Yank / unpublish

The Marketplace allows **unpublishing a specific version** (not the whole extension):

```powershell
npx vsce unpublish <publisher>.claude-code-diff-review@0.2.0
```

Use sparingly — it's user-hostile. Prefer a fast follow-up patch that fixes forward.

For Open VSX:

```powershell
# Unpublishing on Open VSX requires emailing them; there's no CLI for it
# as of 2026. https://open-vsx.org/about
```

---

## Common publish failures

| Symptom | Cause | Fix |
|---|---|---|
| `Failed Request: Unauthorized (401)` | PAT scope wrong | Regenerate PAT with **All organizations** + **Marketplace → Manage** |
| `ERROR  The Personal Access Token verification has failed` | PAT expired | Generate a fresh PAT, re-run `vsce login` |
| `Make sure to edit the README.md file before you publish your extension` | README has the boilerplate `## Features` placeholder text | We don't — but if you re-init the repo, vsce notices |
| `Couldn't detect repository` | `repository.url` field missing or malformed in `package.json` | Already set; verify it points at a real GitHub URL |
| `Publisher 'foo' not found` | Mismatch between `package.json` "publisher" and the Azure DevOps publisher you created | Update package.json |
| Extension grayed out / "Cannot install" on consumer install | Native module incompatibility, version mismatch, or platform-specific binary | Run `vsce ls --tree` and look for unusual artifacts; check engines.vscode |
| `vsce` warns about file count > 100 | Bundled deps not externalized | Already handled — only `@anthropic-ai/sdk` should be in node_modules |

---

## Post-launch monitoring (first 14 days)

| Day | Check |
|---|---|
| 0 | Listing live; install count > 0 (you + beta testers) |
| 1 | Open VSX listing live; first external install |
| 1–3 | GitHub Issues — triage any reports within 24 h |
| 3 | Marketplace Q&A — answer first questions |
| 7 | Marketplace rating distribution — flag any 1-star reports |
| 7 | Telemetry sanity (if user opt-in): `extension.activated` count > install count × 0.7 (anything lower means activation failures) |
| 14 | First retention check — see "Success metrics" below |

---

## Success metrics (PRD §3.2 — track these via telemetry)

| Metric | Target (6 months) | How to read it |
|---|---|---|
| Weekly Active Users (WAU) | 5,000 | Marketplace install counter ÷ 4; supplement with telemetry `extension.activated` if available |
| Hunk actions / session | ≥ 3 | Sum of `hunk.action` events ÷ count of `review.opened` events |
| Chat invocations / week | ≥ 500 | Count of `chat.started` events (M4 future-instrumentation TODO) |
| P99 panel-open latency | < 1.5 s | `review.opened.latencyMs` event property's P99 |
| Crash-free sessions | ≥ 99.5 % | 1 − (count of `error` events / count of `review.opened` events) |
| Marketplace rating | ≥ 4.3 / 5.0 | Listing page header |
| D14 retention | ≥ 40 % | Count of users with ≥ 1 `extension.activated` event 14 days after first activation, ÷ first-day installs |

The telemetry infrastructure is already in place (see `src/telemetry.ts`). Reading the data requires either:
- VS Code's built-in telemetry channel + Application Insights (if you set `MICROSOFT_APP_INSIGHTS_CONNECTION_STRING` on the publisher account), or
- A separate Anthropic-owned endpoint (per TRD OTQ-8 — open question).

Decide before GA which endpoint to write to.

---

*Update this file with lessons learned after each release.*
