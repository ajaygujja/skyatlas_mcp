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
  // logged and swallowed — stale-but-alive beats dead (§9.4).
  void indexPromise
    .then((index) => startWatcher(root, index))
    .catch((err: unknown) => {
      logger.error('watcher failed to start; index will not auto-refresh', {
        error: String(err),
      });
    });

  const server = createServer(() => indexPromise);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server started', { name: SERVER_NAME, version: SERVER_VERSION, root });
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
