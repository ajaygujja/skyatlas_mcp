import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const MINI_APP = fileURLToPath(new URL('../../fixtures/mini-app', import.meta.url));

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
