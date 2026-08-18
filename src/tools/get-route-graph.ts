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
import type { RouteInfo, RouterKind } from '../model/flutter.js';
import {
  resolveRoutes,
  type AutoRouteView,
  type ResolvedRoutes,
  type RouteView,
} from '../index/route-view.js';
import {
  BARE_LINE_NOTE,
  capBody,
  errorResult,
  FileScope,
  textResult,
  VERBOSITY_DESCRIPTION,
  VERBOSITY_VALUES,
  type BodyLimits,
  type Verbosity,
} from './format.js';

/**
 * Size limits for the route body. Routes are uniform one-line facts, so the
 * count grows with the repo while line width stays flat — the character budget
 * (~3,500 tokens) is what actually bounds a whole-repo graph.
 */
const BODY_LIMITS: BodyLimits = {
  maxLines: 250,
  maxChars: 14_000,
  narrowHint: 'filter with router= or pass verbosity="summary"',
};

/** Distinct first path segments listed in a summary before the rest are counted. */
const MAX_SUMMARY_SEGMENTS = 25;

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
        '(loops/conditionals/by-reference) are reported as unknown, not guessed. ' +
        'On an unfamiliar repo call it with verbosity="summary" first: that reports the ' +
        'route count, the files declaring them and the top-level paths for a fraction of ' +
        'the cost, then narrow with router=.',
      inputSchema: {
        router: z
          .enum(['go_router', 'auto_route', 'navigator1'])
          .optional()
          .describe('Limit to one router. Omit to show every detected router.'),
        verbosity: z.enum(VERBOSITY_VALUES).optional().describe(VERBOSITY_DESCRIPTION),
      },
    },
    async ({ router, verbosity }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }
      return textResult(formatRouteGraph(index, router, verbosity ?? 'normal').join('\n'));
    },
  );
}

function formatRouteGraph(
  index: ProjectIndex,
  router: RouterKind | undefined,
  verbosity: Verbosity,
): string[] {
  const wanted = (k: RouterKind): boolean => router === undefined || router === k;
  // Resolved before the router filter is applied: splicing a mount is what
  // discovers an unresolvable one, and those notes belong in the output whether
  // or not the routes they stand in for were asked for.
  const resolved = resolveRoutes(index);
  const lines: string[] = [];
  const body: string[] = [];

  if (verbosity === 'summary') return summarize(index, resolved, wanted);

  const goGuards = index.routerGuards.filter((g) => g.router === 'go_router');
  if (wanted('go_router') && (resolved.go.length > 0 || goGuards.length > 0)) {
    // One scope per section: every section names each of its files at least
    // once, so a bare `:line` always resolves against a path close above it.
    const scope = new FileScope();
    body.push('## go_router');
    for (const g of goGuards) {
      body.push(`- global redirect: ${g.redirect} — ${scope.ref(g.file, g.line)}`);
      scope.enter(g.file);
    }
    for (const view of resolved.go) renderRoute(view, 0, body, scope);
    body.push('');
  }

  if (wanted('auto_route')) renderAutoRoute(resolved.auto, body);

  const dynamics = resolved.dynamics.filter((d) => wanted(d.router));
  if (dynamics.length > 0) {
    const scope = new FileScope();
    body.push(
      `## Dynamic routes — ${String(dynamics.length)} table(s) the syntax layer can't enumerate`,
    );
    for (const d of dynamics) {
      body.push(`- ${scope.ref(d.file, d.line)} — ${d.reason}`);
      scope.enter(d.file);
    }
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
  lines.push(...capBody(body, BODY_LIMITS, verbosity));
  lines.push(
    'Paths/screens are syntactic — screen names are constructors as written, not resolved. ' +
      'Const paths (e.g. `RoutePaths.home`) are resolved from indexed string consts where possible; ' +
      'an unresolved one is shown verbatim and labelled. ' +
      BARE_LINE_NOTE,
  );
  return lines;
}

/**
 * Shape of the graph without the graph: how many routes each router holds, the
 * files that declare them, and the top-level path segments they live under.
 *
 * This is the orientation answer for a repo whose full graph costs thousands of
 * tokens — it names the files to open and the segments to filter on, which is
 * what a caller needs before it knows what to narrow to. Every count is derived
 * from the same resolved view the full rendering walks, so the two never
 * disagree about how many routes exist.
 */
function summarize(
  index: ProjectIndex,
  resolved: ResolvedRoutes,
  wanted: (k: RouterKind) => boolean,
): string[] {
  const goRoutes = wanted('go_router') ? flatten(resolved.go) : [];
  const autoRoutes = wanted('auto_route')
    ? [...flatten(resolved.auto.handwritten), ...flatten(resolved.auto.orphans)]
    : [];
  const dynamics = resolved.dynamics.filter((d) => wanted(d.router));

  if (goRoutes.length === 0 && autoRoutes.length === 0 && dynamics.length === 0) {
    return [emptyMessage(index, undefined)];
  }

  const lines = [
    `# Route graph (summary): ${String(goRoutes.length + autoRoutes.length)} route(s)` +
      (dynamics.length > 0 ? `, ${String(dynamics.length)} dynamic table(s)` : ''),
  ];
  for (const [label, views] of [
    ['go_router', goRoutes],
    ['auto_route', autoRoutes],
  ] as const) {
    if (views.length === 0) continue;
    lines.push('');
    lines.push(`## ${label} — ${String(views.length)} route(s)`);
    lines.push(...countLines('Declared in', tally(views.map((v) => v.route.file))));
    lines.push(...countLines('Top-level paths', tally(views.map((v) => topSegment(v.path)))));
  }
  if (dynamics.length > 0) {
    lines.push('');
    lines.push(`## Dynamic routes — ${String(dynamics.length)} table(s) syntax can't enumerate`);
    lines.push(...countLines('Declared in', tally(dynamics.map((d) => d.file))));
  }
  lines.push('');
  lines.push('Pass verbosity="normal" for paths, screens and guards; router= to narrow.');
  return lines;
}

/** `<label> (N): key n · key n`, most frequent first, with the tail counted. */
function countLines(label: string, counts: Map<string, number>): string[] {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, MAX_SUMMARY_SEGMENTS);
  const rest = sorted.length - shown.length;
  const rendered = shown.map(([key, n]) => `${key} ${String(n)}`).join(' · ');
  const tail = rest > 0 ? ` · … +${String(rest)} more` : '';
  return [`${label} (${String(sorted.length)}): ${rendered}${tail}`];
}

function tally(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** `/forms/detail/:id` → `/forms`; a shell or path-less route groups under its label. */
function topSegment(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments.length > 0 && path.startsWith('/') ? `/${segments[0] ?? ''}` : path;
}

/** Every route in a forest, parents before children. */
function flatten(views: RouteView[]): RouteView[] {
  return views.flatMap((view) => [view, ...flatten(view.children)]);
}

/** Renders a resolved subtree, one line per route, indented by nesting depth. */
function renderRoute(view: RouteView, depth: number, out: string[], scope: FileScope): void {
  out.push(routeLine(view, depth, scope));
  scope.enter(view.route.file);
  for (const child of view.children) renderRoute(child, depth + 1, out, scope);
}

/** go_router line: `path → ScreenWidget (name) — file:line [guards]`. */
function routeLine(view: RouteView, depth: number, scope: FileScope): string {
  const { route } = view;
  const indent = '  '.repeat(depth);
  // A shell wraps its child navigator; show its wrapper distinctly from a `→ screen`.
  const screenPart = view.screen
    ? ` → ${view.screen}`
    : route.shellWidget
      ? ` (shell: ${route.shellWidget})`
      : '';
  const name = route.name && route.name !== view.screen ? ` (${route.name})` : '';
  const where = scope.ref(route.file, route.line);
  return `${indent}- ${view.path}${screenPart}${name} — ${where}${guardsPart(route)}`;
}

/**
 * auto_route line: `path → PageRef → ResolvedScreen — file:line [guards]`. The
 * page ref is the generated `*Route` class named in the table; the screen behind
 * it is appended when the generated table resolves one.
 */
function autoRouteLine(view: RouteView, depth: number, scope: FileScope): string {
  const { route } = view;
  const indent = '  '.repeat(depth);
  const ref = route.screenWidget ? ` → ${route.screenWidget}` : '';
  const screen = view.screen && view.screen !== route.screenWidget ? ` → ${view.screen}` : '';
  // A RedirectRoute has no screen — it forwards to another path.
  const redirect = route.redirectTo ? ` → ${route.redirectTo} (redirect)` : '';
  const where = scope.ref(route.file, route.line);
  return `${indent}- ${view.path}${ref}${screen}${redirect} — ${where}${guardsPart(route)}`;
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
  const scope = new FileScope();
  if (auto.generatedOnly) {
    if (auto.orphans.length === 0) return;
    out.push('## auto_route (from generated *.gr.dart — no hand-written table indexed)');
    for (const view of auto.orphans) renderRoute(view, 0, out, scope);
    out.push('');
    return;
  }

  out.push('## auto_route');
  for (const view of auto.handwritten) renderAutoSubtree(view, 0, out, scope);
  if (auto.orphans.length > 0) {
    out.push('### Generated-only pages (in *.gr.dart, absent from the hand-written table)');
    for (const view of auto.orphans) renderRoute(view, 0, out, scope);
  }
  out.push('');
}

function renderAutoSubtree(view: RouteView, depth: number, out: string[], scope: FileScope): void {
  out.push(autoRouteLine(view, depth, scope));
  scope.enter(view.route.file);
  for (const child of view.children) renderAutoSubtree(child, depth + 1, out, scope);
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
