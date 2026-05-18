import { useEffect } from 'react';
import { useUi } from './store';
import { send } from './vscode';
import { SessionHeader } from './components/SessionHeader';
import { FileList } from './components/FileList';
import { DiffPane } from './components/DiffPane';
import { ChatOverlay } from './components/ChatOverlay';
import { Splitter } from './components/Splitter';
import { HeaderSplitter } from './components/HeaderSplitter';
import type { HostToWebview } from '../src/messages';
import styles from './styles/App.module.css';

export function App(): JSX.Element {
  const session = useUi((s) => s.session);
  const viewType = useUi((s) => s.viewType);
  const banner = useUi((s) => s.bannerMessage);
  const setSession = useUi((s) => s.setSession);
  const applyHunk = useUi((s) => s.applyHunk);
  const applyFileUpdate = useUi((s) => s.applyFileUpdate);
  const applySessionCompleted = useUi((s) => s.applySessionCompleted);
  const setViewType = useUi((s) => s.setViewType);
  const pushToast = useUi((s) => s.pushToast);
  const selectedFile = useUi((s) => s.selectedFile);
  const chat = useUi((s) => s.chat);
  const closeChat = useUi((s) => s.closeChat);
  const appendStreamingDelta = useUi((s) => s.appendStreamingDelta);
  const finaliseStreaming = useUi((s) => s.finaliseStreaming);
  const setChatError = useUi((s) => s.setChatError);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const headerHeight = useUi((s) => s.headerHeight);
  const setUndoDepth = useUi((s) => s.setUndoDepth);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const msg = ev.data as HostToWebview;
      switch (msg.type) {
        case 'init':
          setSession(msg.session, msg.viewType);
          break;
        case 'hunk-applied':
          applyHunk(msg.filePath, msg.hunkIndex, msg.action as ('pending' | 'accepted' | 'rejected'));
          break;
        case 'file-updated':
          applyFileUpdate(msg.filePath, msg.file);
          break;
        case 'session-completed':
          applySessionCompleted(msg.sessionId, msg.metrics);
          pushToast({ level: 'info', message: 'All hunks reviewed.', ttl: 4000 });
          break;
        case 'view-type':
          setViewType(msg.viewType);
          break;
        case 'warning':
          pushToast({ level: 'warn', message: msg.message, ttl: 6000 });
          break;
        case 'undo-stack-changed':
          setUndoDepth(msg.depth);
          break;
        case 'set-conflict-warning':
          pushToast({
            level: 'warn',
            message: `Coupled hunks: rejecting hunk #${msg.attemptedHunkIndex + 1} requires also rejecting hunk(s) ${msg.conflictingHunks.map((i) => `#${i + 1}`).join(', ')}.`,
            ttl: 8000,
          });
          break;
        case 'chat-delta':
          appendStreamingDelta(msg.chatId, msg.text);
          break;
        case 'chat-done':
          finaliseStreaming(msg.chatId);
          break;
        case 'chat-error':
          setChatError(msg.chatId, { kind: msg.error.kind, message: msg.error.message });
          if (!msg.error.retriable && msg.error.kind !== 'auth' && msg.error.kind !== 'no-key') {
            // Auth errors get an inline help panel; don't double-up with a toast.
            pushToast({ level: 'error', message: msg.error.message, ttl: 6000 });
          }
          break;
      }
    }
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [setSession, applyHunk, applyFileUpdate, applySessionCompleted, setViewType, pushToast, appendStreamingDelta, finaliseStreaming, setChatError, setUndoDepth]);

  if (!session) {
    return (
      <main className={styles.empty}>
        <p>Waiting for Claude Code session…</p>
      </main>
    );
  }

  if (session.files.length === 0) {
    return (
      <main className={styles.empty}>
        <p>No file changes in this session.</p>
      </main>
    );
  }

  const focused = session.files.find((f) => f.filePath === selectedFile) ?? session.files[0];
  const chatHunk = chat
    ? session.files.find((f) => f.filePath === chat.filePath)?.hunks[chat.hunkIndex]
    : null;

  return (
    <main className={styles.layout}>
      <div
        className={styles.headerContainer}
        style={{ height: headerHeight }}
      >
        <SessionHeader session={session} viewType={viewType} banner={banner} />
      </div>
      <HeaderSplitter />
      <div className={styles.body}>
        <aside className={styles.sidebar} style={{ width: sidebarWidth }}>
          <FileList files={session.files} />
        </aside>
        <Splitter />
        <section className={styles.content} aria-label="Diff for selected file">
          <DiffPane file={focused} />
        </section>
      </div>
      {chat && chatHunk ? (
        <ChatOverlay filePath={chat.filePath} hunk={chatHunk} onClose={closeChat} />
      ) : null}
    </main>
  );
}
