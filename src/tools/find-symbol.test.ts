import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

// In-process MCP test of the find_symbol paging contract (§9.3): generate more
// matches than one page holds, then walk the offset cursor across the result set.
describe('find_symbol (paging)', () => {
  const client = new Client({ name: 'find-symbol-test', version: '0.0.0' });
  let root: string;
  const TOTAL = 60; // > MAX_RESULTS (50): forces a second page

  async function callFindSymbol(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'find_symbol', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-find-'));
    await writeFile(join(root, 'pubspec.yaml'), 'name: paging_app\n');
    await mkdir(join(root, 'lib'), { recursive: true });
    // 60 classes sharing the substring "PagedItem" so a single query matches all.
    const classes = Array.from(
      { length: TOTAL },
      (_, i) => `class PagedItem${String(i).padStart(2, '0')} {}`,
    ).join('\n');
    await writeFile(join(root, 'lib', 'items.dart'), `${classes}\n`);

    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('caps the first page and advertises the next offset', async () => {
    const text = await callFindSymbol({ query: 'PagedItem' });
    expect(text).toContain(`${String(TOTAL)} match(es) for 'PagedItem' (showing 1-50)`);
    // First and last of page 1 present, page-2 head absent.
    expect(text).toContain('PagedItem00');
    expect(text).toContain('PagedItem49');
    expect(text).not.toContain('PagedItem50');
    expect(text).toContain('… 10 more — pass offset=50 for the next page');
  });

  it('returns the remaining matches at the advertised offset', async () => {
    const text = await callFindSymbol({ query: 'PagedItem', offset: 50 });
    expect(text).toContain(`${String(TOTAL)} match(es) for 'PagedItem' (showing 51-60)`);
    expect(text).toContain('PagedItem50');
    expect(text).toContain('PagedItem59');
    expect(text).not.toContain('PagedItem49');
    // Last page: no further cursor.
    expect(text).not.toContain('more — pass offset=');
  });

  it('explains an offset past the end instead of returning an empty page', async () => {
    const text = await callFindSymbol({ query: 'PagedItem', offset: 100 });
    expect(text).toContain('offset 100 is past the end');
    expect(text).toContain(`only ${String(TOTAL)} match(es)`);
  });

  it('omits the paging window when everything fits on one page', async () => {
    const text = await callFindSymbol({ query: 'PagedItem00' });
    expect(text).toContain("1 match(es) for 'PagedItem00':");
    expect(text).not.toContain('showing');
    expect(text).not.toContain('more — pass offset=');
  });
});

// match= lets a caller express anchored queries grep could but a fragment can't:
// "ends in Repository" must exclude the RepositoryImpl subtype.
describe('find_symbol (match modes)', () => {
  const client = new Client({ name: 'find-symbol-match-test', version: '0.0.0' });
  let root: string;

  async function callFindSymbol(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'find_symbol', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-find-match-'));
    await writeFile(join(root, 'pubspec.yaml'), 'name: match_app\n');
    await mkdir(join(root, 'lib'), { recursive: true });
    // Two interfaces + their Impl subtypes: a substring "Repository" hits all 4,
    // a suffix hits only the 2 interfaces.
    await writeFile(
      join(root, 'lib', 'repos.dart'),
      [
        'class UserRepository {}',
        'class UserRepositoryImpl {}',
        'class OrderRepository {}',
        'class OrderRepositoryImpl {}',
      ].join('\n') + '\n',
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

  it('substring (default) matches the superset including Impl subtypes', async () => {
    const text = await callFindSymbol({ query: 'Repository', kind: 'class' });
    expect(text).toContain("4 match(es) for 'Repository'");
    expect(text).toContain('UserRepositoryImpl');
  });

  it('suffix excludes the RepositoryImpl subtype', async () => {
    const text = await callFindSymbol({ query: 'Repository', kind: 'class', match: 'suffix' });
    expect(text).toContain("2 match(es) for 'Repository'");
    expect(text).toContain('UserRepository ');
    expect(text).not.toContain('RepositoryImpl');
  });

  it('exact matches a single name', async () => {
    const text = await callFindSymbol({ query: 'UserRepository', match: 'exact' });
    expect(text).toContain("1 match(es) for 'UserRepository'");
    expect(text).not.toContain('UserRepositoryImpl');
  });

  it('regex matches a custom pattern', async () => {
    const text = await callFindSymbol({ query: '^Order.*Impl$', match: 'regex' });
    expect(text).toContain("1 match(es) for '^Order.*Impl$'");
    expect(text).toContain('OrderRepositoryImpl');
  });

  it('rejects an invalid regex with a friendly hint', async () => {
    const text = await callFindSymbol({ query: '(', match: 'regex' });
    expect(text).toContain('is not a valid regex');
  });

  it('countOnly returns just the total', async () => {
    const text = await callFindSymbol({ query: 'Repository', kind: 'class', countOnly: true });
    expect(text).toBe("4 match(es) for 'Repository' kind=class.");
  });
});
