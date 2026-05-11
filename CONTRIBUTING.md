# Contributing to Claude Code Diff Review

Thanks for your interest. Quick path to a good PR:

## Get the dev loop running

```bash
git clone https://github.com/ujjawal-yadav/claude-code-diff-review
cd claude-code-diff-review
npm ci
npm test            # 173/173 should pass
code .              # open in VS Code, press F5 to launch the Extension Development Host
```

## Project structure (the 30-second tour)

```
src/                      # extension host (Node.js)
  extension.ts            # activation; wires every other module
  server.ts               # Fastify loopback HTTP server (hook endpoints)
  reviewOrchestrator.ts   # session state machine, per-file mutex, action handlers
  reviewPanel.ts          # WebviewPanel lifecycle, message routing
  anthropicClient.ts      # SDK wrapper, streaming, error classifier
  history/                # (future) memory subsystem
webview/                  # the React app inside the review panel
src/messages.ts           # wire schema shared by both bundles
docs/                     # PRD, TRD, RELEASE runbook, QA checklist
tests/                    # vitest + integration
```

The TRD (`docs/TRD-Claude-Code-Diff-Review-Extension.md`) is the source of truth for engineering decisions. Read it before suggesting architectural changes.

## Coding rules

- TypeScript strict + `exactOptionalPropertyTypes`. No `any` unless commented why.
- Imports inside `src/` and `webview/` use `.js` extensions (esbuild + tsconfig resolution).
- New modules ship with tests under `tests/unit/` or `tests/integration/`.
- Wire-format changes between host and webview require updating `src/messages.ts`.
- Don't add a new runtime dependency without raising it in the PR description. The license-audit script (`npm run audit:licenses`) gates the allow-list.

## What to avoid

- **No `dangerouslySetInnerHTML`** in webview code. ESLint enforces this.
- **No `eval`**, no dynamic `Function(...)`, no `child_process.exec` with user-supplied strings.
- **No secrets to the webview.** API keys / OAuth tokens stay in the extension host. Streamed text deltas are fine.
- **No silent failures.** Every catch site must log via the structured `Logger`.

## Tests

- Unit tests: `tests/unit/`. One file per module. Property tests where applicable (diff round-trips, etc.).
- Integration tests: `tests/integration/`. Real Fastify, real filesystem, mocked Anthropic SDK.
- Performance + memory regressions are gated in CI via `perf.bench.test.ts` and `memoryLeak.test.ts`. If your change touches the orchestrator hot path, check those still pass.

## Commit + PR style

- Conventional Commits-ish: `fix:`, `feat:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:`.
- Single-purpose PRs. Splitting a refactor from a feature change makes review meaningful.
- Update `CHANGELOG.md` under the `## [Unreleased]` block.

## Releases

The release process is documented in `docs/RELEASE.md`. Only maintainers with publisher access run the publish step; everyone else's PRs land in `main` and get bundled into the next tagged release.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind; assume good faith; flag genuine issues to the maintainers.
