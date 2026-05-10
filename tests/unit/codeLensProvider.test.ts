import { describe, it, expect, beforeEach } from 'vitest';
import { HunkCodeLensProvider, ACCEPT_HUNK_AT, REJECT_HUNK_AT, __test } from '../../src/codeLensProvider.js';
import { ReviewOrchestrator, PanelGateway } from '../../src/reviewOrchestrator.js';
import { SnapshotStore } from '../../src/snapshotStore.js';
import { Logger } from '../../src/logger.js';
import {
  AbsPath, FileReview, HunkStatus, SessionId, SessionMetrics, SessionReview,
} from '../../src/types.js';

class StubPanel implements PanelGateway {
  async openOrFocus(_session: SessionReview) {}
  postFileUpdated(_filePath: AbsPath, _file: FileReview) {}
  postHunkApplied(_filePath: AbsPath, _hunkIndex: number, _status: HunkStatus) {}
  postSessionCompleted(_sessionId: SessionId, _metrics: SessionMetrics) {}
  close(_sessionId: SessionId) {}
}

interface FakeLine { text: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }

class FakeDocument {
  constructor(public uri: { fsPath: string }, public lineCount: number) {}
  lineAt(line: number): FakeLine {
    return {
      text: '',
      range: {
        start: { line, character: 0 },
        end:   { line, character: 0 },
      },
    };
  }
}

async function seedOrchestrator(): Promise<{ orchestrator: ReviewOrchestrator; abs: AbsPath; sid: string }> {
  const store = new SnapshotStore({ maxSessionBytes: 50_000_000, maxFilesPerSession: 200 });
  const orchestrator = new ReviewOrchestrator({
    store,
    panel: new StubPanel(),
    logger: new Logger('test', 'error'),
    readFile: async () => 'one\nTWO\nthree\nfour\nFIVE\n',
  });
  const cwd = process.cwd();
  const abs = (await store.captureOriginal('sid', cwd, 'a.ts'))!;
  store.get('sid')!.originals.set(abs, 'one\ntwo\nthree\nfour\nfive\n');
  store.recordTouched('sid', cwd, 'a.ts');
  orchestrator.handleStop('sid', false, null);
  await new Promise((r) => setTimeout(r, 320));
  return { orchestrator, abs, sid: 'sid' };
}

describe('codeLensProvider — pure helpers', () => {
  it('pathsEqual normalises slashes and case', () => {
    expect(__test.pathsEqual('C:\\Foo\\Bar.ts', 'c:/foo/bar.ts')).toBe(true);
    expect(__test.pathsEqual('/a/b', '/A/B')).toBe(true);
    expect(__test.pathsEqual('/a/b', '/a/c')).toBe(false);
  });

  it('findHunksForFile returns null when no session matches', async () => {
    const { orchestrator } = await seedOrchestrator();
    const out = __test.findHunksForFile(orchestrator, '/no/such/path.ts');
    expect(out).toBeNull();
  });

  it('findHunksForFile returns the file when a session matches', async () => {
    const { orchestrator, abs } = await seedOrchestrator();
    const out = __test.findHunksForFile(orchestrator, abs);
    expect(out?.file.filePath).toBe(abs);
    expect(out?.file.hunks.length).toBeGreaterThan(0);
  });
});

describe('codeLensProvider — provideCodeLenses', () => {
  let orchestrator: ReviewOrchestrator;
  let abs: string;

  beforeEach(async () => {
    const seeded = await seedOrchestrator();
    orchestrator = seeded.orchestrator;
    abs = seeded.abs;
  });

  it('produces two lenses (Accept + Reject) per pending hunk', () => {
    const provider = new HunkCodeLensProvider(orchestrator);
    const doc = new FakeDocument({ fsPath: abs }, 100) as unknown as Parameters<HunkCodeLensProvider['provideCodeLenses']>[0];
    const lenses = provider.provideCodeLenses(doc);
    const session = orchestrator.getSession('sid')!;
    const file = session.files[0];
    expect(lenses.length).toBe(file.hunks.length * 2);
    const titles = lenses.map((l) => l.command?.title);
    expect(titles.filter((t) => t === '✓ Accept').length).toBe(file.hunks.length);
    expect(titles.filter((t) => t === '✗ Reject').length).toBe(file.hunks.length);
  });

  it('Accept lens dispatches the ACCEPT_HUNK_AT command with sid + path + index', () => {
    const provider = new HunkCodeLensProvider(orchestrator);
    const doc = new FakeDocument({ fsPath: abs }, 100) as unknown as Parameters<HunkCodeLensProvider['provideCodeLenses']>[0];
    const lenses = provider.provideCodeLenses(doc);
    const accept = lenses.find((l) => l.command?.title === '✓ Accept');
    expect(accept?.command?.command).toBe(ACCEPT_HUNK_AT);
    expect(accept?.command?.arguments?.[0]).toBe('sid');
    expect(accept?.command?.arguments?.[1]).toBe(abs);
    expect(typeof accept?.command?.arguments?.[2]).toBe('number');
  });

  it('Reject lens dispatches REJECT_HUNK_AT', () => {
    const provider = new HunkCodeLensProvider(orchestrator);
    const doc = new FakeDocument({ fsPath: abs }, 100) as unknown as Parameters<HunkCodeLensProvider['provideCodeLenses']>[0];
    const lenses = provider.provideCodeLenses(doc);
    const reject = lenses.find((l) => l.command?.title === '✗ Reject');
    expect(reject?.command?.command).toBe(REJECT_HUNK_AT);
  });

  it('decided hunks render a single read-only badge instead of accept/reject', async () => {
    const provider = new HunkCodeLensProvider(orchestrator);
    const session = orchestrator.getSession('sid')!;
    // Decide every hunk
    for (const hunk of session.files[0].hunks) {
      await orchestrator.handleHunkAction('sid', abs, hunk.index, 'accept');
    }
    const doc = new FakeDocument({ fsPath: abs }, 100) as unknown as Parameters<HunkCodeLensProvider['provideCodeLenses']>[0];
    const lenses = provider.provideCodeLenses(doc);
    expect(lenses.length).toBe(session.files[0].hunks.length);
    expect(lenses.every((l) => l.command?.title === '✓ accepted')).toBe(true);
  });

  it('non-matching documents yield zero lenses', () => {
    const provider = new HunkCodeLensProvider(orchestrator);
    const doc = new FakeDocument({ fsPath: '/does/not/match' }, 100) as unknown as Parameters<HunkCodeLensProvider['provideCodeLenses']>[0];
    expect(provider.provideCodeLenses(doc).length).toBe(0);
  });
});

describe('codeLensProvider — refresh', () => {
  it('fires the onDidChangeCodeLenses event', async () => {
    const { orchestrator } = await seedOrchestrator();
    const provider = new HunkCodeLensProvider(orchestrator);
    let fired = 0;
    provider.onDidChangeCodeLenses(() => { fired++; });
    provider.refresh();
    provider.refresh();
    expect(fired).toBe(2);
    provider.dispose();
  });
});
