/**
 * Mock Claude Code hook sender — for development and integration testing.
 *
 * Usage:
 *   node --experimental-strip-types tools/mock-claude.ts \
 *     --port 53117 --token <hex> --session abc --cwd /path/to/work \
 *     --files src/a.ts src/b.ts
 *
 * Replays a canonical sequence:
 *   1. PreToolUse  for each file (snapshot before)
 *   2. PostToolUse for each file (mark touched)
 *   3. Stop                       (open review)
 *
 * The script does NOT modify files on disk. Pair it with a manual edit
 * step (or pipe `sed` between phases) to simulate a real Claude session.
 */

interface Args {
  port: number;
  token: string;
  session: string;
  cwd: string;
  files: string[];
  message: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':    out.port    = Number(argv[++i]); break;
      case '--token':   out.token   = argv[++i];          break;
      case '--session': out.session = argv[++i];          break;
      case '--cwd':     out.cwd     = argv[++i];          break;
      case '--message': out.message = argv[++i];          break;
      case '--files':
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          out.files!.push(argv[++i]);
        }
        break;
    }
  }
  if (out.port == null || !out.token || !out.session || !out.cwd || !out.files?.length) {
    console.error('Usage: mock-claude --port N --token HEX --session ID --cwd PATH --files A B …');
    process.exit(2);
  }
  return {
    port:    out.port,
    token:   out.token,
    session: out.session,
    cwd:     out.cwd,
    files:   out.files!,
    message: out.message ?? 'Mock session complete.',
  };
}

async function post(url: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${args.port}`;

  for (const f of args.files) {
    const r = await post(`${base}/pre-tool-use`, args.token, {
      session_id: args.session,
      tool_name:  'Edit',
      tool_input: { file_path: f },
      cwd:        args.cwd,
    });
    console.log(`[pre]  ${f} → ${r.status}`);
  }
  for (const f of args.files) {
    const r = await post(`${base}/post-tool-use`, args.token, {
      session_id: args.session,
      tool_name:  'Edit',
      tool_input: { file_path: f },
      tool_result:{ success: true },
      cwd:        args.cwd,
    });
    console.log(`[post] ${f} → ${r.status}`);
  }
  const stop = await post(`${base}/stop`, args.token, {
    session_id:             args.session,
    stop_hook_active:       false,
    last_assistant_message: args.message,
  });
  console.log(`[stop] → ${stop.status}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
