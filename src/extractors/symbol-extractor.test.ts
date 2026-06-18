import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractSymbols, type ExtractionResult } from './symbol-extractor.js';
import { signatureText } from '../tools/format.js';
import type { Symbol } from '../model/symbol.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/basic', import.meta.url));
const STRESS = fileURLToPath(new URL('../../fixtures/stress', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<ExtractionResult> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractSymbols(tree, `fixtures/basic/${name}`);
}

async function extractStress(name: string): Promise<ExtractionResult> {
  const { tree } = await parseFile(resolve(STRESS, name));
  return extractSymbols(tree, `fixtures/stress/${name}`);
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

  describe('declaration detail (Phase 2)', () => {
    let symbols: Symbol[];
    let all: Symbol[];

    beforeAll(async () => {
      ({ symbols } = await extractFixture('declaration_detail.dart'));
      all = flatten(symbols);
    });

    it('extracts class annotations, modifiers, doc, type params, super types', () => {
      const bloc = symbols.find((s) => s.name === 'DetailBloc');
      expect(bloc?.annotations).toEqual([
        { name: 'immutable' },
        { name: 'RoutePage', args: "name: 'DetailRoute'" },
      ]);
      expect(bloc?.modifiers).toEqual(['abstract', 'base']);
      expect(bloc?.doc).toBe(
        'A bloc demonstrating every declaration-detail field Phase 2 extracts.',
      );
      expect(bloc?.typeParameters).toEqual(['E', 'S extends Object']);
      expect(bloc?.extendsType).toEqual({
        name: 'Bloc',
        typeArgs: ['DetailEvent', 'DetailState'],
      });
      expect(bloc?.mixesIn).toEqual([{ name: 'LoggerMixin', typeArgs: [] }]);
      expect(bloc?.implementsTypes).toEqual([
        { name: 'Disposable', typeArgs: [] },
        { name: 'Comparable', typeArgs: ['DetailBloc<E, S>'] },
      ]);
    });

    it('extracts field modifiers and verbatim type', () => {
      const maxRetries = all.find((s) => s.name === 'maxRetries');
      expect(maxRetries?.modifiers).toEqual(expect.arrayContaining(['static', 'const']));
      expect(maxRetries?.returnType).toBe('int');
      const label = all.find((s) => s.name === '_label');
      expect(label?.modifiers).toEqual(expect.arrayContaining(['late', 'final']));
      expect(label?.returnType).toBe('String?');
    });

    it('extracts constructor parameters incl. this. and required named', () => {
      const ctor = all.find((s) => s.qualifiedName === 'DetailBloc.DetailBloc');
      expect(ctor?.modifiers).toContain('const');
      expect(ctor?.doc).toBe('Creates the bloc.');
      expect(ctor?.parameters).toEqual([
        { name: '_label', named: false, required: true },
        { name: 'repo', type: 'Repo', named: true, required: true },
        { name: 'retries', type: 'int', named: true, required: false },
      ]);
      const factory = all.find((s) => s.qualifiedName === 'DetailBloc.standard');
      expect(factory?.kind).toBe('constructor');
      expect(factory?.modifiers).toContain('factory');
    });

    it('extracts method return type, params, async modifier, sibling annotations', () => {
      const load = all.find((s) => s.qualifiedName === 'DetailBloc.load');
      expect(load?.annotations).toEqual([{ name: 'override' }]);
      expect(load?.returnType).toBe('Future<void>');
      expect(load?.modifiers).toContain('async');
      expect(load?.parameters).toEqual([
        { name: 'id', type: 'String', named: false, required: true },
        { name: 'depth', type: 'int', named: false, required: false },
      ]);
      const format = all.find((s) => s.qualifiedName === 'DetailBloc.format');
      expect(format?.modifiers).toContain('static');
    });

    it('extracts sealed modifier and enum with/implements', () => {
      expect(symbols.find((s) => s.name === 'Shape')?.modifiers).toEqual(['sealed']);
      const status = symbols.find((s) => s.name === 'Status');
      expect(status?.mixesIn).toEqual([{ name: 'Describable', typeArgs: [] }]);
      expect(status?.implementsTypes).toEqual([{ name: 'Comparable', typeArgs: ['Status'] }]);
    });

    it('extracts top-level function detail and function-typed params', () => {
      const fetchAll = symbols.find((s) => s.name === 'fetchAll');
      expect(fetchAll?.doc).toBe('Fetches everything eagerly when [eager] is set.');
      expect(fetchAll?.annotations).toEqual([{ name: 'Deprecated', args: "'use fetchSome'" }]);
      expect(fetchAll?.returnType).toBe('Future<List<int>>');
      expect(fetchAll?.typeParameters).toEqual(['T']);
      const onEach = symbols.find((s) => s.name === 'onEach');
      expect(onEach?.parameters).toEqual([
        { name: 'callback', type: 'void Function(int)', named: false, required: true },
        { name: 'label', type: 'String?', named: false, required: false },
      ]);
    });
  });

  describe('tricky declarations (symbols_hard.dart)', () => {
    let all: Symbol[];

    beforeAll(async () => {
      const { symbols } = await extractStress('symbols_hard.dart');
      all = flatten(symbols);
    });

    // S1 — operator overloads were previously dropped entirely.
    it('extracts operator overloads as method symbols', () => {
      const lt = all.find((s) => s.qualifiedName === 'Box.operator <');
      expect(lt?.kind).toBe('method');
      expect(lt?.returnType).toBe('bool');
      expect(lt?.parameters).toEqual([
        { name: 'other', type: 'Box<T>', named: false, required: true },
      ]);

      const index = all.find((s) => s.qualifiedName === 'Box.operator []');
      expect(index?.kind).toBe('method');
      expect(index?.returnType).toBe('T');
      expect(index?.parameters).toEqual([{ name: 'i', type: 'int', named: false, required: true }]);
    });

    // S2 — `mixin class` was mis-kinded as `class`.
    it('reports `mixin class` as kind mixin', () => {
      const loggable = all.find((s) => s.name === 'Loggable');
      expect(loggable?.kind).toBe('mixin');
    });
  });

  describe('signature rendering', () => {
    it('prepends the class name to named/factory constructors', async () => {
      const { symbols } = await extractFixture('user_model.dart');
      const all = flatten(symbols);
      const fromJson = all.find((s) => s.qualifiedName === 'User.fromJson');
      expect(fromJson && signatureText(fromJson)).toMatch(/^factory User\.fromJson\(/);
      // The default constructor keeps the bare class name (no `User.User`).
      const ctor = all.find((s) => s.qualifiedName === 'User.User');
      const rendered = ctor && signatureText(ctor);
      expect(rendered).toContain('User(');
      expect(rendered).not.toContain('User.User');
    });
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
