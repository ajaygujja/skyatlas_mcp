/**
 * Resolved route view: the canonical answer to "what path is this route, and
 * what screen does it render".
 *
 * A `RouteInfo` as extracted is deliberately incomplete, because completing it
 * requires cross-file data the per-file extractor cannot have:
 *
 * - a `path:` written as a const lands in `pathExpr` and needs the indexed
 *   string consts to become a path;
 * - routes mounted by `...Owner.routes()` live in `index.routeTables`, outside
 *   the route forest, and need owner resolution to be spliced into it;
 * - an auto_route entry names a generated `*Route` page class, and needs the
 *   `*.gr.dart` table to name the screen behind it.
 *
 * Every consumer reads paths and screens from this module rather than from
 * `RouteInfo` directly. A route has exactly one path, so the resolution that
 * produces it exists exactly once: independent resolution in two tools yields
 * two different answers for the same route, which is indistinguishable from a
 * wrong answer to a caller who cannot see the source.
 *
 * Resolution is SYNTACTIC (Working Rule 8): a const that no indexed declaration
 * defines stays verbatim and labelled, a mount whose table is not indexed
 * degrades to a dynamic note, and neither is ever guessed.
 */
import type { DynamicRouteNote, NamedRouteTable, RouteInfo } from '../model/flutter.js';
import type { ProjectIndex } from './project-index.js';
import { resolveClass } from './resolve.js';

/** Mount spreads can nest tables; bound the splice recursion alongside a cycle guard. */
const MAX_TABLE_DEPTH = 8;

/** Path shown for a ShellRoute/StatefulShellRoute, which is path-less by design. */
const SHELL_LABEL = '(shell — no path)';

/** Path shown for a non-shell route that declares no path the syntax layer can read. */
const NO_PATH_LABEL = '(no explicit path)';

/** A route with its path and screen resolved, and its subtree resolved likewise. */
export interface RouteView {
  /** The route as extracted; spliced mounts carry the table's own file and line. */
  route: RouteInfo;
  /** Resolved path, or a marker for a shell / path-less / unresolved-const route. */
  path: string;
  /**
   * Widget the route renders. For auto_route this is the screen behind the page
   * class, resolved through the generated table; absent when no screen is
   * syntactically visible.
   */
  screen?: string;
  children: RouteView[];
}

/**
 * The auto_route table in its two indexed halves. The hand-written table is
 * authoritative for paths and guards; the generated `*.gr.dart` table is
 * authoritative for screens.
 */
export interface AutoRouteView {
  /** Hand-written entries, screens resolved through the generated table. */
  handwritten: RouteView[];
  /** Generated pages with no hand-written counterpart. */
  orphans: RouteView[];
  /** True when no hand-written table is indexed, making `orphans` the whole table. */
  generatedOnly: boolean;
}

export interface ResolvedRoutes {
  /** go_router forest with static mount spreads spliced in. */
  go: RouteView[];
  auto: AutoRouteView;
  /** Route tables the syntax layer cannot enumerate, including unresolvable mounts. */
  dynamics: DynamicRouteNote[];
  /**
   * Every resolved route by the screen it renders. An auto_route entry is listed
   * under both its resolved screen and the page class naming it, so a lookup by
   * either name finds the route.
   */
  byScreen: Map<string, RouteView[]>;
}

/** Resolve every indexed route. Pure read over the index; nothing is cached. */
export function resolveRoutes(index: ProjectIndex): ResolvedRoutes {
  const consts = index.stringConsts();
  const dynamics: DynamicRouteNote[] = [...index.dynamicRoutes];

  const spliced = spliceRouteTables(
    index,
    index.routes.filter((r) => r.router === 'go_router'),
    dynamics,
  );
  const go = spliced.map((r) => resolveGoRoute(r, undefined, consts));
  const auto = resolveAutoRoutes(
    index,
    index.routes.filter((r) => r.router === 'auto_route'),
  );

  const byScreen = new Map<string, RouteView[]>();
  indexByScreen(go, byScreen);
  indexByScreen(auto.handwritten, byScreen);
  indexByScreen(auto.orphans, byScreen);

  return { go, auto, dynamics, byScreen };
}

// ── go_router ───────────────────────────────────────────────────────────────

/**
 * Resolves one go_router subtree top-down, carrying each route's resolved path
 * into its children. The join must happen here rather than in the extractor: a
 * relative literal child under a const-path parent (`path: 'edit'` nested under
 * `path: RoutePaths.workLogDetail`) only reaches its true `/work-log-detail/edit`
 * once the parent's const is resolved. Shells and unresolved consts contribute
 * no segment and pass the parent path through unchanged.
 */
function resolveGoRoute(
  route: RouteInfo,
  parentPath: string | undefined,
  consts: Map<string, string>,
): RouteView {
  const { seg, label } = ownSegment(route, consts);
  const full = seg !== undefined ? joinPath(parentPath, seg) : undefined;
  const childContext = full ?? parentPath;
  const view: RouteView = {
    route,
    path: full ?? label ?? NO_PATH_LABEL,
    children: route.children.map((child) => resolveGoRoute(child, childContext, consts)),
  };
  if (route.screenWidget) view.screen = route.screenWidget;
  return view;
}

/**
 * A route's own path segment: `seg` is joinable (a literal, or a const resolved
 * from the index), `label` is a terminal display string for a segment that
 * cannot be joined.
 */
function ownSegment(
  route: RouteInfo,
  consts: Map<string, string>,
): { seg?: string; label?: string } {
  if (route.path !== undefined) return { seg: route.path };
  if (route.pathExpr) {
    const resolved = resolveConst(route.pathExpr, consts);
    return resolved !== undefined
      ? { seg: resolved }
      : { label: `${route.pathExpr} (unresolved const)` };
  }
  return { label: route.isShell ? SHELL_LABEL : NO_PATH_LABEL };
}

/** A const path reference by its qualified name (`RoutePaths.home`), else bare (`home`). */
function resolveConst(pathExpr: string, consts: Map<string, string>): string | undefined {
  return consts.get(pathExpr) ?? consts.get(lastSegment(pathExpr));
}

/** `RoutePaths.home` → `home`; a bare ref is returned unchanged. */
function lastSegment(ref: string): string {
  const parts = ref.split('.');
  return parts[parts.length - 1] ?? ref;
}

/** go_router join: an absolute child path wins; else parent + '/' + child. */
function joinPath(parent: string | undefined, seg: string): string {
  if (seg.startsWith('/')) return seg;
  const base = parent ?? '';
  const joined = base.endsWith('/') ? base + seg : `${base}/${seg}`;
  return joined.replace(/\/{2,}/g, '/');
}

// ── mount spreads ───────────────────────────────────────────────────────────

/**
 * Replaces each `...Owner.method()` mount node with the routes of the static
 * table it names. The owner resolves through the shared symbol resolver
 * (deterministic across duplicate names) to its declaring file, which is then
 * matched to a table by method. A table may mount further tables, so resolution
 * recurses under a depth cap and a per-path cycle guard keyed by table identity.
 * An owner whose table is not indexed — or a cycle, or an overflow — degrades to
 * a dynamic note rather than a fabricated route.
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

// ── auto_route ──────────────────────────────────────────────────────────────

/**
 * Splits the auto_route entries into the hand-written table and the generated
 * `*.gr.dart` fallback, then resolves each hand-written entry's page class to
 * the real screen the generated `PageInfo` builder names (`HomeRoute` →
 * `HomeScreen`). Generated entries with no hand-written counterpart stay listed
 * as orphans; when nothing hand-written is indexed at all they are the table.
 */
function resolveAutoRoutes(index: ProjectIndex, auto: RouteInfo[]): AutoRouteView {
  const generated = auto.filter((r) => isGenerated(index, r));
  const handwritten = auto.filter((r) => !isGenerated(index, r));

  const screenByName = new Map<string, string>();
  for (const g of generated) {
    if (g.name && g.screenWidget) screenByName.set(g.name, g.screenWidget);
  }

  const handwrittenNames = new Set<string>();
  for (const r of handwritten) collectNames(r, handwrittenNames);
  const orphans = generated.filter((g) => !g.name || !handwrittenNames.has(g.name));

  return {
    handwritten: handwritten.map((r) => resolveAutoRoute(r, screenByName)),
    orphans: orphans.map((r) => resolveAutoRoute(r, screenByName)),
    generatedOnly: handwritten.length === 0,
  };
}

/**
 * Resolves one auto_route subtree. Unlike go_router, auto_route paths are
 * literal-only, so the full path the extractor computed from nesting stands as
 * written and needs no re-joining here.
 */
function resolveAutoRoute(route: RouteInfo, screenByName: Map<string, string>): RouteView {
  const view: RouteView = {
    route,
    path: autoPath(route),
    children: route.children.map((child) => resolveAutoRoute(child, screenByName)),
  };
  // An entry the generated table does not name keeps its page class as the
  // screen: that is the most specific name syntax makes available for it.
  const screen =
    (route.screenWidget ? screenByName.get(route.screenWidget) : undefined) ?? route.screenWidget;
  if (screen !== undefined) view.screen = screen;
  return view;
}

function autoPath(route: RouteInfo): string {
  if (route.fullPath) return route.fullPath;
  if (route.path) return route.path;
  return route.isShell ? SHELL_LABEL : NO_PATH_LABEL;
}

function isGenerated(index: ProjectIndex, route: RouteInfo): boolean {
  return index.files.get(route.file)?.generated === true;
}

function collectNames(route: RouteInfo, into: Set<string>): void {
  if (route.name) into.add(route.name);
  for (const child of route.children) collectNames(child, into);
}

// ── screen lookup ───────────────────────────────────────────────────────────

/**
 * Registers each route under every name that identifies its screen. An
 * auto_route entry is reachable by the resolved screen and by the page class,
 * because a caller may know the route by either.
 */
function indexByScreen(views: RouteView[], into: Map<string, RouteView[]>): void {
  for (const view of views) {
    for (const name of [view.screen, view.route.screenWidget]) {
      if (name === undefined) continue;
      const bucket = into.get(name);
      if (bucket) {
        if (!bucket.includes(view)) bucket.push(view);
      } else {
        into.set(name, [view]);
      }
    }
    indexByScreen(view.children, into);
  }
}
