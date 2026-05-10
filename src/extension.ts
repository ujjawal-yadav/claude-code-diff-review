import * as vscode from 'vscode';

import { Logger, LogLevel } from './logger.js';
import { SecretManager } from './secretManager.js';
import { ensureHooksInstalled, removeHooks as removeHookConfig } from './hookConfigurator.js';
import { startServer, ServerHandle } from './server.js';
import { SnapshotStore } from './snapshotStore.js';
import { ReviewOrchestrator } from './reviewOrchestrator.js';
import { ReviewPanelManager } from './reviewPanel.js';
import { StatusBarController } from './statusBarController.js';
import { ClaudeReviewScmProvider } from './scmProvider.js';
import { AnthropicClient } from './anthropicClient.js';
import { ChatService } from './chatService.js';
import { resolveCredential } from './credentialResolver.js';
import { showOnboardingIfNeeded } from './onboarding.js';
import { HunkCodeLensProvider, ACCEPT_HUNK_AT, REJECT_HUNK_AT } from './codeLensProvider.js';
import { createTelemetry } from './telemetry.js';
import { asAbsPath } from './types.js';
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

  const orchestrator = new ReviewOrchestrator({
    store, panel, logger,
    onChange: () => codeLens?.refresh(),
  });
  panel.setOrchestrator(orchestrator);

  const anthropicClient = new AnthropicClient({
    resolveCredential: () => resolveCredential(
      { getOAuthToken: () => secrets.getOAuthToken(), getApiKey: () => secrets.getApiKey() },
      (kind, msg) => logger?.warn('credentials', kind, { msg }),
    ),
    model:     config.get<string>('chatModel')      ?? 'claude-haiku-4-5-20251001',
    maxTokens: config.get<number>('chatMaxTokens')  ?? 2048,
  });
  const chatService = new ChatService({ client: anthropicClient, logger, orchestrator, panel });
  panel.setChatService(chatService);

  const statusBar = new StatusBarController(context, 'claudeReview.openPanel');
  let scm: ClaudeReviewScmProvider | undefined;
  const lazyScm = () => {
    if (!scm) scm = new ClaudeReviewScmProvider(context);
    return scm;
  };
  context.subscriptions.push({ dispose: () => scm?.dispose() });

  const onPreToolUse = async (p: PreToolUsePayload) => {
    const resolved = await store.captureOriginal(p.session_id, p.cwd, p.tool_input.file_path);
    if (resolved == null) {
      logger?.warn('hooks', 'pre.path-rejected', { sid: p.session_id, raw: p.tool_input.file_path });
    }
  };
  const onPostToolUse = async (p: PostToolUsePayload) => {
    const resolved = store.recordTouched(p.session_id, p.cwd, p.tool_input.file_path);
    if (resolved == null) {
      logger?.warn('hooks', 'post.path-rejected', { sid: p.session_id, raw: p.tool_input.file_path });
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
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    void ensureHooksInstalled({ workspaceRoot: root, port: server.port })
      .then(() => logger?.info('extension', 'hooks.installed', { port: server!.port }))
      .catch((err) => {
        logger?.error('extension', 'hooks.install.failed', { err: String(err) });
        void vscode.window.showErrorMessage(
          'Claude Code Review: failed to write .claude/settings.json. Open the file and check permissions.',
        );
      });
  } else {
    logger.warn('extension', 'no-workspace', { msg: 'no workspace folder open; hooks not installed' });
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
      const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!r) { vscode.window.showWarningMessage('No workspace folder is open.'); return; }
      try {
        await removeHookConfig({ workspaceRoot: r });
        vscode.window.showInformationMessage('Claude Code Review hooks removed.');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to remove hooks: ${(err as Error).message}`);
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
    vscode.commands.registerCommand('claudeReview.openPanel', () => {
      const sids = activeSessionIds(orchestrator);
      if (sids.length === 0) {
        vscode.window.showInformationMessage('Claude Code Review: no active session.');
        return;
      }
      const review = orchestrator.getSession(sids[0]);
      if (review) panel.openOrFocus(review);
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

export async function deactivate(): Promise<void> {
  try { await server?.dispose(); } catch { /* swallow */ }
  logger?.info('extension', 'deactivate.done');
}
