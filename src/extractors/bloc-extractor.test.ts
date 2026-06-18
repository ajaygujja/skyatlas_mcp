import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractBlocs, type BlocExtraction } from './bloc-extractor.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/blocs', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<BlocExtraction> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractBlocs(tree, `fixtures/blocs/${name}`);
}

describe('extractBlocs', () => {
  // Snapshots are the extraction contract: a diff in review = behavior change (§9.3).
  it.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.dart')))(
    'matches snapshot: %s',
    async (file) => {
      expect(await extractFixture(file)).toMatchSnapshot();
    },
  );

  it('classifies a two-type-arg Bloc with event + state types', async () => {
    const { blocs } = await extractFixture('user_bloc.dart');
    const bloc = blocs.find((b) => b.name === 'UserBloc');
    expect(bloc?.flavor).toBe('bloc');
    expect(bloc?.eventType).toBe('UserEvent');
    expect(bloc?.stateType).toBe('UserState');
  });

  it('classifies a single-type-arg Cubit with state only, no event', async () => {
    const { blocs } = await extractFixture('counter_cubit.dart');
    const cubit = blocs.find((b) => b.name === 'CounterCubit');
    expect(cubit?.flavor).toBe('cubit');
    expect(cubit?.stateType).toBe('int');
    expect(cubit?.eventType).toBeUndefined();
  });

  it('classifies custom bases by suffix (HydratedBloc / HydratedCubit)', async () => {
    const { blocs } = await extractFixture('auth_bloc.dart');
    expect(blocs.find((b) => b.name === 'AuthBloc')?.flavor).toBe('bloc');

    const { blocs: cubits } = await extractFixture('counter_cubit.dart');
    expect(cubits.find((b) => b.name === 'SettingsCubit')?.flavor).toBe('cubit');
  });

  it('does not treat events/states/widgets as blocs', async () => {
    const { blocs } = await extractFixture('user_bloc.dart');
    const names = blocs.map((b) => b.name);
    expect(names).toEqual(['UserBloc']);
  });

  it('extracts on<Event>() handlers: method tear-off keeps its name, inline closure does not', async () => {
    const { blocs } = await extractFixture('user_bloc.dart');
    const handlers = blocs.find((b) => b.name === 'UserBloc')?.handlers ?? [];
    expect(handlers).toEqual([
      { eventType: 'LoadUser', methodName: '_onLoad', line: 31 },
      { eventType: 'RefreshUser', line: 32 },
    ]);
  });

  it('records emit() call sites by line', async () => {
    const { blocs } = await extractFixture('user_bloc.dart');
    expect(blocs.find((b) => b.name === 'UserBloc')?.emitSites).toEqual([34, 39, 41]);
  });

  it('emits createsBloc from BlocProvider(create:)', async () => {
    const { edges } = await extractFixture('home_screen.dart');
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/home_screen.dart#HomeScreen',
      to: 'UserBloc',
      kind: 'createsBloc',
      line: 13,
      confidence: 'syntactic',
    });
  });

  it('resolves a cubit created via a service locator (sl<X>() / getIt<X>())', async () => {
    const { edges } = await extractFixture('locator_provider.dart');
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/locator_provider.dart#WorkLogListScreen',
      to: 'WorkLogListCubit',
      kind: 'createsBloc',
      line: 12,
      confidence: 'syntactic',
    });
    // A typed closure param (`BuildContext context`) must not be mistaken for the
    // created bloc — the locator type arg is.
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/locator_provider.dart#SearchScreen',
      to: 'SearchCubit',
      kind: 'createsBloc',
      line: 24,
      confidence: 'syntactic',
    });
    expect(edges.some((e) => e.to === 'BuildContext')).toBe(false);
  });

  it('emits readsBloc from context.watch<X>() and the BlocBuilder<X, _> mis-parse', async () => {
    const { edges } = await extractFixture('home_screen.dart');
    const reads = edges.filter((e) => e.from === 'fixtures/blocs/home_screen.dart#_HomeView');
    expect(reads).toContainEqual({
      from: 'fixtures/blocs/home_screen.dart#_HomeView',
      to: 'ThemeCubit',
      kind: 'readsBloc',
      line: 25,
      confidence: 'syntactic',
    });
    expect(reads).toContainEqual({
      from: 'fixtures/blocs/home_screen.dart#_HomeView',
      to: 'UserBloc',
      kind: 'readsBloc',
      line: 27,
      confidence: 'syntactic',
    });
  });

  it('attributes edges to the enclosing class', async () => {
    const { edges } = await extractFixture('home_screen.dart');
    // context.read inside HomeScreen's create closure is attributed to HomeScreen.
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/home_screen.dart#HomeScreen',
      to: 'UserRepository',
      kind: 'readsBloc',
      line: 14,
      confidence: 'syntactic',
    });
  });

  it('recovers the bloc from a mis-parsed BlocBuilder<A, B> (relational_expression)', async () => {
    // Here BlocBuilder follows a sibling named arg, so it mis-parses (§2). The
    // readsBloc edge must still resolve the first type arg.
    const { edges } = await extractFixture('multi_bloc_view.dart');
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/multi_bloc_view.dart#MultiBlocView',
      to: 'UserBloc',
      kind: 'readsBloc',
      line: 17,
      confidence: 'syntactic',
    });
  });

  it('emits createsBloc from BlocProvider<T> in a list (collection-position mis-parse)', async () => {
    // BlocProvider<T> at value position in a list mis-parses as relational_expression.
    // Both arrow and block-body create forms must still resolve via the outer mis-parse.
    const { edges } = await extractFixture('multi_bloc_provider.dart');
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/multi_bloc_provider.dart#MultiTypedScreen',
      to: 'ArrowBloc',
      kind: 'createsBloc',
      line: 10,
      confidence: 'syntactic',
    });
    expect(edges).toContainEqual({
      from: 'fixtures/blocs/multi_bloc_provider.dart#MultiTypedScreen',
      to: 'BlockBodyBloc',
      kind: 'createsBloc',
      line: 13,
      confidence: 'syntactic',
    });
  });

  it('emits no edges and no blocs for a plain bloc declaration file', async () => {
    const { blocs, edges } = await extractFixture('auth_bloc.dart');
    expect(blocs).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});
