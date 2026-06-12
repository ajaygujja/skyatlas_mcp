import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractSymbols, type ExtractionResult } from './symbol-extractor.js';
import type { Symbol } from '../model/symbol.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/basic', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<ExtractionResult> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractSymbols(tree, `fixtures/basic/${name}`);
}

function flatten(symbols: Symbol[]): Symbol[] {
  return symbols.flatMap((s) => [s, ...flatten(s.children)]);
}

describe('extractSymbols', () => {
  // Snapshots are the extraction contract: a diff in review = behavior change (§9.3).
  it.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.dart')))(
    'matches snapshot: %s',
    async (file) => {
      expect(await extractFixture(file)).toMatchSnapshot();
    },
  );

  it('nests methods and fields under their class with parentId', async () => {
    const { symbols } = await extractFixture('user_bloc.dart');
    const bloc = symbols.find((s) => s.name === 'UserBloc');
    expect(bloc).toBeDefined();
    expect(bloc?.kind).toBe('class');
    const memberNames = bloc?.children.map((c) => c.name);
    expect(memberNames).toEqual(['_repository', 'UserBloc', '_onLoad', '_onRefresh']);
    for (const child of bloc?.children ?? []) {
      expect(child.parentId).toBe(bloc?.id);
      expect(child.qualifiedName).toBe(`UserBloc.${child.name}`);
    }
  });

  it('spans a method range through its body, not just the signature', async () => {
    const { symbols } = await extractFixture('user_bloc.dart');
    const onLoad = flatten(symbols).find((s) => s.name === '_onLoad');
    // _onLoad signature on line 22, body closes line 26
    expect(onLoad?.range).toEqual({ startLine: 22, endLine: 26 });
  });

  it('distinguishes the call-vs-declaration case that breaks regex indexers', async () => {
    // `on<LoadUser>(_onLoad);` inside the constructor is a *call*, not a declaration.
    const { symbols } = await extractFixture('user_bloc.dart');
    const names = flatten(symbols).map((s) => s.name);
    expect(names).not.toContain('on');
  });

  it('keeps getter/setter ids distinct via the name= convention', async () => {
    const { symbols } = await extractFixture('user_model.dart');
    const all = flatten(symbols);
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts named and factory constructors', async () => {
    const { symbols } = await extractFixture('user_model.dart');
    const ctors = flatten(symbols).filter((s) => s.kind === 'constructor');
    expect(ctors.map((s) => s.qualifiedName).sort()).toEqual([
      'User.User',
      'User.fromJson',
      'User.guest',
    ]);
  });

  it('extracts top-level variables and functions', async () => {
    const { symbols } = await extractFixture('app_router.dart');
    const byName = new Map(symbols.map((s) => [s.name, s]));
    expect(byName.get('kHomePath')?.kind).toBe('field');
    expect(byName.get('navigationCount')?.kind).toBe('field');
    expect(byName.get('appRouter')?.kind).toBe('field');
    expect(byName.get('describeLocation')?.kind).toBe('function');
  });

  it('survives syntax errors and extracts what is valid (error recovery)', async () => {
    const { symbols, parseErrors } = await extractFixture('broken.dart');
    expect(parseErrors.length).toBeGreaterThan(0);
    const names = flatten(symbols).map((s) => s.name);
    expect(names).toContain('Working');
    expect(names).toContain('AfterError');
    expect(names).toContain('alive');
  });
});
