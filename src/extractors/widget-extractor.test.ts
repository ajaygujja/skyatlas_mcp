import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractWidgets } from './widget-extractor.js';
import type { WidgetInfo, WidgetNode } from '../model/flutter.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/widgets', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<WidgetInfo[]> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractWidgets(tree, `fixtures/widgets/${name}`);
}

/** Depth-first flatten of a build tree for assertions. */
function flattenTree(node: WidgetNode | undefined): WidgetNode[] {
  if (!node) return [];
  const kids = Object.values(node.namedSlots).flat();
  return [node, ...kids.flatMap(flattenTree)];
}

/** Flatten the first root of a multi-root buildTree. */
function flattenFirstRoot(nodes: WidgetNode[] | undefined): WidgetNode[] {
  return flattenTree(nodes?.[0]);
}

describe('extractWidgets', () => {
  // Snapshots are the extraction contract: a diff in review = behavior change (§9.3).
  it.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.dart')))(
    'matches snapshot: %s',
    async (file) => {
      expect(await extractFixture(file)).toMatchSnapshot();
    },
  );

  it('classifies widget flavor by superclass', async () => {
    const home = await extractFixture('home_screen.dart');
    expect(home.find((w) => w.name === 'HomeScreen')?.flavor).toBe('stateless');

    const profile = await extractFixture('profile_widgets.dart');
    expect(profile.find((w) => w.name === 'ProfileView')?.flavor).toBe('consumer');
    expect(profile.find((w) => w.name === 'CounterBadge')?.flavor).toBe('hook');
  });

  // Regression guard: expression-bodied build() has no return_statement, so the
  // returned widget must be read straight off the function_body (collectBuildRoots).
  it('extracts the build tree from an arrow-bodied build()', async () => {
    const arrow = await extractFixture('arrow_body.dart');
    const constArrow = arrow.find((w) => w.name === 'ConstArrowScreen')?.buildTree?.[0];
    expect(constArrow?.widget).toBe('MaterialApp');
    expect((constArrow?.namedSlots['home'] ?? []).map((c) => c.widget)).toEqual(['HomeBody']);

    const plainArrow = arrow.find((w) => w.name === 'PlainArrowScreen')?.buildTree?.[0];
    expect(plainArrow?.widget).toBe('Scaffold');
  });

  it('does not treat a plain non-widget class as a widget', async () => {
    const profile = await extractFixture('profile_widgets.dart');
    expect(profile.find((w) => w.name === 'ProfileRepository')).toBeUndefined();
  });

  it('parses a nested build tree with named slots and a children list', async () => {
    const profile = await extractFixture('profile_widgets.dart');
    const tree = profile.find((w) => w.name === 'ProfileView')?.buildTree?.[0];
    expect(tree?.widget).toBe('Column');
    const children = tree?.namedSlots['children'] ?? [];
    expect(children.map((c) => c.widget)).toEqual(['Text', 'Divider', 'ElevatedButton']);
  });

  it('recovers a mis-parsed generic constructor (BlocBuilder<A, B>) with type args and builder subtree', async () => {
    const home = await extractFixture('home_screen.dart');
    const tree = home.find((w) => w.name === 'HomeScreen')?.buildTree?.[0];
    const blocBuilder = tree?.namedSlots['body']?.[0];
    expect(blocBuilder?.widget).toBe('BlocBuilder');
    expect(blocBuilder?.typeArgs).toEqual(['HomeBloc', 'HomeState']);
    expect(blocBuilder?.recoveredFromMisparse).toBe(true);
    // The real builder subtree survives the mis-parse.
    const listView = blocBuilder?.namedSlots['builder']?.[0];
    expect(listView?.widget).toBe('ListView.builder');
    expect(listView?.isBuilderCallback).toBe(true);
    expect(listView?.namedSlots['itemBuilder']?.[0]?.widget).toBe('ListTile');
  });

  it('keeps clean type args on a single-type-arg generic constructor', async () => {
    // FutureBuilder<int>(...) parses cleanly — type_arguments inside argument_part.
    const home = await extractFixture('home_screen.dart');
    const ctors = flattenFirstRoot(home.find((w) => w.name === 'HomeScreen')?.buildTree);
    // ListView.builder appears via the recovered subtree; assert names are reachable.
    expect(ctors.map((c) => c.widget)).toContain('ListView.builder');
  });

  it('omits event-handler callbacks (onPressed/onTap) from the static layout tree', async () => {
    const home = await extractFixture('home_screen.dart');
    const fab = home.find((w) => w.name === 'HomeScreen')?.buildTree?.[0]?.namedSlots[
      'floatingActionButton'
    ]?.[0];
    expect(fab?.widget).toBe('FloatingActionButton');
    // onPressed constructs a Bloc event, not a widget — must not appear.
    expect(fab?.namedSlots['onPressed']).toBeUndefined();
    expect(fab?.namedSlots['child']?.[0]?.widget).toBe('Icon');
  });

  it('reports a StatefulWidget without inline build() and finds its State', async () => {
    const { tree } = await parseFile(resolve(FIXTURES, '../basic/settings_screen.dart'));
    const widgets = extractWidgets(tree, 'fixtures/basic/settings_screen.dart');
    const sw = widgets.find((w) => w.name === 'SettingsScreen');
    expect(sw?.flavor).toBe('stateful');
    expect(sw?.buildTree).toBeUndefined();
    const state = widgets.find((w) => w.name === '_SettingsScreenState');
    expect(state?.flavor).toBe('state');
    expect(state?.buildTree?.[0]?.widget).toBe('Scaffold');
  });

  it('labels a `.map` collection child dynamic (mapped), not a builder callback', async () => {
    const { tree } = await parseFile(resolve(FIXTURES, '../basic/widget_tree_repro.dart'));
    const widgets = extractWidgets(tree, 'fixtures/basic/widget_tree_repro.dart');
    const row = widgets.find((w) => w.name === 'MappedChildrenField')?.buildTree?.[0];
    expect(row?.widget).toBe('Row');
    const child = row?.namedSlots['children']?.[0];
    // items.map((i) => Expanded(...)).toList(): one representative element, marked
    // as a dynamic collection — never a static child, never a builder slot.
    expect(child?.widget).toBe('Expanded');
    expect(child?.dynamic).toBe('mapped');
    expect(child?.isBuilderCallback).toBeUndefined();
  });

  it('unrolls a spread-of-map child as dynamic (mapped), keeps the plain spread', async () => {
    const { tree } = await parseFile(resolve(FIXTURES, '../basic/widget_tree_repro.dart'));
    const widgets = extractWidgets(tree, 'fixtures/basic/widget_tree_repro.dart');
    const column = widgets.find((w) => w.name === 'SpreadMappedChildrenField')?.buildTree?.[0];
    const children = column?.namedSlots['children'] ?? [];
    // `...items.map((i) => Expanded(...))`: the closure surfaces one representative
    // element marked dynamic (mapped); the plain `...footerWidgets` stays a spread
    // marker. Neither is a builder slot.
    expect(children.map((c) => c.widget)).toEqual(['Header', 'Expanded', '...footerWidgets']);
    const mapped = children.find((c) => c.widget === 'Expanded');
    expect(mapped?.dynamic).toBe('mapped');
    expect(mapped?.isBuilderCallback).toBeUndefined();
    expect(children.find((c) => c.widget === '...footerWidgets')?.dynamic).toBe('spread');
  });

  it('marks a collection-`if` child conditional and a spread as dynamic', async () => {
    const { tree } = await parseFile(resolve(FIXTURES, '../stress/widgets_hard.dart'));
    const widgets = extractWidgets(tree, 'fixtures/stress/widgets_hard.dart');
    const column = widgets.find((w) => w.name === 'CollectionIfChildren')?.buildTree?.[0];
    const children = column?.namedSlots['children'] ?? [];
    expect(children.map((c) => c.widget)).toEqual([
      'Header',
      'Banner',
      '...footerWidgets',
      'Footer',
    ]);
    const banner = children.find((c) => c.widget === 'Banner');
    expect(banner?.conditional).toBe(true);
    // Plain siblings are not marked conditional.
    expect(children.find((c) => c.widget === 'Header')?.conditional).toBeUndefined();
    // The spread is surfaced as a dynamic marker, never silently dropped.
    expect(children.find((c) => c.widget === '...footerWidgets')?.dynamic).toBe('spread');
  });
});
