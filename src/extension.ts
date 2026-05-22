import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { Logger, LogLevel } from './logger.js';
import { SecretManager } from './secretManager.js';
import { ensureHooksInstalled, hasInstalledHooks, removeHooks as removeHookConfig, decideDualScopeAction, InstallScope } from './hookConfigurator.js';
import { HistoryService } from './history/historyService.js';
import { HistoryPanelManager } from './historyPanel.js';
import { startServer, ServerHandle } from './server.js';
import { SnapshotStore } from './snapshotStore.js';
import { ReviewOrchestrator } from './reviewOrchestrator.js';
import { ReviewPanelManager } from './reviewPanel.js';
import { StatusBarController } from './statusBarController.js';
import { PendingStatusBar } from './pendingStatusBar.js';
import { AuthFailureBurstDetector } from './authFailureBurstDetector.js';
import { ClaudeReviewScmProvider } from './scmProvider.js';
import { AnthropicClient } from './anthropicClient.js';
import { ChatService } from './chatService.js';
import { resolveCredential } from './credentialResolver.js';
import { showOnboardingIfNeeded } from './onboarding.js';
import { HunkCodeLensProvider, ACCEPT_HUNK_AT, REJECT_HUNK_AT } from './codeLensProvider.js';
import { createTelemetry } from './telemetry.js';
import { asAbsPath } from './types.js';
import { agentAdapters } from './adapters/index.js';
import type { PreToolUsePayload, PostToolUsePayload, StopPayload } from './messages.js';

/**
 * Activation entry point (TRD §5.1).
 *
 * Order:
 *   1. Logger
 *   2. SecretManager (rotates bearer per activation)
 *   3. SnapshotStore + ReviewPanel + Orchestrator (inert until server fires)
 *   4. HTTPServer
 *   5. HookConfigurator (writes .claude/settings.json with the resolved port)
 *   6. Commands + save-watcher
 *
 * SCM and CodeLens are deferred to the first session (lazy registration)
 * to keep activation P95 < 200 ms (TRD §15).
 */

let server: ServerHandle | undefined;
let logger: Logger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeReview');
  const level = (config.get<string>('logLevel') ?? 'info') as LogLevel;
  logger = new Logger('Claude Code Review', level);
  context.subscriptions.push({ dispose: () => logger?.dispose() });

  logger.info('extension', 'activate.start', { version: context.extension.packageJSON.version });

  const telemetry = createTelemetry((event) => logger?.info('telemetry', event.name, event.properties));
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  telemetry.event('extension.activated', {
    version: String(context.extension.packageJSON.version),
    vscodeVersion: vscode.version,
    os: process.platform,
  });

  const secrets = new SecretManager(context.secrets);
  // 2026-05-19: switched from `rotateBearerToken` (per-activation rotation,
  // breaks every existing terminal on reload) to `getOrCreateBearerToken`
  // (stable token reused across activations; keychain-backed). Pair with
  // `persistent = true` below so VS Code restores the env var on window
  // reload too. Explicit rotation is still available via the
  // `claudeReview.rotateBearerToken` command for the rare case it's needed.
  const bearerToken = await secrets.getOrCreateBearerToken();
  logger.debug('extension', 'bearer.resolved');

  // Make the bearer token visible to Claude Code in any terminal VS Code
  // spawns. With `persistent = true`, the value is restored on window
  // reload so terminals from prior sessions also stay aligned. The only
  // failure mode left is a terminal opened BEFORE the extension first
  // activated on this machine — the burst detector wired below catches
  // that case at the moment of the first 401 and offers one-click recovery.
  context.environmentVariableCollection.persistent = true;
  context.environmentVariableCollection.description = 'Claude Code Review: bearer token for the local hook server.';
  context.environmentVariableCollection.replace('CLAUDE_REVIEW_TOKEN', bearerToken);

  const preferredPort = config.get<number>('port') ?? 53117;

  const store = new SnapshotStore({
    maxSessionBytes:    config.get<number>('maxSessionBytes')    ?? 50 * 1024 * 1024,
    maxFilesPerSession: config.get<number>('maxFilesPerSession') ?? 200,
  });

  const defaultViewType = (config.get<string>('defaultDiffView') ?? 'split') as 'split' | 'unified';
  const panel = new ReviewPanelManager({ context, logger, defaultViewType });

  // Lazy CodeLens: registered on first session open. Until then the provider
  // does nothing (no sessions ⇒ provideCodeLenses returns []).
  let codeLens: HunkCodeLensProvider | undefined;
  let codeLensRegistration: vscode.Disposable | undefined;
  const ensureCodeLens = () => {
    if (codeLens) return codeLens;
    codeLens = new HunkCodeLensProvider(orchestrator);
    codeLensRegistration = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      codeLens,
    );
    context.subscriptions.push(codeLensRegistration, codeLens);
    return codeLens;
  };

  // Phase α Track 1: construct the Memory Design event-log service. Lazy —
  // workspace-rooted construction requires a folder; when none is open we
  // skip history but everything else still works.
  let history: HistoryService | undefined;
  let historyPanel: HistoryPanelManager | undefined;
  const earlyRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (earlyRoot) {
    const earlyScope = (config.get<string>('installScope') ?? 'user') as InstallScope;
    history = new HistoryService({
      scope: earlyScope,
      workspaceRoot: earlyRoot,
      logger,
      enabled: (config.get<boolean>('history.enabled') ?? true),
    });
    logger.info('extension', 'history.ready', { root: history.getRoot() });

    // M9.2.10: retention sweeper. 10-minute interval, off the hot path.
    const retentionDays = config.get<number>('history.retentionDays') ?? 30;
    const sweepIntervalMs = 10 * 60 * 1000;
    const sweepTimer = setInterval(() => {
      void history!.sweep(retentionDays).then((res) => {
        if (res.sessions > 0 || res.blobs > 0) {
          logger?.info('history', 'sweep', { ...res, retentionDays });
        }
      }).catch((err) => logger?.warn('history', 'sweep.error', { err: String(err) }));
    }, sweepIntervalMs);
    context.subscriptions.push({ dispose: () => clearInterval(sweepTimer) });

    // M9.2.11: crash recovery toast.
    //
    // @deprecated v0.3 — superseded by `PendingStatusBar` (β.0 10.1.6) which
    // covers a strict superset (any recoverable session with pending hunks,
    // not just sessions with an open turn). The toast remains ON by default
    // for one release so existing v0.2 users aren't surprised — gated by
    // `claudeReview.crashRecoveryToast.enabled` (default true). Switch the
    // default to false in v0.4 once status-bar parity is confirmed in the
    // wild; remove the toast entirely in v0.5.
    //
    // Fire-and-forget; never blocks activation.
    const toastEnabled = vscode.workspace
      .getConfiguration('claudeReview')
      .get<boolean>('crashRecoveryToast.enabled', true);
    if (toastEnabled) {
      void history.findResumeCandidates({ withinMs: 7 * 24 * 60 * 60 * 1000 })
        .then(async (candidates) => {
          const openOnes = candidates.filter((c) => c.hasOpenTurn);
          if (openOnes.length === 0) return;
          const choice = await vscode.window.showInformationMessage(
            `Claude Code Review: ${openOnes.length} session(s) ended without a clean stop. Open the History panel to inspect?`,
            'Open History',
            'Dismiss',
          );
          if (choice === 'Open History') {
            await vscode.commands.executeCommand('claudeReview.openHistory').then(undefined, () => undefined);
          }
        })
        .catch((err) => logger?.warn('history', 'recovery.probe.error', { err: String(err) }));
    }

    // M9.2.12: one-time `.gitignore` prompt. On first event-log write we
    // detect a workspace `.gitignore` and offer to add the history path.
    // Persists decision in workspaceState so we don't re-prompt.
    const GITIGNORE_ASKED = 'claudeReview.gitignoreAsked';
    if (earlyScope === 'workspace' && context.workspaceState.get<boolean>(GITIGNORE_ASKED) !== true) {
      void maybePromptGitignore(earlyRoot, logger).then(async (didPrompt) => {
        if (didPrompt) await context.workspaceState.update(GITIGNORE_ASKED, true);
      }).catch((err) => logger?.warn('history', 'gitignore.prompt.error', { err: String(err) }));
    }
  }

  // β.0 (10.1.6): forward-declared so the orchestrator's `onChange` can
  // schedule a debounced refresh. Assigned a few lines below, after the
  // live StatusBarController is constructed.
  let pendingStatusBar: PendingStatusBar | null = null;
  const orchestrator = new ReviewOrchestrator({
    store, panel, logger,
    onChange: () => {
      codeLens?.refresh();
      pendingStatusBar?.scheduleRefresh();
    },
    onDismissSession: (sid) => {
      // M9.6: free the per-session sub-agent cache.
      claudeAdapter.clearSubagentCache?.(sid);
    },
    ...(history ? { history } : {}),
    agentId: 'claude-code',
    // v0.3: opt-in (default true) heuristic flag triage.
    riskFlagsEnabled: config.get<boolean>('riskFlags.enabled') ?? true,
  });
  panel.setOrchestrator(orchestrator);

  // Adapter is needed for hook dispatch AND for chatService's transcript
  // resolution, so hoist it above both. When a second adapter lands (M9.4b),
  // the route-level discriminator selects which entry to use.
  const claudeAdapter = agentAdapters.get('claude-code')!;

  const anthropicClient = new AnthropicClient({
    resolveCredential: () => resolveCredential(
      { getOAuthToken: () => secrets.getOAuthToken(), getApiKey: () => secrets.getApiKey() },
      (kind, msg) => logger?.warn('credentials', kind, { msg }),
    ),
    model:     config.get<string>('chatModel')      ?? 'claude-haiku-4-5-20251001',
    maxTokens: config.get<number>('chatMaxTokens')  ?? 2048,
  });
  const transcriptContextEnabled = config.get<boolean>('chat.transcriptContext') ?? true;
  const chatService = new ChatService({
    client: anthropicClient,
    logger,
    orchestrator,
    panel,
    adapter: claudeAdapter,
    transcriptContextEnabled,
  });
  panel.setChatService(chatService);

  const statusBar = new StatusBarController(context, 'claudeReview.openPanel');
  // β.0 (10.1.6): pending-reviews indicator for recoverable sessions in the
  // event log (distinct from `statusBar` which tracks live-session counts).
  if (history) {
    pendingStatusBar = new PendingStatusBar(context, history, logger);
    // Live-update wiring (2026-05-19): the orchestrator's onChange only fires
    // for live workspace sessions, so a session whose activity ends before
    // the panel sees it would never update the status bar. Subscribing to
    // HistoryService.addChangeListener catches every event-log write,
    // independent of the orchestrator's in-memory state. PendingStatusBar's
    // internal 1s debounce + the 1s TTL cache on getPendingReviewsSummary
    // absorb burst writes without an extra layer of throttling here.
    const unsubscribePending = history.addChangeListener(() => {
      pendingStatusBar?.scheduleRefresh();
    });
    context.subscriptions.push({ dispose: () => unsubscribePending() });
  }
  let scm: ClaudeReviewScmProvider | undefined;
  const lazyScm = () => {
    if (!scm) scm = new ClaudeReviewScmProvider(context);
    return scm;
  };
  context.subscriptions.push({ dispose: () => scm?.dispose() });

  // PreToolUse / PostToolUse run after server-side adapter validation.
  // We dispatch through the adapter registry here as well so the agentId
  // tag propagates onto SessionData (and ultimately SessionReview).
  // `claudeAdapter` is hoisted above (chatService also needs it for
  // transcript path resolution).
  const onPreToolUse = async (p: PreToolUsePayload) => {
    const norm = claudeAdapter.parsePreToolUse(p);
    if (!norm || !norm.filePath) return;
    // M9.6: resolve sub-agent attribution from the transcript. Async because
    // the first call per session reads the JSONL; subsequent calls hit the
    // adapter's cache and return in sub-ms. `null` is the normal case for
    // edits the main agent made directly.
    const subagentId = await claudeAdapter.extractSubagentId(p);
    // Phase α Track 6 + Track 1: mint a turn id if this is the first edit of
    // a new turn, capture the before-snapshot, and emit `turn-started` into
    // the event log on freshly-minted turns. All best-effort.
    const turnInfo = store.beginTurnIfNeeded(norm.sessionId, norm.cwd, norm.agentId);
    const resolved = await store.captureOriginal(
      norm.sessionId, norm.cwd, norm.filePath, norm.agentId, subagentId,
    );
    if (resolved == null) {
      logger?.warn('hooks', 'pre.path-rejected', { sid: norm.sessionId, raw: norm.filePath });
      return;
    }
    if (turnInfo.freshlyMinted && history) {
      const before = store.get(norm.sessionId)?.originals.get(resolved) ?? null;
      void history.recordTurnStarted({
        sessionId: norm.sessionId,
        turnId: turnInfo.turnId,
        agentId: norm.agentId,
        files: [{
          relPath: relPathFromCwd(norm.cwd, resolved),
          beforeContent: before,
          mtimeMs: null,
        }],
        ...(subagentId ? { subagentId } : {}),
      });
    }
  };
  const onPostToolUse = async (p: PostToolUsePayload) => {
    const norm = claudeAdapter.parsePostToolUse(p);
    if (!norm || !norm.filePath) return;
    // M9.6: hit the cache built by PreToolUse for this session — sub-ms.
    const subagentId = await claudeAdapter.extractSubagentId(p);
    const resolved = store.recordTouched(
      norm.sessionId, norm.cwd, norm.filePath, norm.agentId, subagentId,
    );
    if (resolved == null) {
      logger?.warn('hooks', 'post.path-rejected', { sid: norm.sessionId, raw: norm.filePath });
    }
  };
  const onStop = async (p: StopPayload) => {
    logger?.info('hooks', 'stop', {
      sid: p.session_id,
      stopHookActive: p.stop_hook_active,
      touched: store.get(p.session_id)?.touched.size ?? 0,
    });
    if (config.get<boolean>('autoOpenPanel') === false) return;
    orchestrator.handleStop(p.session_id, p.stop_hook_active ?? false, p.last_assistant_message ?? null);
    // Refresh peripherals once the session opens (small delay to let orchestrator hydrate).
    setTimeout(() => {
      const review = orchestrator.getSession(p.session_id);
      if (review) {
        statusBar.update(review);
        lazyScm().upsertSession(review);
        ensureCodeLens().refresh();
        telemetry.event('review.opened', {
          fileCount: review.files.length,
          hunkCount: review.metrics.totalHunks,
        });
      }
    }, 300);
  };

  // Burst-detector toast for hook auth failures. Fires when ≥3 401s land
  // within a 10s sliding window (cooldown 60s after a fire). Subscribes to
  // the server's `onAuthFailure` channel — see `src/server.ts:onRequest`.
  const authFailureDetector = new AuthFailureBurstDetector({ logger });
  context.subscriptions.push({ dispose: () => authFailureDetector.dispose() });

  server = await startServer({
    preferredPort, bearerToken, logger,
    onPreToolUse, onPostToolUse, onStop,
    onAuthFailure: () => authFailureDetector.record(),
  });
  context.subscriptions.push({ dispose: () => server?.dispose() });

  // Deferred off the activation hot path. The hook config file only needs
  // to exist before the user runs `claude` — not before activate() returns.
  // Pushing this out shaves ~2 s from cold start (TRD §15 budget: <200 ms P95).
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const installScope = (config.get<string>('installScope') ?? 'user') as InstallScope;

  // v0.2.2 (2026-05-21): dual-scope auto-resolve + v0.1→v0.2 migration prompt,
  // run sequentially so the migration prompt sees post-resolve state.
  //
  // Background: real users have hit a state where BOTH ~/.claude/settings.json
  // AND <workspace>/.claude/settings.json carry our marker, pointing at
  // different ports. Claude's hook precedence (workspace > user) routes
  // hook fires to one instance; the other is orphaned. Prior to v0.2.2 we
  // just warned. Now we auto-remove the non-active scope, with a
  // claudeReview.dualScope.allow config gate (undocumented, default false)
  // for users who deliberately want both.
  const MIGRATION_FLAG = 'claudeReview.migrationV1Asked';
  const dualScopeAllow = config.get<boolean>('dualScope.allow') ?? false;
  void (async () => {
    let workspaceHasOurs = false;
    let userHasOurs = false;
    try {
      [workspaceHasOurs, userHasOurs] = await Promise.all([
        hasInstalledHooks({ workspaceRoot: root, scope: 'workspace' }),
        hasInstalledHooks({ workspaceRoot: root, scope: 'user' }),
      ]);
    } catch (err) {
      logger?.warn('extension', 'hooks.dual-scope.probe-failed', { err: String(err) });
      return;
    }

    // --- Dual-scope auto-resolve --------------------------------------------
    // Decision logic is a pure function in hookConfigurator.ts for unit-testability.
    const action = decideDualScopeAction({
      workspaceHasOurs, userHasOurs, installScope, dualScopeAllow,
      hasWorkspaceRoot: root != null,
    });
    switch (action.kind) {
      case 'none':
        break;
      case 'allowed':
        logger?.info('extension', 'hooks.dual-scope.allowed');
        void vscode.window.showWarningMessage(
          'Claude Code Review: hooks installed at BOTH user and workspace scope (dual-scope mode enabled via claudeReview.dualScope.allow). The workspace install takes precedence.',
        );
        break;
      case 'skip-no-workspace':
        logger?.info('extension', 'hooks.dual-scope.skipped-no-workspace');
        break;
      case 'auto-resolve': {
        try {
          await removeHookConfig({ workspaceRoot: root, scope: action.cleanScope });
          logger?.info('extension', 'hooks.dual-scope.resolved', {
            cleanedScope: action.cleanScope,
            activeScope: installScope,
          });
          // Reflect the cleanup in local state so the migration prompt below
          // sees the post-resolve world (the cleaned scope no longer has hooks).
          if (action.cleanScope === 'workspace') workspaceHasOurs = false;
          else                                    userHasOurs = false;
        } catch (err) {
          logger?.error('extension', 'hooks.dual-scope.resolve-failed', {
            err: String(err),
            cleanedScope: action.cleanScope,
          });
          const SWITCH_SCOPE = 'Switch Install Scope';
          void vscode.window.showWarningMessage(
            `Claude Code Review: hooks installed at both scopes; auto-cleanup of ${action.cleanScope} scope failed (${(err as Error).message}). Resolve manually.`,
            SWITCH_SCOPE,
          ).then((choice) => {
            if (choice === SWITCH_SCOPE) {
              void vscode.commands.executeCommand('claudeReview.switchInstallScope');
            }
          });
        }
        break;
      }
    }

    // --- v0.1→v0.2 migration prompt (existing logic, post-resolve) ---------
    // Fires when installScope='user' but stale workspace-only hooks remain.
    // If the auto-resolve above just ran, workspaceHasOurs is already false.
    if (installScope === 'user' && context.globalState.get<boolean>(MIGRATION_FLAG) !== true && root) {
      if (!workspaceHasOurs) {
        await context.globalState.update(MIGRATION_FLAG, true);
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        'Claude Code Review v0.2 installs hooks at user scope (~/.claude/) by default so every project picks them up. Migrate your existing workspace-level hooks now?',
        { modal: false },
        'Migrate to user scope',
        'Stay on workspace scope',
        'Decide later',
      );
      if (choice === 'Migrate to user scope') {
        try {
          await removeHookConfig({ workspaceRoot: root, scope: 'workspace' });
          await ensureHooksInstalled({ workspaceRoot: root, port: server!.port, scope: 'user', ...(logger ? { logger } : {}) });
          void vscode.window.showInformationMessage('Claude Review: hooks migrated to ~/.claude/settings.json.');
          await context.globalState.update(MIGRATION_FLAG, true);
        } catch (err) {
          void vscode.window.showErrorMessage(`Migration failed: ${(err as Error).message}`);
        }
      } else if (choice === 'Stay on workspace scope') {
        await config.update('installScope', 'workspace', vscode.ConfigurationTarget.Workspace);
        await context.globalState.update(MIGRATION_FLAG, true);
      }
      // 'Decide later' or dismissed → leave the flag false; we'll ask again next activation.
    }
  })();

  if (installScope === 'workspace' && !root) {
    logger.warn('extension', 'no-workspace', { msg: 'workspace install scope but no folder open; hooks not installed' });
  } else {
    void ensureHooksInstalled({ workspaceRoot: root, port: server.port, scope: installScope, logger })
      .then(() => logger?.info('extension', 'hooks.installed', { port: server!.port, scope: installScope }))
      .catch((err) => {
        logger?.error('extension', 'hooks.install.failed', { err: String(err), scope: installScope });
        void vscode.window.showErrorMessage(
          `Claude Code Review: failed to write ${installScope === 'user' ? '~/.claude/settings.json' : '<workspace>/.claude/settings.json'}. Check permissions.`,
        );
      });
  }

  // Re-diff on save (TRD §9.3 + §15: debounced 200 ms in orchestrator).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const fp = asAbsPath(doc.uri.fsPath);
      // Apply to every active session; orchestrator no-ops on unknown files.
      // (Most users have one session at a time so the work is minimal.)
      for (const sid of activeSessionIds(orchestrator)) {
        orchestrator.scheduleReDiff(sid, fp);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeReview.removeHooks', async () => {
      const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const scope = (config.get<string>('installScope') ?? 'user') as InstallScope;
      try {
        // Remove from BOTH scopes so the user gets a complete clean.
        // No-ops harmlessly if the file or marked entries don't exist.
        await removeHookConfig({ workspaceRoot: r, scope: 'user' });
        await removeHookConfig({ workspaceRoot: r, scope: 'workspace' });
        vscode.window.showInformationMessage(`Claude Code Review hooks removed (active scope was ${scope}).`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to remove hooks: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('claudeReview.switchInstallScope', async () => {
      const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      const currentScope = (config.get<string>('installScope') ?? 'user') as InstallScope;
      const nextScope: InstallScope = currentScope === 'user' ? 'workspace' : 'user';
      if (nextScope === 'workspace' && !r) {
        vscode.window.showWarningMessage('Cannot switch to workspace scope: no workspace folder is open.');
        return;
      }
      try {
        await removeHookConfig({ workspaceRoot: r, scope: currentScope });
        await ensureHooksInstalled({ workspaceRoot: r, port: server!.port, scope: nextScope, ...(logger ? { logger } : {}) });
        const target = nextScope === 'workspace'
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        await config.update('installScope', nextScope, target);
        vscode.window.showInformationMessage(
          `Claude Review: hooks switched to ${nextScope} scope (${nextScope === 'user' ? '~/.claude/' : '<workspace>/.claude/'}).`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Switch scope failed: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('claudeReview.rotateBearerToken', () =>
      rotateBearerTokenAndPromptReload({
        secrets,
        envCollection: context.environmentVariableCollection,
        ...(logger ? { logger } : {}),
        showInfo: (msg, ...actions) =>
          Promise.resolve(vscode.window.showInformationMessage(msg, ...actions)),
        executeCommand: (cmd) => {
          void vscode.commands.executeCommand(cmd);
        },
      }),
    ),
    vscode.commands.registerCommand('claudeReview.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-…',
      });
      if (!key) return;
      try { await secrets.setApiKey(key); vscode.window.showInformationMessage('Anthropic API key stored.'); }
      catch (err) { vscode.window.showErrorMessage((err as Error).message); }
    }),
    vscode.commands.registerCommand('claudeReview.clearApiKey', async () => {
      await secrets.clearApiKey();
      vscode.window.showInformationMessage('Anthropic API key cleared.');
    }),
    vscode.commands.registerCommand('claudeReview.setOAuthToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Paste your Claude OAuth token (sk-ant-oat01-…)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-oat01-…',
      });
      if (!token) return;
      try {
        await secrets.setOAuthToken(token);
        vscode.window.showInformationMessage('Claude OAuth token stored. Chat will use Max-plan auth.');
      } catch (err) {
        vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('claudeReview.clearOAuthToken', async () => {
      await secrets.clearOAuthToken();
      vscode.window.showInformationMessage('Claude OAuth token cleared.');
    }),
    vscode.commands.registerCommand('claudeReview.useClaudeCodeAuth', async () => {
      // Probe whatever credential the resolver finds and report the source
      // back to the user so they can verify Max-plan auth is being used.
      const cred = await resolveCredential(
        { getOAuthToken: () => secrets.getOAuthToken(), getApiKey: () => secrets.getApiKey() },
        (kind, msg) => logger?.warn('credentials', kind, { msg }),
      );
      if (!cred) {
        vscode.window.showWarningMessage(
          'No Claude credential found. Run `claude login` (Max plan), set CLAUDE_CODE_OAUTH_TOKEN, paste a token via "Set OAuth Token", or set an API key.',
        );
        return;
      }
      const label = cred.kind === 'oauth'
        ? `Max/Pro OAuth (source: ${cred.source})`
        : `Anthropic API key (source: ${cred.source})`;
      vscode.window.showInformationMessage(`Claude Review chat is using: ${label}.`);
    }),
    vscode.commands.registerCommand('claudeReview.showLog', () => logger?.show()),
    vscode.commands.registerCommand('claudeReview.openHistory', async () => {
      if (!history) {
        vscode.window.showInformationMessage(
          'Claude Code Review: history is unavailable (no workspace folder open).',
        );
        return;
      }
      if (!historyPanel) {
        historyPanel = new HistoryPanelManager({
          context,
          logger: logger!,
          history,
          orchestrator,
          reviewPanel: panel,
          ...(pendingStatusBar ? { pendingStatusBar } : {}),
        });
      }
      await historyPanel.openOrFocus();
    }),
    vscode.commands.registerCommand('claudeReview.openPanel', async () => {
      const sids = activeSessionIds(orchestrator);
      if (sids.length > 0) {
        const review = orchestrator.getSession(sids[0]);
        if (review) panel.openOrFocus(review);
        return;
      }
      // β.0 (10.1.7): zero in-memory sessions — check the event log for
      // recoverable sessions with pending review. If any exist, prompt the
      // user. Otherwise fall back to the legacy "no active session" toast.
      if (history) {
        try {
          const summary = await history.getPendingReviewsSummary();
          if (summary.totalPendingHunks > 0 && summary.sessions.length > 0) {
            const top = summary.sessions[0];
            const RESUME = 'Resume';
            const OPEN_HISTORY = 'Open History';
            const DISMISS = 'Dismiss';
            const ago = humanizeAgoForPrompt(top.lastEventAt);
            const hunkLabel = summary.totalPendingHunks === 1 ? 'hunk' : 'hunks';
            const choice = await vscode.window.showInformationMessage(
              `Claude Code Review: ${summary.totalPendingHunks} ${hunkLabel} pending in session ${top.sessionId.slice(0, 8)} (${ago}). Resume?`,
              { modal: true },
              RESUME, OPEN_HISTORY, DISMISS,
            );
            if (choice === RESUME) {
              const recon = await history.reconstructSessionReview(top.sessionId);
              if (recon) {
                orchestrator.adoptReconstructed(recon);
                const review = orchestrator.getSession(top.sessionId);
                if (review) await panel.openOrFocus(review);
                pendingStatusBar?.scheduleRefresh();
              } else {
                vscode.window.showWarningMessage(
                  `Claude Code Review: could not reconstruct session ${top.sessionId.slice(0, 8)}.`,
                );
              }
              return;
            }
            if (choice === OPEN_HISTORY) {
              await vscode.commands.executeCommand('claudeReview.openHistory');
              return;
            }
            // DISMISS or escape — no-op
            return;
          }
        } catch (err) {
          logger?.warn('command', 'openPanel.resumeProbe.failed', { err: String(err) });
        }
      }
      vscode.window.showInformationMessage('Claude Code Review: no active session.');
    }),
    vscode.commands.registerCommand(ACCEPT_HUNK_AT, async (sessionId: string, filePath: string, hunkIndex: number) => {
      await orchestrator.handleHunkAction(sessionId, filePath, hunkIndex, 'accept');
      telemetry.event('hunk.action', { action: 'accept', viaChat: false });
    }),
    vscode.commands.registerCommand(REJECT_HUNK_AT, async (sessionId: string, filePath: string, hunkIndex: number) => {
      await orchestrator.handleHunkAction(sessionId, filePath, hunkIndex, 'reject');
      telemetry.event('hunk.action', { action: 'reject', viaChat: false });
    }),
  );

  logger.info('extension', 'activate.done', { port: server.port });

  // Onboarding nudges the user to set up auth on first activation if they
  // haven't already. Fire-and-forget; never blocks activation.
  void showOnboardingIfNeeded(context, secrets, logger);
}

function activeSessionIds(orchestrator: ReviewOrchestrator): string[] {
  return orchestrator.listSessionIds();
}

/**
 * β.0 (10.1.7): human-readable "time ago" used in the `openPanel` resume
 * prompt. Kept module-local so the prompt copy lives next to the call site.
 */
function humanizeAgoForPrompt(ts: number): string {
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Best-effort relative-path helper for history records. Forward-slashes
 * the result and falls back to the absolute path when it doesn't fit
 * under `cwd`. Defensive — never throws.
 */
function relPathFromCwd(cwd: string, absPath: string): string {
  try {
    const rel = path.relative(cwd, absPath);
    if (!rel || rel.startsWith('..')) return absPath;
    return rel.replace(/\\/g, '/');
  } catch {
    return absPath;
  }
}

/**
 * M9.2.12: prompt the user (once per workspace) to add `.claude/review-history/`
 * to their `.gitignore`. Returns true if the prompt was shown (regardless
 * of the user's answer) so the caller can persist a suppression flag.
 *
 * Only fires for workspace-scope installs — user-scope event logs live
 * outside the project tree under `~/.claude/`.
 */
async function maybePromptGitignore(workspaceRoot: string, logger: Logger): Promise<boolean> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  let current: string;
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    return false; // no .gitignore → nothing to do (don't pester)
  }
  const ENTRY = '.claude/review-history/';
  if (current.includes(ENTRY)) return false; // already there

  const choice = await vscode.window.showInformationMessage(
    'Claude Code Review writes an event log to .claude/review-history/. Add it to .gitignore so it isn\'t committed?',
    'Add to .gitignore',
    'Skip',
  );
  if (choice === 'Add to .gitignore') {
    try {
      const newline = current.endsWith('\n') ? '' : '\n';
      const next = `${current}${newline}${ENTRY}\n`;
      // Atomic write: tmp + rename. Direct fs.writeFile is non-atomic — a
      // concurrent editor (or a crash mid-write) could truncate the file.
      const tmp = `${gitignorePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(tmp, next, 'utf8');
      await fs.rename(tmp, gitignorePath);
      void vscode.window.showInformationMessage('.gitignore updated.');
      logger.info('history', 'gitignore.injected');
    } catch (err) {
      logger.warn('history', 'gitignore.inject.failed', { err: String(err) });
    }
  }
  return true; // prompt was shown; suppress future prompts
}

/**
 * Body of the `claudeReview.rotateBearerToken` command, extracted so it
 * can be unit-tested without going through `vscode.commands.registerCommand`.
 *
 * The running server captures `expectedToken` as a Buffer at start time —
 * rotation invalidates that immediately, so terminals using the new token
 * would 401 against the still-running server. Hence the reload prompt.
 */
export async function rotateBearerTokenAndPromptReload(deps: {
  secrets: { rotateBearerToken(): Promise<string> };
  envCollection: { replace(name: string, value: string): void };
  logger?: { info(src: string, evt: string, props?: Record<string, unknown>): void };
  showInfo: (msg: string, ...actions: string[]) => Promise<string | undefined>;
  executeCommand: (cmd: string) => void;
}): Promise<void> {
  const fresh = await deps.secrets.rotateBearerToken();
  deps.envCollection.replace('CLAUDE_REVIEW_TOKEN', fresh);
  deps.logger?.info('extension', 'bearer.rotated');
  const RELOAD = 'Reload Window';
  const choice = await deps.showInfo(
    'Claude Code Review: bearer token rotated. Reload the window so the hook server picks up the new value, then open a fresh terminal.',
    RELOAD,
  );
  if (choice === RELOAD) {
    deps.executeCommand('workbench.action.reloadWindow');
  }
}

export async function deactivate(): Promise<void> {
  try { await server?.dispose(); } catch { /* swallow */ }
  logger?.info('extension', 'deactivate.done');
}
