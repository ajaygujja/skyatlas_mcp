import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from './indexer.js';
import { startWatcher, type BatchSummary, type WatcherHandle } from './watcher.js';
import type { ProjectIndex } from './project-index.js';
import { createServer } from '../server.js';

const MINI_APP = fileURLToPath(new URL('../../fixtures/mini-app', import.meta.url));

/**
 * A per-test batch sink: buffers processed batches so awaiting one is immune to
 * whether the fs event lands before or after we start waiting. Fresh per test, so
 * a late batch from a prior test's watcher can never resolve this test's await.
 */
class BatchWaiter {
  private readonly queue: BatchSummary[] = [];
  private resolveNext: ((s: BatchSummary) => void) | undefined = undefined;
  readonly onBatch = (s: BatchSummary): void => {
    const resolve = this.resolveNext;
    if (resolve) {
      this.resolveNext = undefined;
      resolve(s);
    } else {
      this.queue.push(s);
    }
  };
  next(): Promise<BatchSummary> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<BatchSummary>((r) => (this.resolveNext = r));
  }
}

// Index-integration, not pure extraction: copy the fixture to a temp root, build
// the index, arm the real watcher, then mutate files on disk and assert the index
// reflects each change. Never sleeps — `waiter.next()` resolves on the watcher's
// per-batch callback, so timing rides the debounce instead of guessing it (§8).
describe('startWatcher', () => {
  let root: string;
  let index: ProjectIndex;
  let handle: WatcherHandle | undefined;
  let waiter: BatchWaiter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flutter-intel-watch-'));
    await cp(MINI_APP, root, { recursive: true });
    index = (await buildIndex(root)).index;
    waiter = new BatchWaiter();
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function start(opts = {}): Promise<void> {
    handle = await startWatcher(root, index, {
      debounceMs: 20,
      cacheSaveDebounceMs: 30,
      onBatch: waiter.onBatch,
      usePolling: true,
      pollInterval: 10,
      ...opts,
    });
  }

  it('re-indexes a changed file (new symbol appears)', async () => {
    await start();
    expect(index.findByName('WatchAdded')).toHaveLength(0);

    const mainPath = join(root, 'lib/main.dart');
    await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\nclass WatchAdded {}\n');
    const summary = await waiter.next();

    expect(summary.fullRescan).toBe(false);
    expect(summary.upserted).toContain('lib/main.dart');
    expect(index.findByName('WatchAdded')).toHaveLength(1);
  });

  it('indexes a newly added file', async () => {
    await start();
    await writeFile(join(root, 'lib/extra.dart'), 'class ExtraThing {}\n');
    const summary = await waiter.next();

    expect(summary.upserted).toContain('lib/extra.dart');
    expect(index.findByName('ExtraThing')).toHaveLength(1);
    expect(index.files.has('lib/extra.dart')).toBe(true);
  });

  it('removes a deleted file’s symbols', async () => {
    await start();
    expect(index.findByName('UserBloc').length).toBeGreaterThan(0);

    await rm(join(root, 'lib/blocs/user_bloc.dart'));
    const summary = await waiter.next();

    expect(summary.removed).toContain('lib/blocs/user_bloc.dart');
    expect(index.files.has('lib/blocs/user_bloc.dart')).toBe(false);
    expect(index.findByName('UserBloc')).toHaveLength(0);
  });

  it('a single-file update is well under the 50ms budget (§9.5)', async () => {
    await start();
    const mainPath = join(root, 'lib/main.dart');
    const before = performance.now();
    await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\nclass Timed {}\n');
    await waiter.next();
    const elapsed = performance.now() - before;
    // Generous ceiling: this spans fs-event latency + debounce, not just the parse.
    // The parse/extract itself is the <50ms budget (asserted in the indexer bench);
    // this only guards against a gross regression in the update path.
    expect(elapsed).toBeLessThan(1000);
    expect(index.findByName('Timed')).toHaveLength(1);
  });

  it('falls back to a full re-scan when a burst exceeds the threshold', async () => {
    await start({ massChangeThreshold: 3, debounceMs: 120 });
    // Four new files in one burst → one debounced batch of 4 > 3 → full re-scan.
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        writeFile(join(root, `lib/burst_${String(n)}.dart`), `class Burst${String(n)} {}\n`),
      ),
    );
    const summary = await waiter.next();

    expect(summary.fullRescan).toBe(true);
    for (const n of [1, 2, 3, 4]) {
      expect(index.findByName(`Burst${String(n)}`)).toHaveLength(1);
    }
  });

  it('treats a pubspec.yaml change as a full re-scan trigger', async () => {
    await start();
    const pubspec = join(root, 'pubspec.yaml');
    await writeFile(pubspec, (await readFile(pubspec, 'utf8')) + '\n# touched\n');
    const summary = await waiter.next();
    expect(summary.fullRescan).toBe(true);
  });

  it('keeps the disk cache fresh after an update (warm restart sees it)', async () => {
    await start();
    await writeFile(join(root, 'lib/cached_new.dart'), 'class CachedNew {}\n');
    await waiter.next();

    // close() flushes any pending debounced save, so the cache is current on disk.
    await handle?.close();
    handle = undefined;

    const raw = await readFile(join(root, '.flutter-intel', 'cache.json'), 'utf8');
    const parsed = JSON.parse(raw) as { files: Record<string, unknown> };
    expect(parsed.files['lib/cached_new.dart']).toBeDefined();
  });
});

// The §8 exit criterion, asserted through the actual tool: edit a route file,
// ask get_route_graph, see the change — without restarting the server. Uses a
// bounded poll-until on the tool output (the brief's sanctioned alternative to a
// batch callback): robust against an editor emitting more than one fs event.
describe('watcher freshness through get_route_graph', () => {
  let root: string;
  let handle: WatcherHandle | undefined;
  const client = new Client({ name: 'watcher-route-test', version: '0.0.0' });

  async function routeGraph(): Promise<string> {
    const result = await client.callTool({ name: 'get_route_graph', arguments: {} });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  async function waitForRoute(expected: string, gone?: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const text = await routeGraph();
      if (text.includes(expected) && (gone === undefined || !text.includes(gone))) return text;
      await new Promise((r) => setTimeout(r, 30));
    }
    return routeGraph();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flutter-intel-watch-route-'));
    await cp(MINI_APP, root, { recursive: true });
    const index = (await buildIndex(root)).index;
    const server = createServer(() => Promise.resolve(index));
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    handle = await startWatcher(root, index, {
      debounceMs: 20,
      cacheSaveDebounceMs: 30,
      usePolling: true,
      pollInterval: 10,
    });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const routerFile = (path: string, screen: string): string =>
    `import 'package:go_router/go_router.dart';\n` +
    `final router = GoRouter(routes: [\n` +
    `  GoRoute(path: '${path}', builder: (c, s) => const ${screen}()),\n` +
    `]);\n`;

  it('reflects an added route, then an edit to it, with no restart', async () => {
    // mini-app has no routes to begin with.
    expect(await routeGraph()).not.toContain('/dashboard');

    await writeFile(join(root, 'lib/router.dart'), routerFile('/dashboard', 'DashboardScreen'));
    const afterAdd = await waitForRoute('/dashboard');
    expect(afterAdd).toContain('/dashboard');
    expect(afterAdd).toContain('DashboardScreen');

    // Edit the same file: the route graph must track the change live.
    await writeFile(join(root, 'lib/router.dart'), routerFile('/reports', 'ReportsScreen'));
    const afterEdit = await waitForRoute('/reports', '/dashboard');
    expect(afterEdit).toContain('/reports');
    expect(afterEdit).toContain('ReportsScreen');
    expect(afterEdit).not.toContain('/dashboard');
  });
});
