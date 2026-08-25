import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const WIRING_FIXTURES = fileURLToPath(new URL('../../fixtures/wiring', import.meta.url));

/**
 * An empty-ish result carries one of three different facts, and they lead to
 * three different next actions (AI_EFFICIENCY_ROADMAP.md §7.2):
 *
 * 1. the subject is not in the index — fix the name;
 * 2. the subject is there and genuinely unconnected — trust it, it may be dead code;
 * 3. the subject is there and the analysis could not see all of it — do not trust
 *    the absence, read the source.
 *
 * The third must never read like the second. These tests pin that each of the
 * three renders distinguishably, through the real tool responses.
 */
describe('the three kinds of empty result', () => {
  const client = new Client({ name: 'absence-test', version: '0.0.0' });
  let root: string;

  async function call(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: tool, arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-absence-'));
    await cp(WIRING_FIXTURES, root, { recursive: true });
    // A screen in a file the grammar cannot fully parse: the class and its name
    // are recovered, the malformed member is not, so any wiring inside it is
    // missing from the index. Kind 3 exists only for files like this one.
    await writeFile(
      join(root, 'broken_screen.dart'),
      [
        "import 'package:flutter/material.dart';",
        '',
        'class BrokenScreen extends StatelessWidget {',
        '  void oops( {',
        '}',
        '',
      ].join('\n'),
    );
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('kind 1 — the subject is not in the index', () => {
    it('find_state_wiring names the closest screens to a misspelled one', async () => {
      const text = await call('find_state_wiring', { screen: 'CounterScren' });
      expect(text).toContain("No screen/widget named 'CounterScren'");
      expect(text).toContain('Did you mean: CounterScreen');
    });

    it('find_state_wiring suggests blocs for a bloc query, not screens', async () => {
      const text = await call('find_state_wiring', { bloc: 'CounterCubi' });
      expect(text).toContain('Did you mean: CounterCubit');
      expect(text).not.toContain('CounterScreen');
    });

    it('find_symbol names the closest declaration', async () => {
      const text = await call('find_symbol', { query: 'CounterCubti' });
      expect(text).toContain('Did you mean: CounterCubit');
    });

    it('get_symbol names the closest declaration', async () => {
      const text = await call('get_symbol', { name: 'CounterCubti' });
      expect(text).toContain('Did you mean: CounterCubit');
    });

    it('get_widget_tree names the closest widget class with its flavor', async () => {
      const text = await call('get_widget_tree', { widget: 'CounterScren' });
      expect(text).toContain('Did you mean: CounterScreen (stateless)');
    });

    it('find_symbol reports an excluding filter instead of suggesting names', async () => {
      // The name exists; the filter removed it. Suggestions would name symbols
      // the same filter excludes, so the filter is the fact worth reporting.
      const text = await call('find_symbol', { query: 'CounterCubit', kind: 'enum' });
      expect(text).toContain('match(es) exist without the kind=enum filter');
      expect(text).not.toContain('Did you mean');
    });
  });

  describe('kind 2 — the subject is there and genuinely unconnected', () => {
    it('find_state_wiring says what was searched for and found absent', async () => {
      const text = await call('find_state_wiring', { screen: 'OrphanScreen' });
      expect(text).toContain('# State wiring: screen');
      expect(text).toContain("No Bloc or provider found wiring to 'OrphanScreen'");
      expect(text).not.toContain('syntax error');
    });
  });

  describe('kind 3 — the subject is there and part of it could not be parsed', () => {
    it('find_state_wiring qualifies the absence with the file that failed to parse', async () => {
      const text = await call('find_state_wiring', { screen: 'BrokenScreen' });
      expect(text).toContain('broken_screen.dart has 1 syntax error(s)');
      expect(text).toContain('extraction continued past them');
    });

    it('get_widget_tree qualifies a missing build tree the same way', async () => {
      const text = await call('get_widget_tree', { widget: 'BrokenScreen' });
      expect(text).toContain('No build() tree extracted for BrokenScreen');
      expect(text).toContain('syntax error(s)');
    });
  });
});
