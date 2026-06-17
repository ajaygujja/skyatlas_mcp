#!/usr/bin/env node
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildIndex } from './index/indexer.js';
import { startWatcher } from './index/watcher.js';
import type { ProjectIndex } from './index/project-index.js';
import { registerGetProjectMap } from './tools/get-project-map.js';
import { registerFindSymbol } from './tools/find-symbol.js';
import { registerGetSymbol } from './tools/get-symbol.js';
import { registerGetWidgetTree } from './tools/get-widget-tree.js';
import { registerGetRouteGraph } from './tools/get-route-graph.js';
import { registerFindStateWiring } from './tools/find-state-wiring.js';
import { logger } from './shared/logger.js';

const SERVER_NAME = 'skyatlas';
const SERVER_VERSION = '0.1.0';

export function createServer(getIndex: () => Promise<ProjectIndex>): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerGetProjectMap(server, getIndex);
  registerFindSymbol(server, getIndex);
  registerGetSymbol(server, getIndex);
  registerGetWidgetTree(server, getIndex);
  registerGetRouteGraph(server, getIndex);
  registerFindStateWiring(server, getIndex);
  return server;
}

function resolveWorkspaceRoot(): string {
  const root = resolve(process.argv[2] ?? process.cwd());
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    logger.error('workspace root is not a directory', { root });
    process.exit(1);
  }
  return root;
}

async function main(): Promise<void> {
  const root = resolveWorkspaceRoot();

  // Index builds in the background; the MCP handshake completes immediately
  // and tool calls await readiness. A failed build is reported per-call, not
  // by killing the server (§9.4 graceful degradation).
  const indexPromise = buildIndex(root).then(({ index }) => index);
  indexPromise.catch((err: unknown) => {
    logger.error('index build failed', { error: String(err) });
  });

  // Keep the index fresh as files change (§8 Phase 4). Starts only after the
  // initial build succeeds, against that same instance; a watcher failure is
  // logged and swallowed — stale-but-alive beats dead (§9.4). The handle is
  // captured (not discarded) so shutdown can stop it: the watcher's open fs
  // handles keep the event loop alive, so without an explicit close the process
  // would never exit on its own.
  const watcherPromise = indexPromise
    .then((index) => startWatcher(root, index))
    .catch((err: unknown) => {
      logger.error('watcher failed to start; index will not auto-refresh', {
        error: String(err),
      });
      return undefined;
    });

  const server = createServer(() => indexPromise);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server started', { name: SERVER_NAME, version: SERVER_VERSION, root });

  // Lifecycle: a stdio MCP server is a child of its client. When the client
  // disconnects it closes our stdin (and may send SIGTERM/SIGINT). We MUST exit
  // then — the watcher pins the event loop, so a server that ignores disconnect
  // lingers as an orphan. On reconnect a fresh instance spawns while the old one
  // survives; orphans accumulate, each still watching, multiplying fd pressure
  // until the OS hands back EMFILE. Idempotent so overlapping triggers (stdin
  // close + a signal) shut down exactly once.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    // A clean stop (flush the cache, close watches) is best-effort; a prompt
    // exit is mandatory. Force it if a wedged close()/flush can't settle fast.
    setTimeout(() => process.exit(0), 2000).unref();
    void watcherPromise
      .then((handle) => handle?.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  };

  process.stdin.on('end', () => shutdown('stdin ended'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when executed as the CLI entrypoint — importing this module (e.g. for
// `createServer` in tests) must have no side effects: no stdio transport, no index
// build, no watcher spawned on whatever cwd the test runner happens to be in.
const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    logger.error('fatal', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
