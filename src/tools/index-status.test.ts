import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { ProjectIndex } from '../index/project-index.js';
import { createServer } from '../server.js';
import { indexStatusLine } from './format.js';

const MINI_APP = fileURLToPath(new URL('../../fixtures/mini-app', import.meta.url));

/**
 * Index state is part of every answer (AI_EFFICIENCY_ROADMAP.md §7.3): without
 * it a caller cannot separate "not in this repo" from "not indexed yet", and the
 * two call for opposite next actions. Two properties are pinned here.
 *
 * 1. **Coverage.** Every tool, on both a hit and a miss, closes with the line.
 *    Nothing enforces that structurally — a new response path can omit it and
 *    still compile — so it is asserted through the real MCP surface.
 * 2. **Content.** The line reports what the index actually holds, and the two
 *    states that make results misleading (a re-scan in flight, a dead watcher)
 *    are stated rather than left to be inferred from the results.
 */
describe('index state line', () => {
  const client = new Client({ name: 'index-status-test', version: '0.0.0' });
  let root: string;

  async function call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: tool, arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-status-'));
    await cp(MINI_APP, root, { recursive: true });
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const hits: [string, Record<string, unknown>][] = [
    ['get_project_map', {}],
    ['find_symbol', { query: 'UserBloc' }],
    ['get_symbol', { name: 'UserBloc' }],
    ['get_widget_tree', { widget: 'MiniApp' }],
    ['get_route_graph', {}],
    ['find_state_wiring', { screen: 'HomeScreen' }],
  ];

  it.each(hits)('%s states the index it answered from', async (tool, args) => {
    const text = await call(tool, args);
    expect(text.split('\n').at(-1)).toMatch(/^index: \d+ files · \d+ parse errors · updated /);
  });

  const misses: [string, Record<string, unknown>][] = [
    ['find_symbol', { query: 'NoSuchSymbolAnywhere' }],
    ['get_symbol', { name: 'NoSuchSymbolAnywhere' }],
    ['get_widget_tree', { widget: 'NoSuchWidget' }],
    ['find_state_wiring', { screen: 'NoSuchScreen' }],
  ];

  it.each(misses)('%s states the index even when it found nothing', async (tool, args) => {
    const text = await call(tool, args);
    expect(text.split('\n').at(-1)).toMatch(/^index: \d+ files · \d+ parse errors/);
  });
});

describe('indexStatusLine', () => {
  /** An index holding one file, whose last mutation is `agoMs` in the past. */
  function indexUpdated(agoMs: number): { index: ProjectIndex; now: number } {
    const index = new ProjectIndex();
    index.setFile({
      path: 'lib/a.dart',
      contentHash: 'h',
      generated: false,
      symbols: [],
      imports: [],
      widgets: [],
      blocs: [],
      providers: [],
      routes: [],
      dynamicRoutes: [],
      routeTables: [],
      routerGuards: [],
      edges: [],
      stringConsts: {},
      references: {},
      parseErrors: [],
    });
    return { index, now: index.updatedAt + agoMs };
  }

  it('reports a recent update as current rather than as a duration', () => {
    const { index, now } = indexUpdated(5_000);
    expect(indexStatusLine(index, now)).toBe('index: 1 files · 0 parse errors · updated just now');
  });

  it('reports an older update in the largest whole unit that applies', () => {
    expect(indexStatusLine(...ageArgs(90_000))).toContain('updated 1m ago');
    expect(indexStatusLine(...ageArgs(7_200_000))).toContain('updated 2h ago');
    expect(indexStatusLine(...ageArgs(3 * 86_400_000))).toContain('updated 3d ago');
  });

  it('states a re-scan in flight, since the contents predate what triggered it', () => {
    const { index, now } = indexUpdated(0);
    index.rescanning = true;
    expect(indexStatusLine(index, now)).toContain('full re-scan in progress');
  });

  it('states a dead watcher, which a frozen index cannot otherwise reveal', () => {
    const { index, now } = indexUpdated(0);
    index.watch = 'failed';
    expect(indexStatusLine(index, now)).toContain(
      'file watch failed — edits since are not indexed',
    );
  });

  it('says nothing about watching when no watcher was attached', () => {
    const { index, now } = indexUpdated(0);
    expect(indexStatusLine(index, now)).not.toContain('watch');
  });

  function ageArgs(agoMs: number): [ProjectIndex, number] {
    const { index, now } = indexUpdated(agoMs);
    return [index, now];
  }
});
