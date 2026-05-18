/**
 * Regression: β.0 Resume Review can open a second review panel while a
 * live session's panel is already open. `ReviewPanelManager.findSessionForFile`
 * USED to return the first-inserted panel's sessionId regardless of the file
 * (a stub leftover from v0.1's single-panel assumption), which routed
 * postFileUpdated / postHunkApplied / postSetConflict to the wrong webview.
 *
 * The fix consults the orchestrator's `globalByPath` index so the message
 * goes to the panel for the file's actual owning session.
 *
 * This test exercises the exact free function the class method delegates
 * to — no real webviews required.
 */

import { describe, it, expect } from 'vitest';

import { findSessionForFile } from '../../src/reviewPanel.js';
import { asAbsPath, asSessionId, type FileReview, type SessionReview } from '../../src/types.js';

function fakeFile(filePath: string, relPath: string): FileReview {
  return {
    filePath: asAbsPath(filePath),
    relPath,
    before: '',
    after: '',
    hunks: [],
    status: 'accepted',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    warnings: [],
  };
}

function fakeSession(sid: string, files: FileReview[]): SessionReview {
  return {
    sessionId: asSessionId(sid),
    cwd: '/work',
    agentId: 'claude-code',
    startedAt: Date.now(),
    openedAt: Date.now(),
    lastAssistantMessage: null,
    files,
    state: 'open',
    metrics: { totalHunks: 0, acceptedHunks: 0, rejectedHunks: 0, bytesSnapshotted: 0 },
  };
}

interface OrchestratorStub {
  findFile(filePath: string): { session: SessionReview; file: FileReview } | null;
}

function makeOrch(sessions: SessionReview[]): OrchestratorStub {
  const byPath = new Map<string, { session: SessionReview; file: FileReview }>();
  for (const session of sessions) {
    for (const f of session.files) {
      // Last-write-wins on cross-session collisions — same as orchestrator.
      byPath.set(f.filePath, { session, file: f });
    }
  }
  return { findFile: (fp) => byPath.get(fp) ?? null };
}

describe('findSessionForFile — multi-panel routing (β.0 Resume Review regression)', () => {
  it('routes to the panel that actually owns the file, NOT the first panel inserted', () => {
    const fileA = fakeFile('/work/a.ts', 'a.ts');
    const fileB = fakeFile('/work/b.ts', 'b.ts');
    const sessionA = fakeSession('sid-A', [fileA]);
    const sessionB = fakeSession('sid-B', [fileB]);

    // Insertion order: A first (the live session), B second (the resumed one).
    const panels = new Map<ReturnType<typeof asSessionId>, unknown>();
    panels.set(asSessionId('sid-A'), {});
    panels.set(asSessionId('sid-B'), {});

    const orch = makeOrch([sessionA, sessionB]);

    expect(findSessionForFile(panels, orch, asAbsPath('/work/a.ts'))).toBe('sid-A');
    // Before the fix this returned 'sid-A' too — the bug.
    expect(findSessionForFile(panels, orch, asAbsPath('/work/b.ts'))).toBe('sid-B');
  });

  it('falls back to the first panel when the orchestrator is not wired', () => {
    const panels = new Map<ReturnType<typeof asSessionId>, unknown>();
    panels.set(asSessionId('sid-X'), {});
    panels.set(asSessionId('sid-Y'), {});
    expect(findSessionForFile(panels, undefined, asAbsPath('/work/anything.ts'))).toBe('sid-X');
  });

  it('falls back to the first panel when the file is not indexed', () => {
    const panels = new Map<ReturnType<typeof asSessionId>, unknown>();
    panels.set(asSessionId('sid-X'), {});
    panels.set(asSessionId('sid-Y'), {});
    const orch = makeOrch([]); // empty index
    expect(findSessionForFile(panels, orch, asAbsPath('/work/anything.ts'))).toBe('sid-X');
  });

  it('returns undefined when no panels are open', () => {
    const panels = new Map<ReturnType<typeof asSessionId>, unknown>();
    const orch = makeOrch([]);
    expect(findSessionForFile(panels, orch, asAbsPath('/work/x.ts'))).toBeUndefined();
  });

  it('does NOT route to a session whose panel has been disposed (file still indexed mid-dismissal)', () => {
    // Edge case: the orchestrator dismisses the session AFTER the panel closes
    // but BEFORE its file-index is cleaned. We should fall back rather than
    // route to a non-existent panel.
    const fileX = fakeFile('/work/x.ts', 'x.ts');
    const sessionGone = fakeSession('sid-gone', [fileX]);
    const sessionAlive = fakeSession('sid-alive', []);

    const panels = new Map<ReturnType<typeof asSessionId>, unknown>();
    panels.set(asSessionId('sid-alive'), {});
    // 'sid-gone' is NOT in panels — its panel was disposed.

    const orch = makeOrch([sessionGone, sessionAlive]);

    expect(findSessionForFile(panels, orch, asAbsPath('/work/x.ts'))).toBe('sid-alive');
  });
});
