import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import type { HunkReview } from '../../src/types';
import { useUi } from '../store';
import { send } from '../vscode';
import styles from '../styles/ChatOverlay.module.css';

interface Props {
  filePath: string;
  hunk: HunkReview;
  onClose(): void;
}

/**
 * Slide-in chat overlay scoped to a single hunk (TRD §6.6).
 *
 * Streaming render
 * ----------------
 * We append deltas to a `streaming` slice on the store, render them via
 * `react-markdown` + `rehype-sanitize`. No `dangerouslySetInnerHTML`.
 *
 * Cancellation
 * ------------
 * Closing the overlay sends `chat-cancel` for the current chatId so any
 * in-flight stream stops at the host. The host also cancels on panel
 * close via `chatService.cancelSession`.
 */
export function ChatOverlay({ filePath, hunk, onClose }: Props): JSX.Element {
  const chat = useUi((s) => s.chat);
  const appendUserTurn = useUi((s) => s.appendUserTurn);
  const drafts = useUi((s) => s.drafts);
  const draftsExpanded = useUi((s) => s.draftsExpanded);
  const setDraftsExpanded = useUi((s) => s.setDraftsExpanded);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const onSendDrafts = () => {
    if (chat?.chatId) return; // streaming in progress
    if (drafts.length === 0) return;
    const chatId = makeUuidV4();
    // Surface the composed prompt locally too so the chat transcript shows
    // what was actually sent to Claude (matches existing pattern of
    // appendUserTurn before postMessage).
    const localText = composeDraftsPreview(drafts);
    appendUserTurn(localText, chatId);
    send({
      type: 'send-rejection-feedback',
      chatId,
      filePath,
      hunkIndex: hunk.index,
    });
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cancel any in-flight stream when the overlay unmounts.
  useEffect(() => {
    return () => {
      const last = useUi.getState().chat;
      if (last?.chatId) send({ type: 'chat-cancel', chatId: last.chatId });
    };
  }, []);

  const onSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    if (chat?.chatId) return; // streaming in progress
    const chatId = makeUuidV4();
    appendUserTurn(trimmed, chatId);
    send({ type: 'chat-message', filePath, hunkIndex: hunk.index, message: trimmed, chatId });
    setInput('');
  };

  const onCancel = () => {
    if (chat?.chatId) send({ type: 'chat-cancel', chatId: chat.chatId });
  };

  return (
    <aside className={styles.root} role="dialog" aria-label="Ask Claude about this hunk">
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>💬 Ask Claude</h2>
          <p className={styles.subtitle}>{hunk.header}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close chat">
          ✕
        </button>
      </header>

      <div className={styles.transcript} aria-live="polite">
        {chat?.turns.length === 0 && !chat?.streaming ? (
          <p className={styles.empty}>Ask anything about this hunk — accept/reject decisions, security implications, refactor suggestions.</p>
        ) : null}
        {chat?.turns.map((turn, i) => (
          <div key={i} className={turn.role === 'user' ? styles.userTurn : styles.assistantTurn}>
            <span className={styles.role}>{turn.role === 'user' ? 'You' : 'Claude'}</span>
            <div className={styles.content}>
              {turn.role === 'assistant'
                ? <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{turn.content}</ReactMarkdown>
                : <pre className={styles.userText}>{turn.content}</pre>}
            </div>
          </div>
        ))}
        {chat?.streaming != null ? (
          <div className={styles.assistantTurn}>
            <span className={styles.role}>Claude</span>
            <div className={styles.content}>
              <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{chat.streaming || '…'}</ReactMarkdown>
            </div>
          </div>
        ) : null}
        {chat?.error ? (
          chat.error.kind === 'auth' || chat.error.kind === 'no-key'
            ? <AuthHelp kind={chat.error.kind} message={chat.error.message} />
            : <div className={styles.error} role="alert">
                <strong>Error:</strong> {chat.error.message}
              </div>
        ) : null}
      </div>

      <div className={styles.quickActions}>
        <button
          type="button"
          className={styles.quickAccept}
          onClick={() => send({ type: 'accept-hunk', filePath, hunkIndex: hunk.index })}
          disabled={hunk.status !== 'pending'}
        >
          ✓ Accept hunk
        </button>
        <button
          type="button"
          className={styles.quickReject}
          onClick={() => send({ type: 'reject-hunk', filePath, hunkIndex: hunk.index })}
          disabled={hunk.status !== 'pending'}
        >
          ✗ Reject hunk
        </button>
      </div>

      {/* v0.4 (A5): pending drafts queue inline section. Collapsed by
          default; expand reveals the list + Send-all action. Hidden
          entirely when empty so the chat layout stays clean. */}
      {drafts.length > 0 && (
        <section className={styles.draftsSection} aria-label="Pending feedback drafts">
          <button
            type="button"
            className={styles.draftsHeader}
            onClick={() => setDraftsExpanded(!draftsExpanded)}
            aria-expanded={draftsExpanded}
          >
            <span>📝 Pending feedback ({drafts.length})</span>
            <span className={styles.draftsToggle}>{draftsExpanded ? '▾' : '▸'}</span>
          </button>
          {draftsExpanded && (
            <div className={styles.draftsBody}>
              <ul className={styles.draftsList}>
                {drafts.map((d) => (
                  <li key={`${d.filePath}::${d.hunkIdx}::${d.ts}`} className={styles.draftRow}>
                    <code className={styles.draftPath}>{d.relPath}</code>
                    <span className={styles.draftHunk}>hunk {d.hunkIdx + 1}</span>
                    <span className={styles.draftReason}>"{d.reason}"</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={styles.draftsSendAll}
                onClick={onSendDrafts}
                disabled={!!chat?.chatId}
              >
                {chat?.chatId ? 'Streaming…' : `Send all to Claude (${drafts.length})`}
              </button>
            </div>
          )}
        </section>
      )}

      <form className={styles.composer} onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e as unknown as React.FormEvent);
            }
          }}
          placeholder="Ask a follow-up… (Enter to send, Shift+Enter for newline)"
          className={styles.input}
          rows={3}
          aria-label="Chat message"
        />
        <div className={styles.composerActions}>
          {chat?.chatId ? (
            <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
          ) : null}
          <button type="submit" className={styles.send} disabled={!input.trim() || !!chat?.chatId}>
            {chat?.chatId ? 'Streaming…' : 'Send →'}
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * v0.4 (A5): preview text rendered locally when the user clicks "Send all
 * to Claude" so the chat transcript shows what was actually sent. Mirrors
 * the host's `composeBatchFeedbackMessage`. Kept here to avoid host→webview
 * import; the host re-composes the same shape from its own drafts source
 * of truth before streaming.
 */
function composeDraftsPreview(
  drafts: ReadonlyArray<{ relPath: string; hunkIdx: number; reason: string }>,
): string {
  const lines: string[] = [];
  lines.push(`I rejected ${drafts.length} hunk${drafts.length === 1 ? '' : 's'} in this turn. Please rework with these in mind:`);
  lines.push('');
  for (const d of drafts) {
    const oneLine = d.reason.replace(/\s+/g, ' ').trim();
    lines.push(`• ${d.relPath} hunk ${d.hunkIdx + 1}: "${oneLine}"`);
  }
  return lines.join('\n');
}

/**
 * Inline help panel shown when chat fails with `auth` (401) or `no-key`.
 * Surfaces the actual resolution steps a user can take, with command
 * buttons that route through the existing host commands — keeps secrets
 * inside the host process, never crosses the postMessage boundary.
 */
function AuthHelp({ kind, message }: { kind: string; message: string }): JSX.Element {
  const isExpired = kind === 'auth';
  return (
    <div className={styles.authHelp} role="alert">
      <strong className={styles.authHelpTitle}>
        {isExpired ? 'Authentication failed' : 'No Claude credential found'}
      </strong>
      <p className={styles.authHelpMsg}>{message}</p>

      <p className={styles.authHelpSection}>
        {isExpired
          ? 'Your token may have expired or been revoked. Pick one:'
          : 'Pick the path that matches how you use Claude:'}
      </p>

      <ol className={styles.authHelpSteps}>
        <li>
          <strong>Claude Pro / Max user?</strong>
          <ul>
            <li>
              Run <code>claude /login</code> in any terminal — that refreshes{' '}
              <code>~/.claude/.credentials.json</code>, which the extension reads automatically.
            </li>
            <li>
              Or paste your OAuth token (<code>sk-ant-oat01-…</code>) directly:&nbsp;
              <button
                type="button"
                className={styles.authBtn}
                onClick={() => send({ type: 'set-oauth-token' })}
              >
                Set OAuth token
              </button>
            </li>
            <li>
              Or set <code>CLAUDE_CODE_OAUTH_TOKEN</code> in the VS Code launch environment.
            </li>
          </ul>
        </li>
        <li>
          <strong>Have an Anthropic API key?</strong>
          <ul>
            <li>
              <button
                type="button"
                className={styles.authBtn}
                onClick={() => send({ type: 'set-api-key' })}
              >
                Set API key
              </button>
              &nbsp;(stored in OS keychain via VS Code SecretStorage).
            </li>
          </ul>
        </li>
      </ol>

      <p className={styles.authHelpSection}>Then verify which source the extension is using:</p>
      <button
        type="button"
        className={styles.authBtn}
        onClick={() => send({ type: 'use-claude-code-auth' })}
      >
        Probe & report auth source
      </button>
    </div>
  );
}

/**
 * Tiny UUID v4 generator. Avoids pulling `uuid` into the webview bundle since
 * we only need it once per user message.
 */
function makeUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
