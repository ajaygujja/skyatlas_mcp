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

  it('treats ShellRoute as path-less and passes the parent path through', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const shell = routes.find((r) => r.screenWidget === 'ScaffoldShell');
    expect(shell?.path).toBeUndefined();
    expect(shell?.fullPath).toBeUndefined();
    // Absolute child paths survive the shell unchanged.
    expect(shell?.children.map((c) => c.fullPath)).toEqual(['/profile', '/profile/edit']);
  });

  it('unwraps a pageBuilder MaterialPage to its child screen, and reads the redirect guard', async () => {
    const { routes } = await extractFixture('go_router_app.dart');
    const profile = routes.flatMap((r) => r.children).find((r) => r.path === '/profile');
    expect(profile?.screenWidget).toBe('ProfilePage');
    expect(profile?.guards).toEqual(['authGuard']);
  });

  it('flattens StatefulShellRoute branches into children', async () => {
    const { routes } = await extractFixture('stateful_shell.dart');
    const shell = routes[0];
    expect(shell?.screenWidget).toBe('HomeShell');
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
});
