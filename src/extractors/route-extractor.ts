/**
 * Route extractor (TECHNICAL_DESIGN.md Phase 3d): builds the navigation route
 * forest from the CST — go_router (`GoRoute`/`ShellRoute`/`StatefulShellRoute`)
 * and auto_route (`@RoutePage`, `AutoRoute` tables, `*.gr.dart` PageRouteInfo
 * fallback). Nesting is real CST nesting; `fullPath` is computed by walking
 * ancestors — no paren counting (§1.2, §7.3).
 *
 * Pure: CST in → data out, no I/O (§9.1).
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 *
 * GRAMMAR NOTE (§2): unlike the bloc/widget/provider extractors, route
 * constructors are NOT generic at value position (`GoRoute(...)`, not
 * `GoRoute<...>(...)`), so the record-literal mis-parse does not bite here —
 * every route call parses cleanly as `identifier + selector(argument_part)`.
 * Named constructors (`StatefulShellRoute.indexedStack`) put a `.indexedStack`
 * selector between the identifier and the argument selector; argsOfCall skips it.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { DynamicRouteNote, RouteInfo, RouterGuardNote } from '../model/flutter.js';

export interface RouteExtraction {
  /** Top-level routes (forest); nested routes hang off `children`. */
  routes: RouteInfo[];
  /** Route tables the syntax layer cannot enumerate — honest absence (§12). */
  dynamic: DynamicRouteNote[];
  /** Router-level guards (go_router global `redirect:`), one per router. */
  routerGuards: RouterGuardNote[];
}

/** go_router route constructors. Shells carry no own path. */
const GO_ROUTE_CTORS = new Set(['GoRoute', 'ShellRoute', 'StatefulShellRoute']);
const SHELL_CTORS = new Set(['ShellRoute', 'StatefulShellRoute']);

/** auto_route table entries: navigable pages and `RedirectRoute` aliases. */
const AUTO_ROUTE_CTORS = new Set(['AutoRoute', 'RedirectRoute']);

/**
 * State-management wrappers a route builder may return around the real screen
 * (`builder: (c, s) => BlocProvider(child: HomeScreen())`). Like `PAGE_WRAPPERS`
 * the screen is their `child:`, but a wrapper with no visible child screen yields
 * an honest "no screen" rather than the wrapper's own name.
 */
const STATE_WRAPPERS = new Set([
  'BlocProvider',
  'MultiBlocProvider',
  'Provider',
  'ChangeNotifierProvider',
]);

/** go_router `pageBuilder:` Page wrappers — the real screen is their `child:`. */
const PAGE_WRAPPERS = new Set([
  'MaterialPage',
  'CupertinoPage',
  'NoTransitionPage',
  'CustomTransitionPage',
]);

export function extractRoutes(tree: Tree, relPath: string): RouteExtraction {
  const routes: RouteInfo[] = [];
  const dynamic: DynamicRouteNote[] = [];
  const routerGuards: RouterGuardNote[] = [];
  extractGoRouter(tree.rootNode, relPath, routes, dynamic, routerGuards);
  extractAutoRoute(tree.rootNode, relPath, routes, dynamic);
  return { routes, dynamic, routerGuards };
}

// ───────────────────────── go_router ─────────────────────────

/**
 * Each `GoRouter(routes: [...])` call seeds a top-level route list. Observed:
 *   (identifier 'GoRouter') (selector (argument_part (arguments
 *     (named_argument (label (identifier 'routes')) (list_literal …)))))
 * A `routes:` value that is not a literal list (`GoRouter(routes: sharedRoutes)`)
 * is reported as a dynamic table, never fabricated. A router-level `redirect:`
 * (the global auth guard) applies to the whole table, so it is recorded as a
 * RouterGuardNote rather than attached to any single route.
 */
function extractGoRouter(
  root: Node,
  relPath: string,
  routes: RouteInfo[],
  dynamic: DynamicRouteNote[],
  routerGuards: RouterGuardNote[],
): void {
  for (const id of root.descendantsOfType('identifier')) {
    if (id.text !== 'GoRouter') continue;
    const args = argsOfCall(id);
    if (!args) continue;
    const redirect = redirectGuard(args);
    if (redirect) {
      routerGuards.push({ router: 'go_router', file: relPath, line: line(id), redirect });
    }
    const routesArg = namedArgValue(args, 'routes');
    if (!routesArg) continue;
    if (routesArg.type === 'list_literal') {
      parseGoRouteList(routesArg, undefined, relPath, routes, dynamic);
    } else {
      dynamic.push({
        router: 'go_router',
        file: relPath,
        line: line(routesArg),
        reason: `GoRouter routes provided by reference (\`${routesArg.text}\`), not a literal list — table unknown`,
      });
    }
  }
}

/**
 * Parses the entries of a go_router `routes:` (or branch `routes:`) list into
 * RouteInfo, appending to `out`. `for`/`if`/spread elements are counted as
 * dynamic (their paths are computed at runtime) but the static route siblings
 * in the same list are still extracted.
 */
function parseGoRouteList(
  list: Node,
  parentFullPath: string | undefined,
  relPath: string,
  out: RouteInfo[],
  dynamic: DynamicRouteNote[],
): void {
  for (const child of list.namedChildren) {
    if (child.type === 'for_element' || child.type === 'if_element') {
      dynamic.push({
        router: 'go_router',
        file: relPath,
        line: line(child),
        reason: 'route(s) generated by a collection-for/if — contents unknown',
      });
      continue;
    }
    if (child.type === 'spread_element') {
      dynamic.push({
        router: 'go_router',
        file: relPath,
        line: line(child),
        reason: `routes spread from \`${child.text}\` — contents unknown`,
      });
      continue;
    }
    if (child.type === 'identifier' && GO_ROUTE_CTORS.has(child.text)) {
      out.push(buildGoRoute(child, parentFullPath, relPath, dynamic));
    }
  }
}

function buildGoRoute(
  idNode: Node,
  parentFullPath: string | undefined,
  relPath: string,
  dynamic: DynamicRouteNote[],
): RouteInfo {
  const ctor = idNode.text;
  const args = argsOfCall(idNode);
  const isShell = SHELL_CTORS.has(ctor);

  const path = isShell ? undefined : stringArg(args, 'path');
  // Shells contribute no path segment; they pass the parent path to children.
  const fullPath = isShell ? parentFullPath : joinPath(parentFullPath, path);

  const route: RouteInfo = {
    router: 'go_router',
    file: relPath,
    line: line(idNode),
    children: [],
  };
  if (isShell) route.isShell = true;
  if (path !== undefined) route.path = path;
  // A non-literal `path:` (a const reference like `RoutePaths.home`) is kept
  // verbatim for display-time resolution instead of being dropped (§5.1 honesty).
  else if (!isShell) {
    const expr = pathExprArg(args);
    if (expr !== undefined) route.pathExpr = expr;
  }
  const name = stringArg(args, 'name');
  if (name !== undefined) route.name = name;
  if (fullPath !== undefined) route.fullPath = fullPath;
  const screen = args ? screenFromBuilders(args) : undefined;
  // A shell's builder returns a wrapper around the child navigator, not a
  // navigable destination — keep it distinct from a route's screen.
  if (screen) {
    if (isShell) route.shellWidget = screen;
    else route.screenWidget = screen;
  }
  const guards = args ? routeGuards(args) : undefined;
  if (guards) route.guards = guards;

  if (args) collectGoChildren(args, fullPath, relPath, route.children, dynamic);
  return route;
}

/**
 * go_router child routes: a `routes:` list nests directly; a
 * StatefulShellRoute's `branches:` list holds StatefulShellBranch calls whose
 * own `routes:` lists are flattened in as children (the shell has no path, so
 * branch routes inherit the shell's parent path).
 */
function collectGoChildren(
  args: Node,
  parentFullPath: string | undefined,
  relPath: string,
  out: RouteInfo[],
  dynamic: DynamicRouteNote[],
): void {
  const routesArg = namedArgValue(args, 'routes');
  if (routesArg?.type === 'list_literal') {
    parseGoRouteList(routesArg, parentFullPath, relPath, out, dynamic);
  }
  const branchesArg = namedArgValue(args, 'branches');
  if (branchesArg?.type === 'list_literal') {
    for (const branch of branchesArg.namedChildren) {
      if (branch.type !== 'identifier' || branch.text !== 'StatefulShellBranch') continue;
      const branchArgs = argsOfCall(branch);
      const branchRoutes = branchArgs ? namedArgValue(branchArgs, 'routes') : undefined;
      if (branchRoutes?.type === 'list_literal') {
        parseGoRouteList(branchRoutes, parentFullPath, relPath, out, dynamic);
      }
    }
  }
}

/** go_router fullPath join: absolute child wins; else parent + '/' + child. */
function joinPath(parent: string | undefined, path: string | undefined): string | undefined {
  if (path === undefined) return parent;
  if (path.startsWith('/')) return path;
  const base = parent ?? '';
  const joined = base.endsWith('/') ? base + path : `${base}/${path}`;
  return joined.replace(/\/{2,}/g, '/');
}

// ───────────────────────── auto_route ─────────────────────────

/**
 * auto_route has two route sources:
 *  - the hand-written `AutoRoute(page: XRoute.page, …)` table (the canonical
 *    nesting + paths + guards), and
 *  - the generated `*.gr.dart` PageRouteInfo classes (§7.4 fallback — sometimes
 *    the only full table; carries the real screen widget via PageInfo's builder).
 * Both are emitted; get_route_graph merges them by route name.
 */
function extractAutoRoute(
  root: Node,
  relPath: string,
  routes: RouteInfo[],
  dynamic: DynamicRouteNote[],
): void {
  for (const id of topLevelAutoRoutes(root)) {
    routes.push(buildAutoRoute(id, undefined, relPath, dynamic));
  }
  for (const cls of root.descendantsOfType('class_definition')) {
    const gen = generatedRouteFor(cls, relPath);
    if (gen) routes.push(gen);
  }
}

/**
 * AutoRoute calls whose enclosing list is NOT a `children:` argument — i.e. the
 * roots of the table. Nested AutoRoutes are reached via buildAutoRoute recursion.
 */
function topLevelAutoRoutes(root: Node): Node[] {
  const out: Node[] = [];
  for (const id of root.descendantsOfType('identifier')) {
    if (!AUTO_ROUTE_CTORS.has(id.text) || !argsOfCall(id)) continue;
    const owner = id.parent?.parent; // identifier → list_literal → owner
    if (owner?.type === 'named_argument' && labelOf(owner) === 'children') continue;
    out.push(id);
  }
  return out;
}

function buildAutoRoute(
  idNode: Node,
  parentFullPath: string | undefined,
  relPath: string,
  dynamic: DynamicRouteNote[],
): RouteInfo {
  const args = argsOfCall(idNode);
  const route: RouteInfo = {
    router: 'auto_route',
    file: relPath,
    line: line(idNode),
    children: [],
  };
  // `RedirectRoute(path: '*', redirectTo: '/login')` is a path alias, not a page:
  // it carries no screen and no children. Its path stays verbatim (the catch-all
  // `*` is not a joinable segment).
  if (idNode.text === 'RedirectRoute') {
    const path = stringArg(args, 'path');
    if (path !== undefined) route.path = path;
    const to = stringArg(args, 'redirectTo');
    if (to !== undefined) route.redirectTo = to;
    return route;
  }
  // `page: HomeRoute.page` — the value is the leading identifier (the generated
  // route class); the `.page` is a sibling selector. Verbatim, never resolved.
  const page = args ? namedArgValue(args, 'page') : undefined;
  if (page?.type === 'identifier') {
    route.name = page.text;
    route.screenWidget = page.text;
  }
  const path = stringArg(args, 'path');
  if (path !== undefined) {
    route.path = path;
    const full = joinPath(parentFullPath, path);
    if (full !== undefined) route.fullPath = full;
  }
  const guards = args ? guardsList(args) : undefined;
  if (guards) route.guards = guards;

  const childrenArg = args ? namedArgValue(args, 'children') : undefined;
  if (childrenArg?.type === 'list_literal') {
    const childParent = route.fullPath ?? parentFullPath;
    for (const child of childrenArg.namedChildren) {
      if (child.type === 'identifier' && AUTO_ROUTE_CTORS.has(child.text) && argsOfCall(child)) {
        route.children.push(buildAutoRoute(child, childParent, relPath, dynamic));
      }
    }
  }
  return route;
}

/**
 * `*.gr.dart` fallback (§7.4): a `class XRoute extends PageRouteInfo<…>` whose
 * `static const String name` is the route name and whose `static PageInfo page`
 * builder returns the real screen widget. Observed:
 *   (class_definition (identifier 'HomeRoute') (superclass (type_identifier 'PageRouteInfo') …)
 *     (class_body
 *       (declaration … (static_final_declaration (identifier 'name') (string_literal 'HomeRoute')))
 *       (declaration (type_identifier 'PageInfo') (initialized_identifier_list
 *         (initialized_identifier (identifier 'page') (identifier 'PageInfo')
 *           (selector (argument_part (arguments … (named_argument (label 'builder') (function_expression …))))))))))
 */
function generatedRouteFor(cls: Node, relPath: string): RouteInfo | undefined {
  const superId = cls.namedChildren
    .find((c) => c.type === 'superclass')
    ?.namedChildren.find((c) => c.type === 'type_identifier');
  if (superId?.text !== 'PageRouteInfo') return undefined;

  const className = cls.namedChildren.find((c) => c.type === 'identifier')?.text;
  const body = cls.namedChildren.find((c) => c.type === 'class_body');
  if (!className || !body) return undefined;

  const route: RouteInfo = {
    router: 'auto_route',
    name: routeNameField(body) ?? className,
    file: relPath,
    line: line(cls),
    children: [],
  };
  const screen = pageInfoScreen(body);
  if (screen) route.screenWidget = screen;
  return route;
}

/** `static const String name = '…'` → the literal, when present. */
function routeNameField(classBody: Node): string | undefined {
  for (const decl of classBody.namedChildren) {
    if (decl.type !== 'declaration') continue;
    const list = decl.namedChildren.find((c) => c.type === 'static_final_declaration_list');
    const sfd = list?.namedChildren.find((c) => c.type === 'static_final_declaration');
    const nameId = sfd?.namedChildren.find((c) => c.type === 'identifier');
    if (nameId?.text !== 'name') continue;
    const lit = sfd?.namedChildren.find((c) => c.type === 'string_literal');
    if (lit) return stripQuotes(lit.text);
  }
  return undefined;
}

/** The screen widget a generated route's `PageInfo(builder: …)` returns. */
function pageInfoScreen(classBody: Node): string | undefined {
  for (const init of classBody.descendantsOfType('initialized_identifier')) {
    const ids = init.namedChildren.filter((c) => c.type === 'identifier');
    if (ids[0]?.text !== 'page' || ids[1]?.text !== 'PageInfo') continue;
    const args = argsOfCall(ids[1]);
    const builder = args ? namedArgValue(args, 'builder') : undefined;
    if (builder?.type === 'function_expression') return screenFromFunction(builder);
  }
  return undefined;
}

// ───────────────────────── shared helpers ─────────────────────────

/**
 * The `arguments` node of a call whose callee is `idNode`, skipping any named-
 * constructor selectors (`.indexedStack`) that sit between the identifier and
 * the argument selector. Returns undefined when `idNode` is not a call.
 */
function argsOfCall(idNode: Node): Node | undefined {
  let sib = idNode.nextNamedSibling;
  while (sib?.type === 'selector') {
    const first = sib.namedChildren[0];
    if (first?.type === 'argument_part') {
      return first.namedChildren.find((c) => c.type === 'arguments');
    }
    sib = sib.nextNamedSibling;
  }
  return undefined;
}

/** Value of a named argument by label, or undefined. */
function namedArgValue(args: Node, label: string): Node | undefined {
  for (const arg of args.namedChildren) {
    if (arg.type !== 'named_argument' || labelOf(arg) !== label) continue;
    return arg.namedChildren.find((c) => c.type !== 'label');
  }
  return undefined;
}

/** A named string argument with surrounding quotes stripped. */
function stringArg(args: Node | undefined, label: string): string | undefined {
  if (!args) return undefined;
  const val = namedArgValue(args, label);
  return val?.type === 'string_literal' ? stripQuotes(val.text) : undefined;
}

/**
 * Verbatim text of a non-literal `path:` value (a const reference), or undefined
 * when the path is absent or a plain string literal. `path: RoutePaths.home`
 * parses as `identifier 'RoutePaths'` + sibling `selector '.home'`, so the full
 * reference is the concatenation of the argument's non-label children.
 */
function pathExprArg(args: Node | undefined): string | undefined {
  if (!args) return undefined;
  for (const arg of args.namedChildren) {
    if (arg.type !== 'named_argument' || labelOf(arg) !== 'path') continue;
    const parts = arg.namedChildren.filter((c) => c.type !== 'label');
    if (parts.length === 0 || parts[0]?.type === 'string_literal') return undefined;
    return parts.map((p) => p.text).join('');
  }
  return undefined;
}

/** Screen widget from a route's `builder:` (else `pageBuilder:`) argument. */
function screenFromBuilders(args: Node): string | undefined {
  const fn = namedArgValue(args, 'builder') ?? namedArgValue(args, 'pageBuilder');
  return fn?.type === 'function_expression' ? screenFromFunction(fn) : undefined;
}

/**
 * The widget construction a builder closure returns, handling both arrow
 * (`=> const X()`) and block (`{ … return X(); }`) bodies. A go_router Page
 * wrapper (MaterialPage/…) or a state wrapper (BlocProvider/…) is unwrapped one
 * level to its `child:` screen — but a page wrapper falls back to its own name
 * (it is itself a route page) while a state wrapper falls back to nothing (it is
 * not a screen, so reporting it would mislead — §5.1 honesty).
 *
 * For a block body the LAST top-level `return` is used, not the first
 * construction in document order: a `pageBuilder` commonly opens with a
 * null-guard early return (`if (x == null) return ErrorPage();`) and falls
 * through to the real screen — picking the first construction would report the
 * guard. Returns inside nested closures (a child `builder:`) are ignored.
 */
function screenFromFunction(fn: Node): string | undefined {
  const body = fn.namedChildren.find((c) => c.type === 'function_expression_body');
  if (!body) return undefined;
  const target = lastTopLevelReturn(body) ?? body;
  const built = firstConstruction(target);
  if (!built) return undefined;
  if (PAGE_WRAPPERS.has(built.name)) return childScreen(built) ?? built.name;
  if (STATE_WRAPPERS.has(built.name)) return childScreen(built);
  return built.name;
}

/** The screen built by a wrapper's `child:` argument, when syntactically visible. */
function childScreen(built: { name: string; args?: Node }): string | undefined {
  const child = built.args ? namedArgValue(built.args, 'child') : undefined;
  return child ? firstConstruction(child)?.name : undefined;
}

/**
 * The last `return_statement` belonging to THIS function body (block-bodied
 * closures), in document order — guard early-returns precede the real one. Nested
 * `function_expression`s are not descended into, so an inner closure's return
 * never masquerades as this closure's screen. Returns undefined for an arrow body
 * (no `return_statement`), leaving the caller to scan the expression directly.
 */
function lastTopLevelReturn(body: Node): Node | undefined {
  const returns: Node[] = [];
  const walk = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'function_expression') continue;
      if (child.type === 'return_statement') returns.push(child);
      walk(child);
    }
  };
  walk(body);
  return returns.at(-1);
}

/**
 * First constructor invocation in document order under `node`. Handles
 * `const X(...)` (const_object_expression) and bare `X(...)` (PascalCase
 * identifier + argument selector). Returns its name and arguments node.
 */
function firstConstruction(node: Node): { name: string; args?: Node } | undefined {
  const here = constructionAt(node);
  if (here) return here;
  for (const child of node.namedChildren) {
    const found = firstConstruction(child);
    if (found) return found;
  }
  return undefined;
}

function constructionAt(node: Node): { name: string; args?: Node } | undefined {
  if (node.type === 'const_object_expression') {
    const t = node.namedChildren.find((c) => c.type === 'type_identifier');
    if (t) {
      const result: { name: string; args?: Node } = { name: t.text };
      const args = node.namedChildren.find((c) => c.type === 'arguments');
      if (args) result.args = args;
      return result;
    }
  }
  if (node.type === 'identifier' && isConstructorName(node.text)) {
    const sel = node.nextNamedSibling;
    const ap = sel?.type === 'selector' ? sel.namedChildren[0] : undefined;
    if (ap?.type === 'argument_part') {
      const result: { name: string; args?: Node } = { name: node.text };
      const args = ap.namedChildren.find((c) => c.type === 'arguments');
      if (args) result.args = args;
      return result;
    }
  }
  return undefined;
}

/** go_router `redirect:` — a tear-off identifier, or an inline closure marker. */
function redirectGuard(args: Node): string | undefined {
  const redirect = namedArgValue(args, 'redirect');
  if (redirect?.type === 'identifier') return redirect.text;
  if (redirect?.type === 'function_expression') return '(inline redirect)';
  return undefined;
}

/** A route's own `redirect:` guard, as a single-element list for `RouteInfo.guards`. */
function routeGuards(args: Node): string[] | undefined {
  const redirect = redirectGuard(args);
  return redirect ? [redirect] : undefined;
}

/** auto_route `guards: [AuthGuard, …]` → the guard class identifiers. */
function guardsList(args: Node): string[] | undefined {
  const list = namedArgValue(args, 'guards');
  if (list?.type !== 'list_literal') return undefined;
  const out = list.namedChildren.filter((c) => c.type === 'identifier').map((c) => c.text);
  return out.length > 0 ? out : undefined;
}

/** `(label (identifier))` → the identifier text. */
function labelOf(namedArg: Node): string | undefined {
  const label = namedArg.namedChildren.find((c) => c.type === 'label');
  return label?.namedChildren.find((c) => c.type === 'identifier')?.text;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

function isConstructorName(s: string): boolean {
  const c = s.replace(/^_+/, '')[0];
  return c !== undefined && c >= 'A' && c <= 'Z';
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}
