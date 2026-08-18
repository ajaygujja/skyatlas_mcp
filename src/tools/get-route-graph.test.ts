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
const SCOPE_FIXTURES = fileURLToPath(new URL('../../fixtures/route-scope', import.meta.url));

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

  // Whole-output guard. The assertions above pin individual lines; this pins the
  // rendering as a whole, so a change to path resolution, table splicing, or the
  // auto_route merge surfaces as a reviewable diff instead of passing silently.
  it('renders the complete graph', async () => {
    expect(await callRouteGraph()).toMatchSnapshot();
  });
});

// Scope filters against the layout they exist for (AI_EFFICIENCY_ROADMAP.md §4):
// one central table declares every route, and the screens live in the feature
// folders and packages a caller narrows by.
describe('get_route_graph (scope filters)', () => {
  const client = new Client({ name: 'route-scope-test', version: '0.0.0' });
  let root: string;

  async function callRouteGraph(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'get_route_graph', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-route-scope-'));
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

  it('scopes by the feature declaring the screen, not the file declaring the route', async () => {
    const text = await callRouteGraph({ feature: 'billing' });
    expect(text).toContain('# Route graph: 2 of 5 route(s) matching feature=billing');
    expect(text).toContain('- /invoices → InvoiceScreen');
    expect(text).toContain('  - /invoices/detail → InvoiceDetailScreen');
    expect(text).not.toContain('OrdersScreen');
    expect(text).not.toContain('SupportScreen');
  });

  it('keeps the shell above a match, and counts it as context rather than a match', async () => {
    const text = await callRouteGraph({ feature: 'orders' });
    expect(text).toContain('# Route graph: 1 of 5 route(s) matching feature=orders');
    // The shell carries the guard and the navigator the matched route renders in.
    expect(text).toContain('- (shell — no path) (shell: AppShell)');
    expect(text).toContain('  - /orders → OrdersScreen');
    expect(text).toContain('1 route(s) shown do not match the filter');
  });

  it('scopes by the package declaring the screen', async () => {
    const text = await callRouteGraph({ package: 'shared_ui' });
    expect(text).toContain('# Route graph: 1 of 5 route(s) matching package=shared_ui');
    expect(text).toContain('- /support → SupportScreen');
    expect(text).not.toContain('InvoiceScreen');
  });

  it('scopes by resolved path prefix, including nested children', async () => {
    const text = await callRouteGraph({ pathPrefix: '/invoices' });
    expect(text).toContain('# Route graph: 2 of 5 route(s) matching pathPrefix=/invoices');
    expect(text).toContain('- /invoices/detail → InvoiceDetailScreen');
  });

  it('combines filters', async () => {
    const text = await callRouteGraph({ feature: 'billing', pathPrefix: '/invoices/detail' });
    expect(text).toContain(
      '# Route graph: 1 of 5 route(s) matching feature=billing, pathPrefix=/invoices/detail',
    );
  });

  it('reports the filters in a summary', async () => {
    const text = await callRouteGraph({ feature: 'billing', verbosity: 'summary' });
    expect(text).toContain('# Route graph (summary): 2 route(s) matching feature=billing');
    expect(text).toContain('Declared in (1): lib/core/router/app_router.dart 2');
  });

  it('rejects an unknown feature by naming the ones the layout carries', async () => {
    const text = await callRouteGraph({ feature: 'shipping' });
    expect(text).toContain("Unknown feature 'shipping'");
    expect(text).toContain('Known features: billing, orders');
  });

  it('rejects an unknown package by naming the known ones', async () => {
    const text = await callRouteGraph({ package: 'nope' });
    expect(text).toContain("Unknown package 'nope'");
    expect(text).toContain('scope_app');
  });

  it('separates a filter that matched nothing from a repo with no routes', async () => {
    const text = await callRouteGraph({ pathPrefix: '/nowhere' });
    expect(text).toContain('No route matching pathPrefix=/nowhere');
    expect(text).toContain('The index holds 5 route(s)');
  });

  it('answers a filter that matched nothing rather than rendering router-level facts', async () => {
    const text = await callRouteGraph({ feature: 'billing', pathPrefix: '/orders' });
    expect(text).toContain('No route matching feature=billing, pathPrefix=/orders');
    expect(text).not.toContain('## go_router');
  });

  it('leaves the unfiltered graph unscoped', async () => {
    const text = await callRouteGraph();
    expect(text).toContain('# Route graph: 5 route(s)');
    expect(text).not.toContain('matching');
  });
});
