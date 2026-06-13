/**
 * get_route_graph — the navigation map (TECHNICAL_DESIGN.md §6): route tree(s)
 * with computed full paths, the screen widget per route, and guards, indented
 * by real CST nesting. Answers "what is the route structure / which screen is
 * at path X / what guards a route" in one call.
 *
 * Honest about what syntax can't see (§12, Working Rule 8): route tables built
 * by reference or with a collection-for/spread are reported as "generated
 * dynamically — unknown", never fabricated.
 *
 * auto_route note: the hand-written `AutoRoute` table names generated `*Route`
 * page classes; the `*.gr.dart` fallback (§7.4) carries the real screen widget.
 * This tool merges them — resolving `HomeRoute → HomeScreen` by route name — and
 * falls back to the generated table when no hand-written one is indexed.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { DynamicRouteNote, RouteInfo, RouterKind } from '../model/flutter.js';
import { capLines, errorResult, textResult } from './format.js';

const MAX_LINES = 250;

export function registerGetRouteGraph(
  server: McpServer,
  getIndex: () => Promise<ProjectIndex>,
): void {
  server.registerTool(
    'get_route_graph',
    {
      title: 'Get route graph',
      description:
        'Navigation route graph of a Flutter app: full paths, the screen widget ' +
        'per route, and guards, indented by nesting. Covers go_router ' +
        '(GoRoute/ShellRoute/StatefulShellRoute) and auto_route (@RoutePage/AutoRoute, ' +
        'with *.gr.dart fallback). Answers "what is the route structure", "which screen ' +
        'is at /path", "what guards this route" in one call. Routes built dynamically ' +
        '(loops/conditionals/by-reference) are reported as unknown, not guessed.',
      inputSchema: {
        router: z
          .enum(['go_router', 'auto_route', 'navigator1'])
          .optional()
          .describe('Limit to one router. Omit to show every detected router.'),
      },
    },
    async ({ router }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }
      return textResult(formatRouteGraph(index, router).join('\n'));
    },
  );
}

function formatRouteGraph(index: ProjectIndex, router: RouterKind | undefined): string[] {
  const wanted = (k: RouterKind): boolean => router === undefined || router === k;
  const lines: string[] = [];
  const body: string[] = [];

  const go = index.routes.filter((r) => r.router === 'go_router');
  if (wanted('go_router') && go.length > 0) {
    body.push('## go_router');
    for (const route of go) renderRoute(route, 0, undefined, body);
    body.push('');
  }

  if (wanted('auto_route')) {
    const auto = index.routes.filter((r) => r.router === 'auto_route');
    renderAutoRoute(auto, index, body);
  }

  const dynamics = index.dynamicRoutes.filter((d) => wanted(d.router));
  if (dynamics.length > 0) {
    body.push(
      `## Dynamic routes — ${String(dynamics.length)} table(s) the syntax layer can't enumerate`,
    );
    for (const d of dynamics) body.push(dynamicLine(d));
    body.push('');
  }

  const total = countRoutes(go) + index.routes.filter((r) => r.router === 'auto_route').length;
  if (body.length === 0) {
    return [emptyMessage(index, router)];
  }

  lines.push(
    `# Route graph: ${String(total)} route(s)` +
      (dynamics.length > 0 ? `, ${String(dynamics.length)} dynamic table(s)` : ''),
  );
  lines.push('');
  lines.push(...capLines(body, MAX_LINES, 'filter with router='));
  lines.push(
    'Paths/screens are syntactic — screen names are constructors as written, not resolved.',
  );
  return lines;
}

/** Renders one go_router subtree; `screenOverride` lets auto_route inject a resolved screen. */
function renderRoute(
  route: RouteInfo,
  depth: number,
  screenOverride: string | undefined,
  out: string[],
): void {
  out.push(routeLine(route, depth, screenOverride));
  for (const child of route.children) renderRoute(child, depth + 1, undefined, out);
}

/** go_router line: `path → ScreenWidget (name) — file:line [guards]`. */
function routeLine(route: RouteInfo, depth: number, screenOverride: string | undefined): string {
  const indent = '  '.repeat(depth);
  const path = pathLabel(route);
  const screen = screenOverride ?? route.screenWidget;
  const screenPart = screen ? ` → ${screen}` : '';
  const guards = guardsPart(route);
  const name = route.name && route.name !== screen ? ` (${route.name})` : '';
  return `${indent}- ${path}${screenPart}${name} — ${route.file}:${String(route.line)}${guards}`;
}

/**
 * auto_route line: `path → PageRef → ResolvedScreen — file:line [guards]`. The
 * page ref is the generated `*Route` named in the table; the resolved screen
 * (from the *.gr.dart PageInfo builder) is appended when known.
 */
function autoRouteLine(
  route: RouteInfo,
  depth: number,
  resolvedScreen: string | undefined,
): string {
  const indent = '  '.repeat(depth);
  const ref = route.screenWidget ? ` → ${route.screenWidget}` : '';
  const screen = resolvedScreen ? ` → ${resolvedScreen}` : '';
  return `${indent}- ${pathLabel(route)}${ref}${screen} — ${route.file}:${String(route.line)}${guardsPart(route)}`;
}

/** Path display, router-aware: go_router shells are path-less; auto_route may derive its path. */
function pathLabel(route: RouteInfo): string {
  if (route.fullPath) return route.fullPath;
  if (route.path) return route.path;
  return route.router === 'go_router' ? '(shell — no path)' : '(no explicit path)';
}

function guardsPart(route: RouteInfo): string {
  return route.guards ? `  [guards: ${route.guards.join(', ')}]` : '';
}

/**
 * auto_route: merge the hand-written table with the generated *.gr.dart fallback.
 * A generated route resolves the real screen (HomeRoute → HomeScreen) for the
 * hand-written entry of the same name; generated routes with no hand-written
 * counterpart are listed as the fallback table.
 */
function renderAutoRoute(auto: RouteInfo[], index: ProjectIndex, out: string[]): void {
  if (auto.length === 0) return;
  const generated = auto.filter((r) => isGenerated(index, r));
  const handwritten = auto.filter((r) => !isGenerated(index, r));

  // name → real screen, from the generated PageRouteInfo classes.
  const screenByName = new Map<string, string>();
  for (const g of generated) {
    if (g.name && g.screenWidget) screenByName.set(g.name, g.screenWidget);
  }

  if (handwritten.length > 0) {
    out.push('## auto_route');
    const handwrittenNames = new Set<string>();
    for (const r of handwritten) collectNames(r, handwrittenNames);
    for (const route of handwritten) renderAutoSubtree(route, 0, screenByName, out);

    const orphanGenerated = generated.filter((g) => !g.name || !handwrittenNames.has(g.name));
    if (orphanGenerated.length > 0) {
      out.push('### Generated-only pages (in *.gr.dart, absent from the hand-written table)');
      for (const g of orphanGenerated) out.push(routeLine(g, 0, undefined));
    }
    out.push('');
    return;
  }

  // Fallback: only the generated table exists (§7.4).
  out.push('## auto_route (from generated *.gr.dart — no hand-written table indexed)');
  for (const route of generated) renderRoute(route, 0, undefined, out);
  out.push('');
}

/** Renders an auto_route subtree, resolving each route's real screen via the generated map. */
function renderAutoSubtree(
  route: RouteInfo,
  depth: number,
  screenByName: Map<string, string>,
  out: string[],
): void {
  const resolved = route.screenWidget ? screenByName.get(route.screenWidget) : undefined;
  out.push(autoRouteLine(route, depth, resolved));
  for (const child of route.children) renderAutoSubtree(child, depth + 1, screenByName, out);
}

function collectNames(route: RouteInfo, into: Set<string>): void {
  if (route.name) into.add(route.name);
  for (const child of route.children) collectNames(child, into);
}

function dynamicLine(d: DynamicRouteNote): string {
  return `- ${d.file}:${String(d.line)} — ${d.reason}`;
}

function isGenerated(index: ProjectIndex, route: RouteInfo): boolean {
  return index.files.get(route.file)?.generated === true;
}

function countRoutes(routes: RouteInfo[]): number {
  let n = 0;
  for (const r of routes) n += 1 + countRoutes(r.children);
  return n;
}

function emptyMessage(index: ProjectIndex, router: RouterKind | undefined): string {
  if (router) {
    return `No ${router} routes found in the index. Call get_project_map to see the detected router, or omit router= to show all.`;
  }
  return `No routes found in ${String(index.files.size)} indexed file(s). This app may use imperative Navigator.push (navigator1), build routes dynamically, or define them in a package not yet indexed. Call get_project_map to see the detected stack.`;
}
