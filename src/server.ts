#!/usr/bin/env node
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildIndex } from './index/indexer.js';
import type { ProjectIndex } from './index/project-index.js';
import { registerGetProjectMap } from './tools/get-project-map.js';
import { registerFindSymbol } from './tools/find-symbol.js';
import { registerGetSymbol } from './tools/get-symbol.js';
import { registerGetWidgetTree } from './tools/get-widget-tree.js';
import { registerGetRouteGraph } from './tools/get-route-graph.js';
import { logger } from './shared/logger.js';

const SERVER_NAME = 'flutter-intel';
const SERVER_VERSION = '0.1.0';

export function createServer(getIndex: () => Promise<ProjectIndex>): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerGetProjectMap(server, getIndex);
  registerFindSymbol(server, getIndex);
  registerGetSymbol(server, getIndex);
  registerGetWidgetTree(server, getIndex);
  registerGetRouteGraph(server, getIndex);
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

  const server = createServer(() => indexPromise);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server started', { name: SERVER_NAME, version: SERVER_VERSION, root });
}

main().catch((err: unknown) => {
  logger.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
