import { create } from 'zustand';
import type { BuildSignal, FileReview, SessionReview, HunkStatus, SessionMetrics } from '../src/types';
import { getPersistedState, setPersistedState } from './vscode';

/**
 * Webview store (TRD §10.3).
 *
 * Zustand was chosen over Redux for bundle size (~3 KB) and selector-based
 * subscriptions: only the components that depend on a slice re-render.
 */

export type Toast = { id: number; level: 'info' | 'warn' | 'error'; message: string; ttl: number };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatThread {
  filePath: string;
  hunkIndex: number;
  turns: ChatTurn[];
  /** Streaming-in-progress text appended after the last assistant turn. */
  streaming: string | null;
  chatId: string | null;
  /** Last error, or null. `kind` lets the UI branch (auth → show login help). */
  error: { kind: string; message: string } | null;
}

/**
 * v0.4 (A5): pending drafts queue mirror. The orchestrator is source-of-truth;
 * the webview holds a local copy populated from `rejection-drafts` messages.
 */
export interface DraftEntry {
  filePath: string;
  relPath: string;
  hunkIdx: number;
  reason: string;
  ts: number;
}

export interface UiState {
  session: SessionReview | null;
  viewType: 'split' | 'unified';
  selectedFile: string | null;
  selectedHunk: number | null;
  expanded: Record<string, boolean>; // filePath → expanded
  toasts: Toast[];
  bannerMessage: string | null;

  /** Width of the file-list sidebar in pixels. Persisted via vscode.setState. */
  sidebarWidth: number;

  /** Height of the session header (change-summary banner). Persisted. */
  headerHeight: number;

  /** Option A: depth of the orchestrator's undo stack (0 ⇒ disable ↶ button). */
  undoDepth: number;

  /** Open chat thread (only one at a time in v1). */
  chat: ChatThread | null;

  /** v0.3: keyboard-shortcuts help overlay visibility. */
  helpVisible: boolean;

  /**
   * v0.4 (A4): which hunk (if any) is currently in inline-edit mode. Null
   * when no hunk is being edited. Set via the `e` key binding or the
   * "Edit" button on the hunk header.
   */
  editMode: { filePath: string; hunkIndex: number } | null;

  /**
   * v0.4 (A5): pending drafts queue. Replaced wholesale on every
   * `rejection-drafts` message from the host.
   */
  drafts: DraftEntry[];

  /** v0.4 (A5): which hunks are currently showing the inline "Add reason"
   *  textarea. Keyed by `${filePath}::${hunkIndex}`. */
  reasonInputOpen: Record<string, boolean>;

  /** v0.4 (A5): drafts section in ChatOverlay collapsed/expanded. */
  draftsExpanded: boolean;

  /**
   * v0.4 (A8 cheap): which rename-group panels are expanded on which hunks.
   * Keyed by `${filePath}::${hunkIndex}` (the hunk whose chip the user
   * clicked). Each entry shows the inline group panel below that hunk.
   */
  renameGroupOpen: Record<string, boolean>;

  /** v0.4: show-flagged-only filter (Wave 4). Persisted to memento. */
  showFlaggedOnly: boolean;

  /** v0.4: wrap-long-lines toggle (Wave 4). Persisted to memento. */
  wrapLines: boolean;

  // mutations
  setSession(session: SessionReview, viewType: 'split' | 'unified'): void;
  setViewType(v: 'split' | 'unified'): void;
  applyHunk(filePath: string, hunkIndex: number, status: HunkStatus): void;
  applyFileUpdate(filePath: string, file: FileReview): void;
  applySessionCompleted(sessionId: string, metrics: SessionMetrics): void;
  toggleExpanded(filePath: string): void;
  selectFile(filePath: string): void;
  selectHunk(hunkIndex: number): void;
  pushToast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  setBanner(msg: string | null): void;
  setSidebarWidth(px: number): void;
  setHeaderHeight(px: number): void;
  setUndoDepth(depth: number): void;

  // v0.3 — keyboard help overlay
  setHelpVisible(v: boolean): void;
  toggleHelpVisible(): void;

  // v0.4 (A4) — edit mode
  setEditMode(target: { filePath: string; hunkIndex: number } | null): void;

  // v0.4 (A5) — drafts queue + reason input
  setDrafts(drafts: DraftEntry[]): void;
  toggleReasonInput(filePath: string, hunkIndex: number, open?: boolean): void;
  setDraftsExpanded(v: boolean): void;

  // v0.4 (A8) — rename group panel toggle
  toggleRenameGroupPanel(filePath: string, hunkIndex: number, open?: boolean): void;

  // v0.4 (Wave 4) — view filters
  setShowFlaggedOnly(v: boolean): void;
  setWrapLines(v: boolean): void;

  // v0.5 (build signal) — session-aggregate banner state
  setBuildSignal(signal: BuildSignal | null): void;

  // chat
  openChat(filePath: string, hunkIndex: number): void;
  closeChat(): void;
  appendUserTurn(content: string, chatId: string): void;
  appendStreamingDelta(chatId: string, text: string): void;
  finaliseStreaming(chatId: string): void;
  setChatError(chatId: string, error: { kind: string; message: string }): void;
}

let toastCounter = 1;

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 260;

const HEADER_MIN = 56;
const HEADER_MAX = 600;
const HEADER_DEFAULT = 140;

interface PersistedState {
  sidebarWidth?: number;
  headerHeight?: number;
  viewType?: 'split' | 'unified';
  /** v0.4 (Wave 4): persisted filter preferences. */
  showFlaggedOnly?: boolean;
  wrapLines?: boolean;
}
const persisted = getPersistedState<PersistedState>() ?? {};
const initialSidebarWidth = clamp(persisted.sidebarWidth ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX);
const initialHeaderHeight = clamp(persisted.headerHeight ?? HEADER_DEFAULT, HEADER_MIN, HEADER_MAX);
const initialShowFlaggedOnly = persisted.showFlaggedOnly ?? false;
const initialWrapLines       = persisted.wrapLines       ?? false;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const useUi = create<UiState>((set, get) => ({
  session: null,
  viewType: 'split',
  selectedFile: null,
  selectedHunk: null,
  expanded: {},
  toasts: [],
  bannerMessage: null,
  sidebarWidth: initialSidebarWidth,
  headerHeight: initialHeaderHeight,
  undoDepth: 0,
  helpVisible: false,
  editMode: null,
  drafts: [],
  reasonInputOpen: {},
  draftsExpanded: false,
  renameGroupOpen: {},
  showFlaggedOnly: initialShowFlaggedOnly,
  wrapLines: initialWrapLines,

  setSession(session, viewType) {
    const expanded: Record<string, boolean> = {};
    // Eagerly expand only the first file (lazy mount of the rest is in the component).
    if (session.files[0]) expanded[session.files[0].filePath] = true;
    set({
      session,
      viewType,
      selectedFile: session.files[0]?.filePath ?? null,
      selectedHunk: session.files[0]?.hunks[0]?.index ?? null,
      expanded,
      bannerMessage: session.lastAssistantMessage,
    });
  },

  setViewType(v) {
    set({ viewType: v });
  },

  applyHunk(filePath, hunkIndex, status) {
    const session = get().session;
    if (!session) return;
    const next: SessionReview = {
      ...session,
      files: session.files.map((f) =>
        f.filePath !== filePath ? f : {
          ...f,
          hunks: f.hunks.map((h) => h.index === hunkIndex ? { ...h, status, decidedAt: Date.now() } : h),
        },
      ),
    };
    set({ session: next });
  },

  applyFileUpdate(filePath, file) {
    const session = get().session;
    if (!session) return;
    set({
      session: {
        ...session,
        files: session.files.map((f) => f.filePath === filePath ? file : f),
      },
    });
  },

  applySessionCompleted(_sessionId, _metrics) {
    set((s) => ({ ...s, bannerMessage: 'All hunks reviewed.' }));
  },

  toggleExpanded(filePath) {
    set((s) => ({ expanded: { ...s.expanded, [filePath]: !s.expanded[filePath] } }));
  },

  selectFile(filePath) {
    set({ selectedFile: filePath, selectedHunk: 0 });
  },

  selectHunk(hunkIndex) {
    set({ selectedHunk: hunkIndex });
  },

  pushToast(t) {
    const id = toastCounter++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.ttl);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setBanner(msg) {
    set({ bannerMessage: msg });
  },

  setSidebarWidth(px) {
    const w = clamp(Math.round(px), SIDEBAR_MIN, SIDEBAR_MAX);
    set({ sidebarWidth: w });
    // Persist asynchronously — vscode.setState is sync but we don't want
    // it on the drag hot path more often than necessary.
    setPersistedState({ ...(getPersistedState<PersistedState>() ?? {}), sidebarWidth: w });
  },

  setHeaderHeight(px) {
    const h = clamp(Math.round(px), HEADER_MIN, HEADER_MAX);
    set({ headerHeight: h });
    setPersistedState({ ...(getPersistedState<PersistedState>() ?? {}), headerHeight: h });
  },

  setUndoDepth(depth) {
    set({ undoDepth: Math.max(0, Math.floor(depth)) });
  },

  setHelpVisible(v) {
    set({ helpVisible: v });
  },

  toggleHelpVisible() {
    set((s) => ({ helpVisible: !s.helpVisible }));
  },

  // -- v0.4 (A4) ----------------------------------------------------------

  setEditMode(target) {
    set({ editMode: target });
  },

  // -- v0.4 (A5) ----------------------------------------------------------

  setDrafts(drafts) {
    set({ drafts });
  },

  toggleReasonInput(filePath, hunkIndex, open) {
    const key = `${filePath}::${hunkIndex}`;
    set((s) => {
      const wasOpen = !!s.reasonInputOpen[key];
      const next = open === undefined ? !wasOpen : open;
      const map = { ...s.reasonInputOpen };
      if (next) map[key] = true;
      else delete map[key];
      return { reasonInputOpen: map };
    });
  },

  setDraftsExpanded(v) {
    set({ draftsExpanded: v });
  },

  // -- v0.4 (A8 cheap) ----------------------------------------------------

  toggleRenameGroupPanel(filePath, hunkIndex, open) {
    const key = `${filePath}::${hunkIndex}`;
    set((s) => {
      const wasOpen = !!s.renameGroupOpen[key];
      const next = open === undefined ? !wasOpen : open;
      const map = { ...s.renameGroupOpen };
      if (next) map[key] = true;
      else delete map[key];
      return { renameGroupOpen: map };
    });
  },

  // -- v0.4 (Wave 4) -----------------------------------------------------

  setShowFlaggedOnly(v) {
    set({ showFlaggedOnly: v });
    setPersistedState({ ...(getPersistedState<PersistedState>() ?? {}), showFlaggedOnly: v });
  },

  setWrapLines(v) {
    set({ wrapLines: v });
    setPersistedState({ ...(getPersistedState<PersistedState>() ?? {}), wrapLines: v });
  },

  // -- v0.5 (build signal) ----------------------------------------------

  /**
   * Updates the session's `buildSignal` aggregate in-place. The webview
   * uses this to drive the session-header banner; per-file `buildStatus`
   * and per-hunk `buildErrors` ride along on `file-updated` messages and
   * are applied by `applyFileUpdate` automatically.
   */
  setBuildSignal(signal) {
    const session = get().session;
    if (!session) return;
    if (signal === null) {
      const next = { ...session };
      delete next.buildSignal;
      set({ session: next });
    } else {
      set({ session: { ...session, buildSignal: signal } });
    }
  },

  // -- chat ---------------------------------------------------------------

  chat: null,

  openChat(filePath, hunkIndex) {
    const current = get().chat;
    if (current && current.filePath === filePath && current.hunkIndex === hunkIndex) {
      return; // already open on this hunk
    }
    set({
      chat: { filePath, hunkIndex, turns: [], streaming: null, chatId: null, error: null },
    });
  },

  closeChat() {
    set({ chat: null });
  },

  appendUserTurn(content, chatId) {
    const chat = get().chat;
    if (!chat) return;
    set({
      chat: {
        ...chat,
        turns: [...chat.turns, { role: 'user', content }],
        streaming: '',
        chatId,
        error: null,
      },
    });
  },

  appendStreamingDelta(chatId, text) {
    const chat = get().chat;
    if (!chat || chat.chatId !== chatId) return;
    set({ chat: { ...chat, streaming: (chat.streaming ?? '') + text } });
  },

  finaliseStreaming(chatId) {
    const chat = get().chat;
    if (!chat || chat.chatId !== chatId) return;
    const text = chat.streaming ?? '';
    if (text.length === 0) {
      set({ chat: { ...chat, streaming: null, chatId: null } });
      return;
    }
    set({
      chat: {
        ...chat,
        turns: [...chat.turns, { role: 'assistant', content: text }],
        streaming: null,
        chatId: null,
      },
    });
  },

  setChatError(chatId, error) {
    const chat = get().chat;
    if (!chat || chat.chatId !== chatId) return;
    // Drop any partial streaming text; surface error to user. Critically,
    // clear `chatId` too — the stream is over, so the composer must unlock
    // (the "Streaming…" lock keys off `chatId`). Without this the Send
    // button stays frozen on "Streaming…" forever and the user cannot
    // retry even after a transient error (rate-limit / network).
    set({ chat: { ...chat, streaming: null, chatId: null, error } });
  },
}));
