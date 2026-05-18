import * as vscode from 'vscode';

import { Logger, LogLevel } from './logger.js';
import { SecretManager } from './secretManager.js';
import { ensureHooksInstalled, hasInstalledHooks, removeHooks as removeHookConfig, InstallScope } from './hookConfigurator.js';
import { HistoryService } from './history/historyService.js';
import { HistoryPanelManager } from './historyPanel.js';
import { startServer, ServerHandle } from './server.js';
import { SnapshotStore } from './snapshotStore.js';
import { ReviewOrchestrator } from './reviewOrchestrator.js';
import { ReviewPanelManager } from './reviewPanel.js';
import { StatusBarController } from './statusBarController.js';
import { PendingStatusBar } from './pendingStatusBar.js';
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
  const bearerToken = await secrets.rotateBearerToken();
  logger.debug('extension', 'bearer.rotated');

  // Make the bearer token visible to Claude Code in any terminal VS Code
  // spawns. Without this, Claude Code's `$CLAUDE_REVIEW_TOKEN` substitution
  // resolves to empty and the loopback server returns 401.
  //
  // `persistent: false` means the var doesn't survive a VS Code reload —
  // correct, since we rotate the token per activation. Existing terminals
  // won't see the new value; the user must reopen them. We surface this
  // as an info toast on activation if any terminal is already open.
  context.environmentVariableCollection.persistent = false;
  context.environmentVariableCollection.description = 'Claude Code Review: bearer token for the local hook server.';
  context.environmentVariableCollection.replace('CLAUDE_REVIEW_TOKEN', bearerToken);
  if (vscode.window.terminals.length > 0) {
    vscode.window.showInformationMessage(
      'Claude Code Review: close and reopen any open terminal so it picks up the auth token, then run `claude`.',
    );
  }

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
    ...(history ? { history } : {}),
    agentId: 'claude-code',
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
    // Phase α Track 6 + Track 1: mint a turn id if this is the first edit of
    // a new turn, capture the before-snapshot, and emit `turn-started` into
    // the event log on freshly-minted turns. All best-effort.
    const turnInfo = store.beginTurnIfNeeded(norm.sessionId, norm.cwd, norm.agentId);
    const resolved = await store.captureOriginal(norm.sessionId, norm.cwd, norm.filePath, norm.agentId);
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
      });
    }
  };
  const onPostToolUse = async (p: PostToolUsePayload) => {
    const norm = claudeAdapter.parsePostToolUse(p);
    if (!norm || !norm.filePath) return;
    const resolved = store.recordTouched(norm.sessionId, norm.cwd, norm.filePath, norm.agentId);
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

  server = await startServer({ preferredPort, bearerToken, logger, onPreToolUse, onPostToolUse, onStop });
  context.subscriptions.push({ dispose: () => server?.dispose() });

  // Deferred off the activation hot path. The hook config file only needs
  // to exist before the user runs `claude` — not before activate() returns.
  // Pushing this out shaves ~2 s from cold start (TRD §15 budget: <200 ms P95).
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const installScope = (config.get<string>('installScope') ?? 'user') as InstallScope;

  // Phase α Track 2: collision detection. If both scopes carry our marker,
  // prefer workspace (more specific) and warn the user.
  void hasInstalledHooks({ workspaceRoot: root, scope: 'workspace' }).then(async (workspaceHasOurs) => {
    const userHasOurs = await hasInstalledHooks({ workspaceRoot: root, scope: 'user' });
    if (workspaceHasOurs && userHasOurs && installScope === 'user') {
      logger?.warn('extension', 'install.collision', {
        msg: 'Claude Review hooks found at both user and workspace scope. The workspace-level install will fire (more specific). Remove the redundant copy via "Switch Install Scope".',
      });
      void vscode.window.showWarningMessage(
        'Claude Code Review: hooks are installed at BOTH user and workspace scope. The workspace install takes precedence — remove the duplicate via "Switch Install Scope".',
      );
    }
  }).catch(() => { /* swallow probe errors */ });

  // Phase α Track 2: v0.1.0 → v0.2.0 migration prompt. If the user is on
  // the new 'user' default but has workspace-level hooks from a prior
  // install, offer to migrate. One-shot — persists the answer regardless.
  const MIGRATION_FLAG = 'claudeReview.migrationV1Asked';
  if (installScope === 'user' && context.globalState.get<boolean>(MIGRATION_FLAG) !== true && root) {
    void hasInstalledHooks({ workspaceRoot: root, scope: 'workspace' }).then(async (hasWorkspaceHooks) => {
      if (!hasWorkspaceHooks) {
        // Nothing to migrate; quietly persist so we don't ask again.
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
          await ensureHooksInstalled({ workspaceRoot: root, port: server!.port, scope: 'user' });
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
    }).catch((err) => logger?.warn('extension', 'migration.probe.failed', { err: String(err) }));
  }

  if (installScope === 'workspace' && !root) {
    logger.warn('extension', 'no-workspace', { msg: 'workspace install scope but no folder open; hooks not installed' });
  } else {
    void ensureHooksInstalled({ workspaceRoot: root, port: server.port, scope: installScope })
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
        await ensureHooksInstalled({ workspaceRoot: r, port: server!.port, scope: nextScope });
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
    vscode.commands.registerCommand('claudeReview.rotateBearerToken', async () => {
      await secrets.rotateBearerToken();
      vscode.window.showInformationMessage('Claude Code Review: bearer token rotated. Reload window to apply.');
    }),
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
    const rel = require('node:path').relative(cwd, absPath);
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
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
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
      await fs.writeFile(gitignorePath, `${current}${newline}${ENTRY}\n`, 'utf8');
      void vscode.window.showInformationMessage('.gitignore updated.');
      logger.info('history', 'gitignore.injected');
    } catch (err) {
      logger.warn('history', 'gitignore.inject.failed', { err: String(err) });
    }
  }
  return true; // prompt was shown; suppress future prompts
}

export async function deactivate(): Promise<void> {
  try { await server?.dispose(); } catch { /* swallow */ }
  logger?.info('extension', 'deactivate.done');
}
