import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// End-to-end MCP test (TECHNICAL_DESIGN.md §9.3): spawn the built server as a
// subprocess against a disposable copy of the mini-app fixture, speak real
// JSON-RPC over stdio, assert the formatted responses. Requires `pnpm build`.
describe('flutter-intel MCP server (stdio E2E)', () => {
  const client = new Client({ name: 'e2e-test', version: '0.0.0' });
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'flutter-intel-e2e-'));
    await cp(path.resolve(import.meta.dirname, '../fixtures/mini-app'), root, {
      recursive: true,
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../dist/server.js'), root],
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists all six v1 tools (ping retired)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'find_state_wiring',
      'find_symbol',
      'get_project_map',
      'get_route_graph',
      'get_symbol',
      'get_widget_tree',
    ]);
  });

  it('get_project_map reports packages, stack, and health', async () => {
    const result = await client.callTool({ name: 'get_project_map', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('2 package(s)');
    expect(text).toContain('Bloc [state]');
    expect(text).toContain('## mini_app');
    expect(text).toContain('## shared_ui');
    expect(text).toContain('all files parsed clean');
  });

  it('find_symbol returns ranked matches with file:line', async () => {
    const result = await client.callTool({
      name: 'find_symbol',
      arguments: { query: 'UserBloc', kind: 'class' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('class UserBloc — lib/blocs/user_bloc.dart:7');
    expect(text).toContain('extends Bloc<UserEvent, int>');
  });

  it('get_symbol returns declaration detail with members', async () => {
    const result = await client.callTool({
      name: 'get_symbol',
      arguments: { name: 'UserBloc' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('# class UserBloc — lib/blocs/user_bloc.dart:7-15');
    expect(text).toContain('Members (2):');
    expect(text).toContain('constructor UserBloc()');
    expect(text).toContain('method Future<void> _onLoad');
  });

  it('get_widget_tree renders the static build tree with named slots', async () => {
    const result = await client.callTool({
      name: 'get_widget_tree',
      arguments: { widget: 'MiniApp' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('# Widget tree: MiniApp (stateless) — lib/main.dart:7');
    expect(text).toContain('MaterialApp — :11');
    expect(text).toContain('home: HomeScreen — :11');
    expect(text).toContain('Tree is syntactic');
  });

  it('get_route_graph explains absence when no router is present', async () => {
    const result = await client.callTool({ name: 'get_route_graph', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('No routes found');
    expect(text).toContain('get_project_map');
  });

  it('explains empty results instead of returning nothing', async () => {
    const result = await client.callTool({
      name: 'find_symbol',
      arguments: { query: 'DoesNotExistAnywhere' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain("No symbols matching 'DoesNotExistAnywhere'");
    expect(text).toContain('get_project_map');
  });
});
