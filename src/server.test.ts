import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

// End-to-end MCP test (TECHNICAL_DESIGN.md §9.3): spawn the built server as a
// subprocess, speak real JSON-RPC over stdio, assert the response. Requires
// `pnpm build` to have run — vitest config makes that explicit via globalSetup
// being unnecessary; the test fails loudly if dist/ is stale or missing.
describe('flutter-intel MCP server (stdio E2E)', () => {
  const client = new Client({ name: 'e2e-test', version: '0.0.0' });

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../dist/server.js')],
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists the ping tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');
  });

  it('ping returns pong', async () => {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
  });
});
