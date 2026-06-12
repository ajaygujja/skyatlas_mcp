#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPingTool } from './tools/ping.js';
import { logger } from './shared/logger.js';

const SERVER_NAME = 'flutter-intel';
const SERVER_VERSION = '0.0.1';

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerPingTool(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server started', { name: SERVER_NAME, version: SERVER_VERSION });
}

main().catch((err: unknown) => {
  logger.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
