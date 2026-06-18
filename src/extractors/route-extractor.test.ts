import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractRoutes, type RouteExtraction } from './route-extractor.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/routes', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<RouteExtraction> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractRoutes(tree, `fixtures/routes/${name}`);
}

describe('extractRoutes', () => {
  // Snapshots are the extraction contract: a diff in review = behavior change (§9.3).
  it.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.dart')))(
    'matches snapshot: %s',
    async (file) => {
      expect(await extractFixture(file)).toMatchSnapshot();
    },
  );

  it('computes go_router fullPaths by walking nesting (no paren counting)', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const home = routes.find((r) => r.name === 'home');
    expect(home?.fullPath).toBe('/');
    const settings = home?.children.find((r) => r.path === 'settings');
    expect(settings?.fullPath).toBe('/settings');
    expect(settings?.children[0]?.fullPath).toBe('/settings/about');
  });

  it('treats ShellRoute as path-less and labels its wrapper, not a screen', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const shell = routes.find((r) => r.shellWidget === 'ScaffoldShell');
    expect(shell?.path).toBeUndefined();
    expect(shell?.fullPath).toBeUndefined();
    expect(shell?.isShell).toBe(true);
    // The wrapper is a shellWidget, never a navigable screen.
    expect(shell?.screenWidget).toBeUndefined();
    // Absolute child paths survive the shell unchanged.
    expect(shell?.children.map((c) => c.fullPath)).toEqual(['/profile', '/profile/edit']);
  });

  it('captures the router-level redirect as a router guard (R1)', async () => {
    const { routerGuards } = await extractFixture('go_router_app.dart');
    expect(routerGuards).toEqual([
      expect.objectContaining({ router: 'go_router', redirect: 'rootRedirect' }),
    ]);
  });

  it('unwraps a BlocProvider builder to its child screen (B7)', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const feed = routes.find((r) => r.path === '/feed');
    expect(feed?.screenWidget).toBe('FeedScreen');
  });

  it('unwraps a pageBuilder MaterialPage to its child screen, and reads the redirect guard', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const profile = routes.flatMap((r) => r.children).find((r) => r.path === '/profile');
    expect(profile?.screenWidget).toBe('ProfilePage');
    expect(profile?.guards).toEqual(['authGuard']);
  });

  it('resolves a guarded pageBuilder to the real screen, not the early-return guard', async () => {
    const { routes } = await extractFixture('const_paths_guarded.dart');
    const detail = routes.find((r) => r.pathExpr === 'RoutePaths.detail');
    // The null-guard `return ErrorPage()` precedes the real return — the last
    // top-level return wins, so the screen is the detail screen, not ErrorPage.
    expect(detail?.screenWidget).toBe('WorkLogDetailScreen');
    expect(detail?.children[0]?.screenWidget).toBe('WorkLogEditScreen');
  });

  it('captures a const path reference verbatim as pathExpr (literal path left untouched)', async () => {
    const { routes } = await extractFixture('const_paths_guarded.dart');
    const home = routes.find((r) => r.screenWidget === 'HomeScreen');
    expect(home?.pathExpr).toBe('RoutePaths.home');
    expect(home?.path).toBeUndefined();
    // A real string-literal path still lands in `path`, never `pathExpr`.
    const { routes: go } = await extractFixture('go_router_app.dart');
    const settings = go[0]?.children.find((r) => r.path === 'settings');
    expect(settings?.pathExpr).toBeUndefined();
  });

  it('flattens StatefulShellRoute branches into children', async () => {
    const { routes } = await extractFixture('stateful_shell.dart');
    const shell = routes[0];
    expect(shell?.shellWidget).toBe('HomeShell');
    expect(shell?.children.map((c) => c.fullPath)).toEqual(['/feed', '/alerts']);
  });

  it('reads the auto_route table: page refs, paths, guards, nested children', async () => {
    const { routes } = await extractFixture('auto_route_config.dart');
    const dashboard = routes.find((r) => r.name === 'DashboardRoute');
    expect(dashboard?.fullPath).toBe('/dashboard');
    expect(dashboard?.children[0]).toMatchObject({
      name: 'StatsRoute',
      fullPath: '/dashboard/stats',
    });
    const profile = routes.find((r) => r.name === 'ProfileRoute');
    expect(profile?.guards).toEqual(['AuthGuard']);
  });

  it('extracts a RedirectRoute alias with its redirect target (AR1)', async () => {
    const { routes } = await extractFixture('auto_route_config.dart');
    const redirect = routes.find((r) => r.redirectTo !== undefined);
    expect(redirect).toMatchObject({ path: '*', redirectTo: '/login' });
    expect(redirect?.screenWidget).toBeUndefined();
  });

  it('resolves the real screen from the *.gr.dart PageInfo builder (§7.4 fallback)', async () => {
    const { routes } = await extractFixture('auto_route_app.gr.dart');
    expect(routes).toContainEqual(
      expect.objectContaining({ name: 'HomeRoute', screenWidget: 'HomeScreen' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ name: 'ProfileRoute', screenWidget: 'ProfileScreen' }),
    );
  });

  it('reports dynamic tables honestly and still extracts the static sibling route', async () => {
    const { routes, dynamic } = await extractFixture('dynamic_routes.dart');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.fullPath).toBe('/static');
    const reasons = dynamic.map((d) => d.reason);
    expect(reasons).toEqual([
      expect.stringContaining('provided by reference'),
      expect.stringContaining('collection-for/if'),
      expect.stringContaining('spread'),
    ]);
  });

  it('extracts static route-table methods (arrow and block bodies)', async () => {
    const { routeTables } = await extractFixture('route_tables.dart');
    const module = routeTables.find((t) => t.owner === 'ModuleNavigation');
    expect(module?.method).toBe('routes');
    expect(module?.routes.map((r) => r.path)).toEqual(['/module', '/module/detail']);
    const extra = routeTables.find((t) => t.owner === 'ExtraNavigation');
    expect(extra?.routes[0]?.path).toBe('/extra');
  });

  it('marks `...Owner.routes()` as a resolvable mount, not an unknown spread', async () => {
    const { routes, dynamic } = await extractFixture('route_tables.dart');
    const mounts = routes.filter((r) => r.spread);
    expect(mounts.map((r) => r.spread?.owner)).toContain('ModuleNavigation');
    // A method-call spread is a mount, never a "contents unknown" dynamic note.
    expect(dynamic.map((d) => d.reason).join('\n')).not.toContain('ModuleNavigation');
  });
});
