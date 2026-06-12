import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Phase 0 plumbing proof: one tool that returns "pong".
 * Exists only to validate the MCP stdio round-trip end to end
 * (TECHNICAL_DESIGN.md §8 Phase 0). Removed once real tools land in Phase 2.
 */
export function registerPingTool(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health check for the flutter-intel MCP server. Returns "pong".',
    },
    () => ({
      content: [{ type: 'text', text: 'pong' }],
    }),
  );
}
