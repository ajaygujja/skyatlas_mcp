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
