import * as vscode from 'vscode';

import { Logger } from './logger.js';
import { resolveCredential } from './credentialResolver.js';
import { SecretManager } from './secretManager.js';

/**
 * First-run onboarding (M7 beta).
 *
 * Shows a one-time notification when the extension activates against a
 * workspace where:
 *   - we've never been activated before for this workspace, AND
 *   - no Claude credential is resolvable yet.
 *
 * The notification offers actionable next-steps without nagging on every
 * activation. The "seen" flag is stored in `globalState` so it persists
 * across reloads.
 *
 * Skipped silently when:
 *   - User has already seen the prompt (`onboarding.shownAt` set), or
 *   - A credential resolves on first try (the user is already set up).
 */

const SEEN_KEY = 'claudeReview.onboarding.shownAt';

export async function showOnboardingIfNeeded(
  context: vscode.ExtensionContext,
  secrets: SecretManager,
  logger: Logger,
): Promise<void> {
  if (context.globalState.get<number>(SEEN_KEY) != null) return;

  const credential = await resolveCredential(
    { getOAuthToken: () => secrets.getOAuthToken(), getApiKey: () => secrets.getApiKey() },
    () => { /* swallow; this is the credential probe path */ },
  );
  if (credential) {
    // Already authed — silently mark as seen so we never bother them.
    await context.globalState.update(SEEN_KEY, Date.now());
    logger.debug('onboarding', 'skipped.already-authed');
    return;
  }

  logger.info('onboarding', 'shown');
  const choice = await vscode.window.showInformationMessage(
    'Claude Code Review is active. Run `claude` in the terminal to start a review session. ' +
      'For chat about hunks you\'ll need a credential.',
    'Set OAuth Token (Max plan)',
    'Set API Key',
    'Use claude /login',
    'Dismiss',
  );

  switch (choice) {
    case 'Set OAuth Token (Max plan)':
      await vscode.commands.executeCommand('claudeReview.setOAuthToken');
      break;
    case 'Set API Key':
      await vscode.commands.executeCommand('claudeReview.setApiKey');
      break;
    case 'Use claude /login': {
      // The previous message said "no further setup needed" — true ONLY if the
      // user actually runs `claude /login` and the credentials file appears.
      // When the user forgot or misunderstood, "No Claude credential found"
      // showed up later at first chat with no link back to this flow.
      // Set clearer expectations + offer a one-click verify that re-probes.
      const VERIFY = 'Verify Now';
      const choice2 = await vscode.window.showInformationMessage(
        'Run `claude /login` in any terminal. Once you have, click Verify Now — the extension reads `~/.claude/.credentials.json` automatically.',
        VERIFY,
      );
      if (choice2 === VERIFY) {
        const probed = await resolveCredential(
          { getOAuthToken: () => secrets.getOAuthToken(), getApiKey: () => secrets.getApiKey() },
          () => { /* swallow; verify path */ },
        );
        if (probed) {
          void vscode.window.showInformationMessage(
            `Claude credential detected (source: ${probed.source}). Chat is ready to use.`,
          );
          logger.info('onboarding', 'verify.success', { source: probed.source });
        } else {
          void vscode.window.showWarningMessage(
            'Still no Claude credential found. If you just ran `claude /login`, check that `~/.claude/.credentials.json` was created. Otherwise use "Set OAuth Token" or "Set API Key" commands.',
          );
          logger.info('onboarding', 'verify.failed');
        }
      }
      break;
    }
    default:
      break;
  }

  // Mark as seen regardless of choice so we never re-prompt unsolicited.
  await context.globalState.update(SEEN_KEY, Date.now());
}

/** Test-only: clear the seen flag so `showOnboardingIfNeeded` re-prompts. */
export async function __resetOnboarding(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(SEEN_KEY, undefined);
}
