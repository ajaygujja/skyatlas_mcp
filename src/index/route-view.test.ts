import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildIndex } from './indexer.js';
import { resolveRoutes, type ResolvedRoutes, type RouteView } from './route-view.js';

const ROUTES_FIXTURES = fileURLToPath(new URL('../../fixtures/routes', import.meta.url));

/** Every route in the forest, flattened depth-first. */
function flatten(views: RouteView[]): RouteView[] {
  return views.flatMap((v) => [v, ...flatten(v.children)]);
}

function everyRoute(resolved: ResolvedRoutes): RouteView[] {
  return [
    ...flatten(resolved.go),
    ...flatten(resolved.auto.handwritten),
    ...flatten(resolved.auto.orphans),
  ];
}

function pathOf(resolved: ResolvedRoutes, screen: string): string[] {
  return (resolved.byScreen.get(screen) ?? []).map((v) => v.path);
}

describe('resolveRoutes', () => {
  let resolved: ResolvedRoutes;

  beforeAll(async () => {
    const { index } = await buildIndex(ROUTES_FIXTURES);
    resolved = resolveRoutes(index);
  });

  it('resolves a const path against the indexed string consts', () => {
    expect(pathOf(resolved, 'HomeScreen')).toContain('/home');
    // An enum-backed const (`AppRoutes.splash.path`) resolves the same way.
    expect(pathOf(resolved, 'SplashScreen')).toEqual(['/splash']);
  });

  it('joins a relative const child onto its resolved const parent', () => {
    expect(pathOf(resolved, 'WorkLogDetailScreen')).toEqual(['/detail']);
    expect(pathOf(resolved, 'WorkLogEditScreen')).toEqual(['/detail/edit']);
  });

  it('shows a const with no indexed declaration verbatim, never guessed', () => {
    expect(pathOf(resolved, 'MysteryScreen')).toEqual(['RoutePaths.unmapped (unresolved const)']);
  });

  it('splices `...Owner.routes()` tables into the forest', () => {
    // These routes live in index.routeTables, outside index.routes entirely.
    expect(pathOf(resolved, 'ModuleScreen')).toEqual(['/module']);
    expect(pathOf(resolved, 'ModuleDetailScreen')).toEqual(['/module/detail']);
    expect(pathOf(resolved, 'ExtraScreen')).toEqual(['/extra']);
  });

  it('reports a mount with no indexed table as dynamic rather than dropping it', () => {
    const reasons = resolved.dynamics.map((d) => d.reason);
    expect(reasons).toContain(
      'routes mounted from `...MissingNavigation.routes()` — no static table indexed',
    );
  });

  it('resolves an auto_route page class to the screen behind it', () => {
    // The hand-written entry names HomeRoute; the generated table names the screen.
    const byPageClass = resolved.byScreen.get('HomeRoute') ?? [];
    expect(byPageClass).toHaveLength(1);
    expect(byPageClass[0]?.route.file).toBe('auto_route_config.dart');
    expect(byPageClass[0]?.screen).toBe('HomeScreen');
    // The same route is reachable by the screen name, so a caller who knows
    // either name lands on the hand-written entry rather than the generated one.
    expect(resolved.byScreen.get('HomeScreen')).toContain(byPageClass[0]);
  });

  it('keeps a page class the generated table does not name as its own screen', () => {
    expect(pathOf(resolved, 'DashboardRoute')).toEqual(['/dashboard']);
    expect(pathOf(resolved, 'StatsRoute')).toEqual(['/dashboard/stats']);
  });

  it('labels a shell distinctly from a route that simply declares no path', () => {
    const labels = everyRoute(resolved).map((v) => v.path);
    expect(labels).toContain('(shell — no path)');
    expect(labels).toContain('(no explicit path)');
  });

  // The invariant that makes one resolved view worth having: no route can be
  // looked up by screen and come back with a path other than its own.
  it('gives every route the same path through the forest and through byScreen', () => {
    for (const view of everyRoute(resolved)) {
      if (view.screen === undefined) continue;
      const found = resolved.byScreen.get(view.screen);
      expect(found).toContain(view);
      expect(found?.filter((v) => v === view).map((v) => v.path)).toEqual([view.path]);
    }
  });
});
