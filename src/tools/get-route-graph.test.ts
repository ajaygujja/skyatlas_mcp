import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const ROUTES_FIXTURES = fileURLToPath(new URL('../../fixtures/routes', import.meta.url));

// In-process MCP test of the formatted route-graph contract (§9.3): index the
// route fixtures in a disposable copy, wire the real server over an in-memory
// transport, and assert the LLM-facing text.
describe('get_route_graph (formatted response)', () => {
  const client = new Client({ name: 'route-graph-test', version: '0.0.0' });
  let root: string;

  async function callRouteGraph(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'get_route_graph', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-routes-'));
    await cp(ROUTES_FIXTURES, root, { recursive: true });
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('renders go_router nesting with computed full paths and guards', async () => {
    const text = await callRouteGraph({ router: 'go_router' });
    expect(text).toContain('## go_router');
    // Router-level redirect surfaced once at the top, not attached to a route (R1).
    expect(text).toContain('- global redirect: rootRedirect');
    expect(text).toContain('- / → HomeScreen (home)');
    expect(text).toContain('  - /settings → SettingsScreen (settings)');
    expect(text).toContain('    - /settings/about → AboutScreen');
    // ShellRoute is path-less; its wrapper is labelled distinctly, not as a screen (R2).
    expect(text).toContain('- (shell — no path) (shell: ScaffoldShell)');
    expect(text).toContain('  - /profile → ProfilePage');
    expect(text).toContain('[guards: authGuard]');
    // A BlocProvider builder is unwrapped to the real screen, not the wrapper (B7).
    expect(text).toContain('- /feed → FeedScreen (feed)');
    // StatefulShellRoute branches flattened under the shell.
    expect(text).toContain('  - /feed → FeedScreen');
  });

  it('merges the auto_route table with the *.gr.dart fallback to resolve real screens', async () => {
    const text = await callRouteGraph({ router: 'auto_route' });
    expect(text).toContain('## auto_route');
    // page ref HomeRoute resolved to the real screen via PageInfo builder.
    expect(text).toContain('HomeRoute → HomeScreen');
    // DashboardRoute has no *.gr.dart entry, so it stays an unresolved page ref.
    expect(text).toContain('- /dashboard → DashboardRoute');
    expect(text).toContain('  - /dashboard/stats → StatsRoute');
    expect(text).toContain('[guards: AuthGuard]');
    // A RedirectRoute is extracted and shown forwarding to its target (AR1).
    expect(text).toContain('- * → /login (redirect)');
  });

  it('reports dynamic tables honestly', async () => {
    const text = await callRouteGraph();
    expect(text).toContain('Dynamic routes');
    expect(text).toContain('provided by reference');
    expect(text).toContain('collection-for/if');
  });

  it('splices `...Owner.routes()` static tables into the graph', async () => {
    const text = await callRouteGraph({ router: 'go_router' });
    expect(text).toContain('- /host → HostScreen');
    // Routes mounted via a spread are enumerated, not reported unknown.
    expect(text).toContain('- /module → ModuleScreen');
    expect(text).toContain('- /module/detail → ModuleDetailScreen');
    expect(text).toContain('- /extra → ExtraScreen');
  });

  it('keeps a mount whose table is not indexed honestly unknown', async () => {
    const text = await callRouteGraph({ router: 'go_router' });
    expect(text).toContain('...MissingNavigation.routes()');
    expect(text).toContain('no static table indexed');
  });

  it('terminates a self-referential table without duplicating its routes', async () => {
    const text = await callRouteGraph({ router: 'go_router' });
    const cyclic = text.split('\n').filter((l) => l.includes('/cyclic → CyclicScreen'));
    expect(cyclic).toHaveLength(1);
  });
});
