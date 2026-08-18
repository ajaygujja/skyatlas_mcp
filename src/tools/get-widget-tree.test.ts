import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const WIDGET_FIXTURES = fileURLToPath(new URL('../../fixtures/widget-tree', import.meta.url));

// In-process MCP test of the formatted get_widget_tree contract. The shell, its
// stateful body and that body's State live in one file but on separate classes,
// so follow crosses class boundaries the same way it would across files.
describe('get_widget_tree (formatted response)', () => {
  const client = new Client({ name: 'widget-test', version: '0.0.0' });
  let root: string;

  async function callTree(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'get_widget_tree', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-widget-'));
    await cp(WIDGET_FIXTURES, root, { recursive: true });
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('stops at the shell leaf by default (follow off)', async () => {
    const text = await callTree({ widget: 'ShellScreen' });
    expect(text).toContain('Scaffold');
    expect(text).toContain('body: BodyView');
    // The body's real tree is not crossed without follow.
    expect(text).not.toContain('Column');
    expect(text).not.toContain('[follows ');
  });

  it('expands a repeated followed widget once, keeping every call site', async () => {
    const text = await callTree({ widget: 'RepeatFollowScreen', follow: true });
    // Both constructor calls are real sites and both stay.
    expect(text).toContain('children: RepeatedCard — :13');
    expect(text).toContain('children: RepeatedCard — :14');
    // The class has one static tree, so it is inlined once and pointed at after.
    expect(text).toContain('[follows RepeatedCard — repeat_follow.dart:20]');
    expect(text).toContain('[RepeatedCard expanded above — repeat_follow.dart:20]');
    expect(text.match(/child: Text/g)).toHaveLength(1);
  });

  it('points a StatefulWidget at its State class by default', async () => {
    const text = await callTree({ widget: 'BodyView' });
    expect(text).toContain('StatefulWidget');
    expect(text).toContain('_BodyViewState');
    expect(text).not.toContain('Column');
  });

  it('inlines the shell → StatefulWidget → State tree in one call when follow=true', async () => {
    const text = await callTree({ widget: 'ShellScreen', follow: true });
    expect(text).toContain('Scaffold');
    // Crosses the body leaf into its State class, marked honestly.
    expect(text).toMatch(/BodyView .*\[follows _BodyViewState/);
    expect(text).toContain('Column');
    // Keeps following ordinary indexed leaves: HeaderCard expands to its own tree.
    expect(text).toMatch(/HeaderCard .*\[follows HeaderCard/);
    expect(text).toContain('Padding');
  });

  it('renders the State tree directly when follow=true on the StatefulWidget', async () => {
    const text = await callTree({ widget: 'BodyView', follow: true });
    expect(text).toContain('build() in State class _BodyViewState');
    expect(text).toContain('Column');
  });

  it('does not follow when the leaf is not an indexed widget', async () => {
    const text = await callTree({ widget: '_BodyViewState', follow: true });
    // Column/Text/HeaderCard are present; built-in Text never resolves to a class.
    expect(text).toContain('Column');
    expect(text).toMatch(/HeaderCard .*\[follows HeaderCard/);
  });

  // ISSUE-1 Layer B: the index-backed filter must drop only what it positively
  // knows is not a Widget, and keep everything it cannot verify.
  describe('non-widget filter (ISSUE-1 Layer B)', () => {
    it('drops an indexed non-widget constructor, with an honesty marker', async () => {
      const text = await callTree({ widget: 'NonWidgetHostScreen' });
      expect(text).toContain('children: (LoadDataEvent — non-widget, not expanded)');
      // No tags (line, builder, etc.) leak through from the dropped node.
      expect(text).not.toMatch(/LoadDataEvent — :\d+/);
    });

    it('keeps an unknown/SDK name (Placeholder is not indexed)', async () => {
      const text = await callTree({ widget: 'NonWidgetHostScreen' });
      expect(text).toMatch(/Placeholder — :\d+/);
    });

    it('keeps an indexed widget (HeaderCard)', async () => {
      const text = await callTree({ widget: 'NonWidgetHostScreen' });
      expect(text).toMatch(/HeaderCard — :\d+/);
    });

    it('keeps an ambiguous duplicate name rather than guessing', async () => {
      const text = await callTree({ widget: 'NonWidgetHostScreen' });
      // DuplicateNode is declared twice (nonwidget_slot.dart / _dup.dart) with
      // different, non-widget supertypes — resolution is ambiguous, so the
      // conservative filter must not drop it.
      expect(text).toMatch(/DuplicateNode — :\d+/);
      expect(text).not.toContain('DuplicateNode — non-widget');
    });

    // SpecialCard's supertype chain is StatelessWidget → BaseCard → FancyCard
    // → SpecialCard; only BaseCard is a direct Flutter-base subclass and thus
    // an index.widgets entry. The filter must walk the full chain to find
    // BaseCard rather than judging SpecialCard non-widget from its immediate
    // (unindexed) supertype FancyCard alone.
    it('keeps a leaf 3 levels below a known widget base (transitive supertype walk)', async () => {
      const text = await callTree({ widget: 'ChainHostScreen' });
      expect(text).toMatch(/SpecialCard — :\d+/);
      expect(text).not.toContain('SpecialCard — non-widget');
    });
  });
});
