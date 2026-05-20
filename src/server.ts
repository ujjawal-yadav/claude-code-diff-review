import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as crypto from 'node:crypto';

import { Logger } from './logger.js';
import {
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
} from './messages.js';
import { agentAdapters } from './adapters/index.js';

/**
 * Loopback HTTP server (TRD §5.2, §14.2).
 *
 * Hot-path requirements (TRD §15):
 *   - P99 < 100 ms per route.
 *   - 127.0.0.1 only.
 *   - Constant-time bearer compare.
 *   - Body cap 10 MB.
 *   - Schema mismatch → 200 `{}` + warn log (do not block Claude Code's flow).
 *
 * Performance notes
 * -----------------
 *   - Fastify's `bodyLimit` rejects oversize payloads before parse.
 *   - The expected bearer is encoded to a Buffer once at server start; auth
 *     middleware re-encodes only the supplied header.
 *   - Length check + `timingSafeEqual` is applied even when lengths differ
 *     (using a dummy equal-length Buffer) to avoid early-return timing leaks.
 *   - All hot-path I/O is delegated to handlers; the server itself never
 *     touches the filesystem.
 */

export interface ServerOptions {
  preferredPort: number;
  bearerToken: string;
  logger: Logger;
  onPreToolUse:  (payload: PreToolUsePayload)  => Promise<void> | void;
  onPostToolUse: (payload: PostToolUsePayload) => Promise<void> | void;
  onStop:        (payload: StopPayload)        => Promise<void> | void;
  /**
   * Observability hook (2026-05-19): invoked on every 401 response so the
   * extension-side burst detector can surface an actionable toast. Wrapped
   * in `try/catch` at the call site so a broken detector cannot turn a
   * 401 into a 500.
   */
  onAuthFailure?: () => void;
}

export interface ServerHandle {
  port: number;
  dispose(): Promise<void>;
}

const HOST = '127.0.0.1';
const BODY_LIMIT = 10 * 1024 * 1024; // 10 MB
const HANDLER_TIMEOUT_MS = 8_000;

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { logger } = opts;
  const expectedToken = Buffer.from(opts.bearerToken, 'utf8');
  const dummy = Buffer.alloc(expectedToken.length, 0); // for length-mismatch path

  const fastify: FastifyInstance = Fastify({
    bodyLimit: BODY_LIMIT,
    disableRequestLogging: true,
    trustProxy: false,
    logger: false,
  });

  fastify.addHook('onRequest', async (req, reply) => {
    if (!authorize(req.headers.authorization, expectedToken, dummy)) {
      // Length-only signals — never log the full token bytes. The first 13
      // chars capture "Bearer " (7) plus 6 token chars — enough to debug
      // scheme-mismatch (`bearer`/`Basic`/raw-token cases) without leaking
      // enough of a valid token to be useful to an attacker against a
      // localhost-only server with retry-throttled responses.
      const header = req.headers.authorization;
      const hadHeader = typeof header === 'string';
      const headerLooksLikeBearer = hadHeader && header.startsWith('Bearer ');
      logger.warn('server', 'auth.failed', {
        route: req.url,
        hadHeader,
        headerLooksLikeBearer,
        headerPrefix: hadHeader ? header.slice(0, 13) : null,
        suppliedLen: headerLooksLikeBearer ? Math.max(0, header.length - 'Bearer '.length) : 0,
        expectedLen: opts.bearerToken.length,
      });
      try { opts.onAuthFailure?.(); } catch { /* never turn a 401 into a 500 */ }
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    return;
  });

  fastify.get('/health', async () => ({ ok: true, version: '0.1.0' }));

  // Parsing + tool-name gating is delegated to the registered agent
  // adapter (M9.4a). Today only Claude Code is wired in; the cast is
  // safe because the registry is built at module load and that entry
  // is guaranteed present (see src/adapters/index.ts).
  const adapter = agentAdapters.get('claude-code')!;

  fastify.post('/pre-tool-use', wrap(logger, '/pre-tool-use', async (req) => {
    const normalised = adapter.parsePreToolUse(req.body);
    if (!normalised) {
      // Either schema-invalid or a non-edit tool — silently drop.
      // (Schema-validity is still observable via logger.warn from the
      // adapter when we wire that in M9.4b; today the contract is
      // "return null on either reason".)
      const validated = PreToolUsePayload.safeParse(req.body);
      if (!validated.success) {
        logger.warn('server', 'payload.invalid', { route: '/pre-tool-use', issues: validated.error.issues });
      }
      return {};
    }
    // Existing callback contract (back-compat with M1 tests + extension.ts)
    // takes the raw PreToolUsePayload. Re-parse to satisfy the type; the
    // adapter just succeeded, so this `parse` cannot throw.
    await opts.onPreToolUse(PreToolUsePayload.parse(req.body));
    return {};
  }));

  fastify.post('/post-tool-use', wrap(logger, '/post-tool-use', async (req) => {
    const normalised = adapter.parsePostToolUse(req.body);
    if (!normalised) {
      const validated = PostToolUsePayload.safeParse(req.body);
      if (!validated.success) {
        logger.warn('server', 'payload.invalid', { route: '/post-tool-use', issues: validated.error.issues });
      }
      return {};
    }
    await opts.onPostToolUse(PostToolUsePayload.parse(req.body));
    return {};
  }));

  fastify.post('/stop', wrap(logger, '/stop', async (req) => {
    const normalised = adapter.parseStop(req.body);
    if (!normalised) {
      const validated = StopPayload.safeParse(req.body);
      if (!validated.success) {
        logger.warn('server', 'payload.invalid', { route: '/stop', issues: validated.error.issues });
      }
      return {};
    }
    await opts.onStop(StopPayload.parse(req.body));
    return {};
  }));

  // Catch-all 404.
  fastify.setNotFoundHandler((_req, reply) => reply.code(404).send());

  const port = await tryListen(fastify, opts.preferredPort, logger);
  logger.info('server', 'started', { port, host: HOST });

  return {
    port,
    async dispose() {
      try {
        await fastify.close();
        logger.info('server', 'stopped', { port });
      } catch (err) {
        logger.error('server', 'stop.error', { err: String(err) });
      }
    },
  };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

function matchesEditTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function authorize(header: string | undefined, expected: Buffer, dummy: Buffer): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    // Compare against dummy to keep timing comparable to the wrong-length path.
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  if (supplied.length !== expected.length) {
    crypto.timingSafeEqual(dummy, dummy); // constant-time placeholder
    return false;
  }
  return crypto.timingSafeEqual(supplied, expected);
}

function wrap(
  logger: Logger,
  route: string,
  fn: (req: FastifyRequest) => Promise<unknown>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (req, _reply) => {
    const start = process.hrtime.bigint();
    try {
      const result = await Promise.race([
        fn(req),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('handler-timeout')), HANDLER_TIMEOUT_MS),
        ),
      ]);
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      if (ms > 100) logger.warn('server', 'route.slow', { route, ms });
      else logger.debug('server', 'route.ok', { route, ms });
      return result;
    } catch (err) {
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      logger.error('server', 'route.error', { route, ms, err: String(err) });
      // Always respond 200 `{}` so Claude Code's flow is never blocked.
      return {};
    }
  };
}

async function tryListen(fastify: FastifyInstance, preferred: number, logger: Logger): Promise<number> {
  try {
    const address = await fastify.listen({ host: HOST, port: preferred });
    return extractPort(address) ?? preferred;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferred !== 0) {
      logger.warn('server', 'port.in-use', { preferred });
      const address = await fastify.listen({ host: HOST, port: 0 });
      const port = extractPort(address);
      if (port == null) throw new Error('Failed to resolve dynamic port');
      return port;
    }
    throw err;
  }
}

function extractPort(addressString: string): number | null {
  // Fastify's listen() returns a string like "http://127.0.0.1:53117"
  const match = /:(\d+)$/.exec(addressString);
  return match ? Number(match[1]) : null;
}

/** Exported for tests. */
export const __test = { authorize, matchesEditTool, extractPort };
