import { mkdtemp, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const REFERENCE_FIXTURES = fileURLToPath(new URL('../../fixtures/references', import.meta.url));

/**
 * find_references is the widest answer the server gives, so the contract has two
 * halves: the sites must be complete and correctly classified, and the response
 * must stay affordable as the site count grows. Both are asserted through the
 * real tool.
 *
 * Fixtures are copied under a feature directory so scoping and per-feature
 * aggregation are exercised — a flat fixture path has neither a feature nor a
 * package to filter on.
 */
describe('find_references', () => {
  const client = new Client({ name: 'find-references-test', version: '0.0.0' });
  let root: string;

  async function call(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'find_references', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-refs-'));
    await writeFile(join(root, 'pubspec.yaml'), 'name: refs_app\n');
    const feature = join(root, 'lib/features/forms');
    await mkdir(feature, { recursive: true });
    await cp(REFERENCE_FIXTURES, feature, { recursive: true });
    // A generated file referencing the same name: excluded by default, since a
    // codegen tree restates what the hand-written one already says (§7.4).
    await writeFile(
      join(feature, 'service.g.dart'),
      'import "contracts.dart";\n\nFormRepository? wired;\n',
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

  it('reports where a class is used, with the declaration it resolves to', async () => {
    const text = await call({ name: 'FormRepository' });
    expect(text).toContain("# References to 'FormRepository'");
    expect(text).toContain('Declared: class FormRepository');
    expect(text).toContain('service.dart');
    // The annotation binding target and the `Type` getter are mentions, the
    // `implements` clause is a type position: each site is classified by where it
    // was written, and rows of one file name the path once (ISSUE-3 compaction).
    expect(text).toMatch(/nameRef · \S+service\.dart:\d+,\d+ {2}\(2 sites\)/);
    expect(text).toMatch(/^typeRef · :\d+$/m);
  });

  it('names the declaration a site sits inside', async () => {
    const text = await call({ name: 'ApiClient' });
    expect(text).toContain('[in FormRepositoryImpl]');
  });

  it('filters by reference kind', async () => {
    const text = await call({ name: 'FormEntity', kind: ['constructs'] });
    expect(text).toContain('kind=constructs');
    expect(text).not.toContain('typeRef');
  });

  it('reports what a filter excluded rather than leaving it implicit', async () => {
    const text = await call({ name: 'FormEntity', kind: ['constructs'] });
    expect(text).toMatch(/Not shown: \d+ site\(s\) outside the filters/);
  });

  it('excludes generated files by default and says so', async () => {
    const byDefault = await call({ name: 'FormRepository' });
    expect(byDefault).not.toContain('service.g.dart');
    expect(byDefault).toContain('in generated files (includeGenerated=true to include)');

    const including = await call({ name: 'FormRepository', includeGenerated: true });
    expect(including).toContain('service.g.dart');
  });

  it('scopes to a feature, and rejects a feature the layout does not have', async () => {
    expect(await call({ name: 'FormRepository', feature: 'forms' })).toContain('feature=forms');
    expect(await call({ name: 'FormRepository', feature: 'safety' })).toContain(
      "Unknown feature 'safety'",
    );
  });

  it('reports shape only, on request', async () => {
    const text = await call({ name: 'FormRepository', verbosity: 'summary' });
    expect(text).toContain('Widest files:');
    expect(text).toMatch(/service\.dart \(\d+\)/);
    expect(text).toContain('Pass verbosity="normal"');
    // Shape only: no per-site rendering at this verbosity.
    expect(text).not.toMatch(/typeRef · /);
  });

  it('says a name is spread thin instead of listing files that hold one site each', async () => {
    // Every file annotates at most once, so there is no concentration to report.
    const text = await call({ name: 'LazySingleton', verbosity: 'summary' });
    expect(text).toMatch(/One site in each of \d+ file\(s\)/);
    expect(text).not.toContain('Widest files:');
  });

  it('answers a name the workspace uses but does not declare', async () => {
    const text = await call({ name: 'StringBuffer' });
    expect(text).toContain('Declared: not in this workspace');
    expect(text).toContain('still where this workspace uses it');
  });

  it('reports a declared-but-unreferenced name as possible dead code', async () => {
    const text = await call({ name: 'NeverReferenced' });
    expect(text).toContain('referenced nowhere in the index');
    expect(text).toContain('possibly dead code');
  });

  it('suggests the nearest name when nothing declares or uses the query', async () => {
    const text = await call({ name: 'FormRepositry' });
    expect(text).toContain("Nothing in the index declares or uses the name 'FormRepositry'");
    expect(text).toContain('Did you mean: FormRepository');
  });

  it('reports a name collision by count with examples, not by listing every declaration', async () => {
    // `send` is declared on ApiClient here; a real repo declares such a member
    // name hundreds of times, and listing them all costs more than the sites.
    const text = await call({ name: 'send' });
    expect(text).toContain('Declared: method ApiClient.send');
    expect(text.split('\n').every((line) => line.length < 400)).toBe(true);
  });

  it('states that sites are name matches, not resolved bindings', async () => {
    const text = await call({ name: 'FormRepository' });
    expect(text).toContain('syntactic name matches, not type-resolved');
  });
});
