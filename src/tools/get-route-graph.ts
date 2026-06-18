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
import type { DynamicRouteNote, NamedRouteTable, RouteInfo, RouterKind } from '../model/flutter.js';
import { resolveClass } from '../index/resolve.js';
import { capLines, errorResult, textResult } from './format.js';

const MAX_LINES = 250;
/** Mount spreads can nest tables; bound the splice recursion alongside a cycle guard. */
const MAX_TABLE_DEPTH = 8;

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
  const consts = index.stringConsts();
  const lines: string[] = [];
  const body: string[] = [];

  // Routes mounted via `...Owner.routes()` are spliced in from their static
  // tables here, where cross-file resolution is available; unresolved mounts
  // and table-internal dynamics surface in the dynamic section below.
  const spreadDynamics: DynamicRouteNote[] = [];
  const go = spliceRouteTables(
    index,
    index.routes.filter((r) => r.router === 'go_router'),
    spreadDynamics,
  );
  const goGuards = index.routerGuards.filter((g) => g.router === 'go_router');
  if (wanted('go_router') && (go.length > 0 || goGuards.length > 0)) {
    body.push('## go_router');
    for (const g of goGuards) {
      body.push(`- global redirect: ${g.redirect} — ${g.file}:${String(g.line)}`);
    }
    for (const route of go) renderRoute(route, 0, undefined, consts, undefined, body);
    body.push('');
  }

  if (wanted('auto_route')) {
    const auto = index.routes.filter((r) => r.router === 'auto_route');
    renderAutoRoute(auto, index, consts, body);
  }

  const dynamics = [...index.dynamicRoutes, ...spreadDynamics].filter((d) => wanted(d.router));
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
    'Paths/screens are syntactic — screen names are constructors as written, not resolved. ' +
      'Const paths (e.g. `RoutePaths.home`) are resolved from indexed string consts where possible; ' +
      'an unresolved one is shown verbatim and labelled.',
  );
  return lines;
}

/**
 * Replaces each `...Owner.method()` mount node with the routes of the static
 * table it names. The owner is resolved through the shared symbol resolver
 * (deterministic across duplicate names) to its declaring file, then matched to
 * a table by method. A table may mount further tables, so resolution recurses
 * under a depth cap and a per-path cycle guard keyed by table identity. An owner
 * whose table is not indexed — or a cycle/overflow — degrades to an honest
 * dynamic note rather than a fabricated route.
 */
function spliceRouteTables(
  index: ProjectIndex,
  routes: RouteInfo[],
  dynamicsOut: DynamicRouteNote[],
): RouteInfo[] {
  const tables = new Map<string, NamedRouteTable>();
  for (const t of index.routeTables) tables.set(tableKey(t.file, t.owner, t.method), t);
  return expandMounts(routes, tables, index, dynamicsOut, 0, new Set());
}

function expandMounts(
  routes: RouteInfo[],
  tables: Map<string, NamedRouteTable>,
  index: ProjectIndex,
  dynamicsOut: DynamicRouteNote[],
  depth: number,
  seen: Set<string>,
): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const route of routes) {
    if (route.spread) {
      const table = resolveTable(index, tables, route.spread);
      const key = table && tableKey(table.file, table.owner, table.method);
      if (!table || !key || depth >= MAX_TABLE_DEPTH || seen.has(key)) {
        dynamicsOut.push(unresolvedMount(route));
        continue;
      }
      dynamicsOut.push(...table.dynamic);
      const nested = new Set(seen).add(key);
      out.push(...expandMounts(table.routes, tables, index, dynamicsOut, depth + 1, nested));
      continue;
    }
    out.push({
      ...route,
      children: expandMounts(route.children, tables, index, dynamicsOut, depth, seen),
    });
  }
  return out;
}

/** The static table a mount names, or undefined when none is indexed for it. */
function resolveTable(
  index: ProjectIndex,
  tables: Map<string, NamedRouteTable>,
  spread: { owner: string; method: string },
): NamedRouteTable | undefined {
  const owner = resolveClass(index, spread.owner);
  if (!owner) return undefined;
  return tables.get(tableKey(owner.file, spread.owner, spread.method));
}

function tableKey(file: string, owner: string, method: string): string {
  return `${file}::${owner}.${method}`;
}

function unresolvedMount(route: RouteInfo): DynamicRouteNote {
  const m = route.spread;
  return {
    router: 'go_router',
    file: route.file,
    line: route.line,
    reason: `routes mounted from \`...${m?.owner ?? '?'}.${m?.method ?? '?'}()\` — no static table indexed`,
  };
}

/**
 * Renders one go_router subtree, resolving each route's full path top-down.
 * `parentPath` is the resolved full path of the enclosing route (undefined at the
 * top). This is what makes a relative literal child under a const-path parent
 * (`path: 'edit'` nested under `path: RoutePaths.workLogDetail`) render as the
 * true `/work-log-detail/edit` rather than just its own `/edit` — the per-file
 * extractor cannot join against a const it has not yet resolved. Shells and
 * unresolved consts pass the parent context through unchanged.
 */
function renderRoute(
  route: RouteInfo,
  depth: number,
  screenOverride: string | undefined,
  consts: Map<string, string>,
  parentPath: string | undefined,
  out: string[],
): void {
  const { seg, label } = ownSegment(route, consts);
  const full = seg !== undefined ? joinResolved(parentPath, seg) : undefined;
  const display = full ?? label ?? '(no explicit path)';
  out.push(routeLine(route, depth, screenOverride, display));
  const childContext = full ?? parentPath;
  for (const child of route.children) {
    renderRoute(child, depth + 1, undefined, consts, childContext, out);
  }
}

/** go_router line: `path → ScreenWidget (name) — file:line [guards]`. */
function routeLine(
  route: RouteInfo,
  depth: number,
  screenOverride: string | undefined,
  path: string,
): string {
  const indent = '  '.repeat(depth);
  const screen = screenOverride ?? route.screenWidget;
  // A shell wraps its child navigator; show its wrapper distinctly from a `→ screen`.
  const screenPart = screen
    ? ` → ${screen}`
    : route.shellWidget
      ? ` (shell: ${route.shellWidget})`
      : '';
  const guards = guardsPart(route);
  const name = route.name && route.name !== screen ? ` (${route.name})` : '';
  return `${indent}- ${path}${screenPart}${name} — ${route.file}:${String(route.line)}${guards}`;
}

/**
 * A route's own path segment for top-down joining: `seg` is a joinable path (a
 * literal, or a const resolved from the index); `label` is a non-joinable display
 * string (unresolved const shown verbatim, or a shell/path-less marker).
 */
function ownSegment(
  route: RouteInfo,
  consts: Map<string, string>,
): { seg?: string; label?: string } {
  if (route.path !== undefined) return { seg: route.path };
  if (route.pathExpr) {
    const resolved = consts.get(route.pathExpr) ?? consts.get(lastSegment(route.pathExpr));
    return resolved !== undefined
      ? { seg: resolved }
      : { label: `${route.pathExpr} (unresolved const)` };
  }
  return { label: route.isShell ? '(shell — no path)' : '(no explicit path)' };
}

/** go_router join: an absolute child path wins; else parent + '/' + child. */
function joinResolved(parent: string | undefined, seg: string): string {
  if (seg.startsWith('/')) return seg;
  const base = parent ?? '';
  const joined = base.endsWith('/') ? base + seg : `${base}/${seg}`;
  return joined.replace(/\/{2,}/g, '/');
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
  consts: Map<string, string>,
): string {
  const indent = '  '.repeat(depth);
  const ref = route.screenWidget ? ` → ${route.screenWidget}` : '';
  const screen = resolvedScreen ? ` → ${resolvedScreen}` : '';
  // A RedirectRoute has no screen — it forwards to another path.
  const redirect = route.redirectTo ? ` → ${route.redirectTo} (redirect)` : '';
  return `${indent}- ${pathLabel(route, consts)}${ref}${screen}${redirect} — ${route.file}:${String(route.line)}${guardsPart(route)}`;
}

/**
 * Path display, router-aware. Literal paths win; a const reference is resolved
 * from the indexed string consts (qualified `RoutePaths.home`, else bare `home`)
 * and shown verbatim + "(unresolved const)" when it can't be. A genuine shell is
 * labelled as such; a path-less non-shell route is honestly "(no explicit path)"
 * rather than mislabelled a shell.
 */
function pathLabel(route: RouteInfo, consts: Map<string, string>): string {
  if (route.fullPath) return route.fullPath;
  if (route.path) return route.path;
  if (route.pathExpr) {
    const resolved = consts.get(route.pathExpr) ?? consts.get(lastSegment(route.pathExpr));
    return resolved ?? `${route.pathExpr} (unresolved const)`;
  }
  if (route.isShell) return '(shell — no path)';
  return '(no explicit path)';
}

/** `RoutePaths.home` → `home`; a bare ref is returned unchanged. */
function lastSegment(ref: string): string {
  const parts = ref.split('.');
  return parts[parts.length - 1] ?? ref;
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
function renderAutoRoute(
  auto: RouteInfo[],
  index: ProjectIndex,
  consts: Map<string, string>,
  out: string[],
): void {
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
    for (const route of handwritten) renderAutoSubtree(route, 0, screenByName, consts, out);

    const orphanGenerated = generated.filter((g) => !g.name || !handwrittenNames.has(g.name));
    if (orphanGenerated.length > 0) {
      out.push('### Generated-only pages (in *.gr.dart, absent from the hand-written table)');
      for (const g of orphanGenerated) out.push(routeLine(g, 0, undefined, pathLabel(g, consts)));
    }
    out.push('');
    return;
  }

  // Fallback: only the generated table exists (§7.4).
  out.push('## auto_route (from generated *.gr.dart — no hand-written table indexed)');
  for (const route of generated) renderRoute(route, 0, undefined, consts, undefined, out);
  out.push('');
}

/** Renders an auto_route subtree, resolving each route's real screen via the generated map. */
function renderAutoSubtree(
  route: RouteInfo,
  depth: number,
  screenByName: Map<string, string>,
  consts: Map<string, string>,
  out: string[],
): void {
  const resolved = route.screenWidget ? screenByName.get(route.screenWidget) : undefined;
  out.push(autoRouteLine(route, depth, resolved, consts));
  for (const child of route.children)
    renderAutoSubtree(child, depth + 1, screenByName, consts, out);
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
