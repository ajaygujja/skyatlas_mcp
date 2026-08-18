import { mkdtemp, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const MINI_APP = fileURLToPath(new URL('../../fixtures/mini-app', import.meta.url));
const SCOPE_FIXTURES = fileURLToPath(new URL('../../fixtures/route-scope', import.meta.url));

// In-process MCP test of get_project_map's index-health line (§9.4 graceful
// degradation): a file with a syntax error must be surfaced, by name, and the
// index must keep working past it — never die. Asserted through the real tool.
describe('get_project_map (index health)', () => {
  const client = new Client({ name: 'project-map-test', version: '0.0.0' });
  let root: string;

  async function callProjectMap(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'get_project_map', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-projmap-'));
    await cp(MINI_APP, root, { recursive: true });
    // A deliberately broken Dart file: tree-sitter localizes the ERROR node and
    // the rest of the repo still indexes. The health line must name this file.
    await writeFile(
      join(root, 'lib/broken.dart'),
      'class Broken {\n  void oops( {\n}\n', // unbalanced parens/braces
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

  it('surfaces a parse-error health line that names the broken file', async () => {
    const text = await callProjectMap();
    expect(text).toContain('Index health:');
    expect(text).toContain('file(s) with syntax errors');
    expect(text).toContain('lib/broken.dart');
  });

  it('still indexes the rest of the repo past the broken file', async () => {
    // The index did not die: clean symbols from sibling files are present.
    const text = await callProjectMap();
    expect(text).toMatch(/Dart files/);
    expect(text).toContain('Symbols by kind');
  });
});

// Folder listing depth (AI_FIX_SPEC.md §5): the first call has to describe a
// layout to a caller who does not know it yet, which a row covering most of the
// package cannot do.
describe('get_project_map (folder depth)', () => {
  const client = new Client({ name: 'project-map-depth-test', version: '0.0.0' });
  let root: string;

  async function callProjectMap(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'get_project_map', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-projmap-depth-'));
    await cp(SCOPE_FIXTURES, root, { recursive: true });
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('deepens a package whose files sit under one folder, and names that depth', async () => {
    const text = await callProjectMap();
    expect(text).toContain('## scope_app — (workspace root) (folders at depth 3)');
    expect(text).toContain('- lib/features/billing: 1 file(s)');
    expect(text).toContain('- lib/features/orders: 1 file(s)');
  });

  it('leaves a package whose shallow listing already splits it alone', async () => {
    const text = await callProjectMap();
    expect(text).toContain('## shared_ui — packages/shared_ui (folders at depth 2)');
  });

  it('renders the requested depth when one is given', async () => {
    const text = await callProjectMap({ depth: 2 });
    expect(text).toContain('## scope_app — (workspace root) (folders at depth 2)');
    expect(text).toContain('- lib/features: 2 file(s)');
    expect(text).not.toContain('- lib/features/billing');
  });

  it('rejects a depth outside the rendered range', async () => {
    const result = await client.callTool({ name: 'get_project_map', arguments: { depth: 9 } });
    expect(result.isError).toBe(true);
  });
});

// Two facts a folder listing must state rather than imply (§7.2, §7.4): where a
// package's generated code went, and that a package holds no Dart code at all.
describe('get_project_map (generated code and empty packages)', () => {
  const client = new Client({ name: 'project-map-groups-test', version: '0.0.0' });
  let root: string;

  async function callProjectMap(): Promise<string> {
    const result = await client.callTool({ name: 'get_project_map', arguments: {} });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-projmap-groups-'));
    await cp(MINI_APP, root, { recursive: true });
    await mkdir(join(root, 'packages/empty_pkg'), { recursive: true });
    await writeFile(join(root, 'packages/empty_pkg/pubspec.yaml'), 'name: empty_pkg\n');
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('groups generated files into one row instead of listing their mirrored tree', async () => {
    const text = await callProjectMap();
    expect(text).toMatch(/- \(generated\): \d+ file\(s\) — \*\.g\.dart/);
    expect(text).not.toContain('user_model.g.dart');
  });

  it('says a package holds no Dart files rather than rendering an empty section', async () => {
    const text = await callProjectMap();
    expect(text).toContain('## empty_pkg — packages/empty_pkg');
    expect(text).toContain('- (no Dart files)');
  });
});
