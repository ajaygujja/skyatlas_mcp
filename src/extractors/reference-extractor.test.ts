import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseText } from '../parser/parser.js';
import type { FileReferences, ReferenceKind } from '../model/reference.js';
import { extractReferences } from './reference-extractor.js';
import { extractSymbols } from './symbol-extractor.js';

beforeAll(async () => {
  await initParser();
});

/** Kinds recorded for `name`, in source order, as `kind:line` pairs. */
function sitesFor(refs: FileReferences, name: string): string[] {
  return (refs[name] ?? []).map((site) => `${site.kind}:${String(site.line)}`);
}

function kindsFor(refs: FileReferences, name: string): ReferenceKind[] {
  return (refs[name] ?? []).map((site) => site.kind);
}

describe('extractReferences', () => {
  it('records a type position wherever a type may be written', () => {
    const refs = extractReferences(
      parseText(`class Impl extends Base with Helper implements Contract {
        final Client client;
        Future<Result> run(Input input) async => Result();
        bool check(Object o) => o is Marker;
      }`),
    );
    expect(kindsFor(refs, 'Base')).toEqual(['typeRef']);
    expect(kindsFor(refs, 'Contract')).toEqual(['typeRef']);
    expect(kindsFor(refs, 'Helper')).toEqual(['typeRef']);
    expect(kindsFor(refs, 'Client')).toEqual(['typeRef']);
    expect(kindsFor(refs, 'Input')).toEqual(['typeRef']);
    expect(kindsFor(refs, 'Marker')).toEqual(['typeRef']);
    // The return type is a type position; the `Result()` in the body is a call.
    expect(kindsFor(refs, 'Result')).toEqual(['typeRef', 'constructs']);
  });

  it('separates a construction from a static access and a bare mention', () => {
    const refs = extractReferences(
      parseText(`void run() {
        final a = Widget();
        final b = Widget.of(context);
        final c = Widget.new;
        register(Widget);
      }`),
    );
    expect(sitesFor(refs, 'Widget')).toEqual([
      'constructs:2',
      'staticAccess:3',
      'staticAccess:4',
      'nameRef:5',
    ]);
  });

  it('records an annotation as its own kind, including a bare one', () => {
    const refs = extractReferences(
      parseText(`@LazySingleton(as: Contract)
        @injectable
        class Impl {}`),
    );
    expect(kindsFor(refs, 'LazySingleton')).toEqual(['annotation']);
    // The binding target is an argument, not a construction — a plain mention.
    expect(kindsFor(refs, 'Contract')).toEqual(['nameRef']);
    // A lowercase annotation is still an annotation; case only classifies
    // identifiers that could be a type.
    expect(kindsFor(refs, 'injectable')).toEqual([]);
  });

  it('records calls in all three shapes, keeping the receiver as written', () => {
    const refs = extractReferences(
      parseText(`void run() {
        load('a');
        repo.fetch('b');
        Endpoints.build('c');
        StringBuffer()..write('d');
      }`),
    );
    // A bare call has no receiver at the site.
    expect(refs['load']).toEqual([{ kind: 'calls', line: 2 }]);
    expect(refs['fetch']).toEqual([{ kind: 'calls', line: 3, receiver: 'repo' }]);
    // A static call keeps the type as its receiver, and the type is recorded too.
    expect(refs['build']).toEqual([{ kind: 'calls', line: 4, receiver: 'Endpoints' }]);
    expect(kindsFor(refs, 'Endpoints')).toEqual(['staticAccess']);
    // A cascade's target sits earlier in the chain, so the site carries no receiver.
    expect(refs['write']).toEqual([{ kind: 'calls', line: 5 }]);
  });

  it('attributes a site to the declaration enclosing it', () => {
    const refs = extractReferences(
      parseText(`class Screen {
        Widget build() => Card();
      }
      Widget top() => Card();`),
    );
    expect(refs['Card']?.map((site) => site.owner)).toEqual(['Screen', undefined]);
  });

  it('never records a declaration as a reference to itself', async () => {
    const path = fileURLToPath(
      new URL('../../fixtures/references/contracts.dart', import.meta.url),
    );
    const text = await readFile(path, 'utf8');
    const tree = parseText(text);
    const refs = extractReferences(tree);
    const declared = new Set<string>();
    const collect = (symbols: ReturnType<typeof extractSymbols>['symbols']): void => {
      for (const sym of symbols) {
        declared.add(`${sym.name}:${String(sym.nameRange.line)}`);
        collect(sym.children);
      }
    };
    collect(extractSymbols(tree, 'contracts.dart').symbols);

    // A declaration's own name token is not a use of it. `typedef FormLoader` is
    // the trap: it is the one declaration whose name sits in a type position.
    for (const [name, sites] of Object.entries(refs)) {
      for (const site of sites) {
        expect(declared.has(`${name}:${String(site.line)}`)).toBe(false);
      }
    }
    expect(refs['FormLoader']).toBeUndefined();
  });

  it('keeps names that could collide with Object.prototype members', () => {
    const refs = extractReferences(
      parseText(`void run() {
        thing.constructor();
        thing.toString();
      }`),
    );
    expect(kindsFor(refs, 'constructor')).toEqual(['calls']);
    expect(kindsFor(refs, 'toString')).toEqual(['calls']);
  });

  it('does not claim a construction the grammar parsed as a comparison', () => {
    // `BlocProvider<A, B>(…)` mis-parses as a relational expression (§2); the
    // name is still recorded, as a mention rather than an invented call.
    const refs = extractReferences(
      parseText(`void run() {
        final w = [BlocProvider<FormBloc>(create: (_) => FormBloc())];
      }`),
    );
    expect(kindsFor(refs, 'BlocProvider')).toEqual(['nameRef']);
    expect(kindsFor(refs, 'FormBloc')).toEqual(['nameRef', 'constructs']);
  });

  it('ignores a lowercase name that is read rather than called', () => {
    const refs = extractReferences(
      parseText(`void run() {
        final value = counter;
        final other = holder.field;
      }`),
    );
    expect(refs['counter']).toBeUndefined();
    expect(refs['field']).toBeUndefined();
  });
});
