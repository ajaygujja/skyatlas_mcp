/**
 * get_route_graph — the navigation map (TECHNICAL_DESIGN.md §6): route tree(s)
 * with computed full paths, the screen widget per route, and guards, indented
 * by real CST nesting. Answers "what is the route structure / which screen is
 * at path X / what guards a route" in one call.
 *
 * Layer boundary (Working Rule 6): path, screen and mount resolution live in
 * src/index/route-view.ts, shared with find_state_wiring so both tools report
 * the same path for the same route. This tool only renders the resolved view.
 *
 * Honest about what syntax can't see (§12, Working Rule 8): route tables built
 * by reference or with a collection-for/spread are reported as "generated
 * dynamically — unknown", never fabricated.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { DynamicRouteNote, RouteInfo, RouterKind } from '../model/flutter.js';
import { resolveRoutes, type AutoRouteView, type RouteView } from '../index/route-view.js';
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
  // Resolved before the router filter is applied: splicing a mount is what
  // discovers an unresolvable one, and those notes belong in the output whether
  // or not the routes they stand in for were asked for.
  const resolved = resolveRoutes(index);
  const lines: string[] = [];
  const body: string[] = [];

  const goGuards = index.routerGuards.filter((g) => g.router === 'go_router');
  if (wanted('go_router') && (resolved.go.length > 0 || goGuards.length > 0)) {
    body.push('## go_router');
    for (const g of goGuards) {
      body.push(`- global redirect: ${g.redirect} — ${g.file}:${String(g.line)}`);
    }
    for (const view of resolved.go) renderRoute(view, 0, body);
    body.push('');
  }

  if (wanted('auto_route')) renderAutoRoute(resolved.auto, body);

  const dynamics = resolved.dynamics.filter((d) => wanted(d.router));
  if (dynamics.length > 0) {
    body.push(
      `## Dynamic routes — ${String(dynamics.length)} table(s) the syntax layer can't enumerate`,
    );
    for (const d of dynamics) body.push(dynamicLine(d));
    body.push('');
  }

  const total =
    countRoutes(resolved.go) + index.routes.filter((r) => r.router === 'auto_route').length;
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
    'Paths/screens are syntactic — screen names are constructors as written, not resolved. ' +
      'Const paths (e.g. `RoutePaths.home`) are resolved from indexed string consts where possible; ' +
      'an unresolved one is shown verbatim and labelled.',
  );
  return lines;
}

/** Renders a resolved subtree, one line per route, indented by nesting depth. */
function renderRoute(view: RouteView, depth: number, out: string[]): void {
  out.push(routeLine(view, depth));
  for (const child of view.children) renderRoute(child, depth + 1, out);
}

/** go_router line: `path → ScreenWidget (name) — file:line [guards]`. */
function routeLine(view: RouteView, depth: number): string {
  const { route } = view;
  const indent = '  '.repeat(depth);
  // A shell wraps its child navigator; show its wrapper distinctly from a `→ screen`.
  const screenPart = view.screen
    ? ` → ${view.screen}`
    : route.shellWidget
      ? ` (shell: ${route.shellWidget})`
      : '';
  const name = route.name && route.name !== view.screen ? ` (${route.name})` : '';
  return `${indent}- ${view.path}${screenPart}${name} — ${route.file}:${String(route.line)}${guardsPart(route)}`;
}

/**
 * auto_route line: `path → PageRef → ResolvedScreen — file:line [guards]`. The
 * page ref is the generated `*Route` class named in the table; the screen behind
 * it is appended when the generated table resolves one.
 */
function autoRouteLine(view: RouteView, depth: number): string {
  const { route } = view;
  const indent = '  '.repeat(depth);
  const ref = route.screenWidget ? ` → ${route.screenWidget}` : '';
  const screen = view.screen && view.screen !== route.screenWidget ? ` → ${view.screen}` : '';
  // A RedirectRoute has no screen — it forwards to another path.
  const redirect = route.redirectTo ? ` → ${route.redirectTo} (redirect)` : '';
  return `${indent}- ${view.path}${ref}${screen}${redirect} — ${route.file}:${String(route.line)}${guardsPart(route)}`;
}

function guardsPart(route: RouteInfo): string {
  return route.guards ? `  [guards: ${route.guards.join(', ')}]` : '';
}

/**
 * auto_route: the hand-written table carries paths and guards, the generated
 * `*.gr.dart` table carries screens. Generated pages the hand-written table
 * never names are listed after it; when no hand-written table is indexed the
 * generated one is shown as the fallback (§7.4).
 */
function renderAutoRoute(auto: AutoRouteView, out: string[]): void {
  if (auto.generatedOnly) {
    if (auto.orphans.length === 0) return;
    out.push('## auto_route (from generated *.gr.dart — no hand-written table indexed)');
    for (const view of auto.orphans) renderRoute(view, 0, out);
    out.push('');
    return;
  }

  out.push('## auto_route');
  for (const view of auto.handwritten) renderAutoSubtree(view, 0, out);
  if (auto.orphans.length > 0) {
    out.push('### Generated-only pages (in *.gr.dart, absent from the hand-written table)');
    for (const view of auto.orphans) renderRoute(view, 0, out);
  }
  out.push('');
}

function renderAutoSubtree(view: RouteView, depth: number, out: string[]): void {
  out.push(autoRouteLine(view, depth));
  for (const child of view.children) renderAutoSubtree(child, depth + 1, out);
}

function dynamicLine(d: DynamicRouteNote): string {
  return `- ${d.file}:${String(d.line)} — ${d.reason}`;
}

function countRoutes(views: RouteView[]): number {
  let n = 0;
  for (const v of views) n += 1 + countRoutes(v.children);
  return n;
}

function emptyMessage(index: ProjectIndex, router: RouterKind | undefined): string {
  if (router) {
    return `No ${router} routes found in the index. Call get_project_map to see the detected router, or omit router= to show all.`;
  }
  return `No routes found in ${String(index.files.size)} indexed file(s). This app may use imperative Navigator.push (navigator1), build routes dynamically, or define them in a package not yet indexed. Call get_project_map to see the detected stack.`;
}
