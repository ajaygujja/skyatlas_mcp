/**
 * Flutter domain models, built on top of the core Symbol model
 * (TECHNICAL_DESIGN.md §5.2). Phase 3 fills these in one extractor at a time.
 *
 * 3a adds WidgetInfo / WidgetNode; 3b adds BlocInfo + Edge. Provider/Route
 * models join in 3c–3d.
 *
 * Honesty rule (§5.1): every name here is verbatim source text — a constructor
 * name as written, never a resolved type. Widget trees are STATIC: what the
 * build() method literally constructs, not what renders at runtime.
 */

export type WidgetFlavor =
  | 'stateless'
  | 'stateful'
  | 'state'
  | 'consumer'
  | 'hook'
  | 'unknownWidgetSubclass';

/** A widget class and the static widget tree inside its build(). */
export interface WidgetInfo {
  /** Id of the class Symbol: `${relPath}#${ClassName}`. */
  symbolId: string;
  /** Class name as written. */
  name: string;
  flavor: WidgetFlavor;
  file: string;
  /** Line of the class declaration (1-based). */
  line: number;
  /** Superclass as written, e.g. "State<SettingsScreen>" — verbatim. */
  superclass?: string;
  /**
   * Present when a build() method was found and its returned tree parsed.
   * Multiple entries represent alternative branches (conditional/switch/early-return
   * patterns); each root is marked `branch: true` when there are ≥2 outcomes.
   */
  buildTree?: WidgetNode[];
}

/**
 * One node in a static build() tree: a constructor invocation as written.
 * `namedSlots` maps an argument label ("child", "children", "body", "builder",
 * …) to the widget constructions found inside it. Positional children land
 * under the key "(positional)".
 */
export interface WidgetNode {
  /** Constructor name as written: "Scaffold", "ListView.builder", "BlocBuilder". */
  widget: string;
  /** Type args when present: BlocBuilder<UserBloc, UserState> → ["UserBloc","UserState"]. */
  typeArgs?: string[];
  /** 1-based line of the construction. */
  line: number;
  namedSlots: Record<string, WidgetNode[]>;
  /** True when this subtree came from a builder closure (builder:, itemBuilder:, …). */
  isBuilderCallback?: boolean;
  /**
   * True when this node was recovered from a grammar mis-parse of a generic
   * constructor (§2 record-literal ambiguity, e.g. `BlocBuilder<A, B>(...)`).
   * Its slots are best-effort; absence of children is not proof of none.
   */
  recoveredFromMisparse?: boolean;
  /**
   * True when this root is one of ≥2 alternative branches (conditional return,
   * switch-expression return, or multiple return statements). Honesty label:
   * the tree shows all statically reachable outcomes, not a single path.
   */
  branch?: true;
  /**
   * Honesty marker for a child built dynamically rather than as a literal
   * constructor call. The node is shown but never as a plain static child:
   *   - 'mapped': one representative child from a `.map`/`.where`/`.expand`
   *     closure over a collection (`items.map((e) => Tile()).toList()`); the
   *     real count is runtime-dependent, not enumerable.
   *   - 'spread': a spread element (`...widgets`) — an opaque list reference.
   */
  dynamic?: 'mapped' | 'spread';
  /**
   * True when this child lives inside a collection-`if`
   * (`if (cond) Banner()`) and therefore renders only when the condition
   * holds. Distinct from `branch`, which marks whole-tree alternatives.
   */
  conditional?: true;
}

export type BlocFlavor = 'bloc' | 'cubit';

/**
 * A Bloc/Cubit class and its handler/emit surface (Phase 3b, §5.2). Classified
 * by superclass suffix: a base ending in `Bloc` → bloc (two type args, event +
 * state); ending in `Cubit` → cubit (one type arg, state only). The suffix rule
 * (mirroring WidgetInfo's `endsWith('Widget')`) catches custom bases like
 * `HydratedBloc`/`HydratedCubit` without a hard-coded list.
 *
 * Fields beyond §5.2's original sketch — `name`/`file`/`line`/`emitSites` —
 * mirror WidgetInfo (3a convention) and the §8-3b scope ("emit(...) call sites").
 */
export interface BlocInfo {
  /** Id of the class Symbol: `${relPath}#${ClassName}`. */
  symbolId: string;
  /** Class name as written. */
  name: string;
  flavor: BlocFlavor;
  file: string;
  /** Line of the class declaration (1-based). */
  line: number;
  /** Event type arg, verbatim — bloc only (`Bloc<Event, State>` → Event). */
  eventType?: string;
  /** State type arg, verbatim (`Bloc<Event, State>`/`Cubit<State>` → State). */
  stateType?: string;
  /** `on<Event>(handler)` registrations. `methodName` absent for inline closures. */
  handlers: { eventType: string; methodName?: string; line: number }[];
  /** Lines of `emit(...)` call sites within the class (1-based, source order). */
  emitSites: number[];
}

/**
 * A Riverpod provider (Phase 3c, §5.2). Two declaration shapes:
 *  - `global`:    `final xProvider = Provider<T>((ref) => …)` — a top-level final.
 *  - `generated`: `@riverpod` on a function or class (the `*.g.dart` companion
 *                 declares the real provider; we record the annotated source).
 *
 * `providerType` is the constructor name as written (Provider / StateProvider /
 * NotifierProvider / FutureProvider / …) for the global form — classified by
 * string, never resolved. Absent for the generated form (the type lives in the
 * generated file). Suffix rule `endsWith('Provider')` mirrors 3a/3b's convention.
 */
export interface ProviderInfo {
  /** Id of the declaring Symbol when there is one (generated class/fn; some globals). */
  symbolId?: string;
  /** Variable name (global) or annotated function/class name (generated), as written. */
  name: string;
  declKind: 'global' | 'generated';
  /** Constructor name for the global form, verbatim — e.g. "StateNotifierProvider". */
  providerType?: string;
  /** Type args when syntactically present, verbatim. */
  typeArgs?: string[];
  file: string;
  /** Line of the declaration (1-based). */
  line: number;
}

export type RouterKind = 'go_router' | 'auto_route' | 'navigator1';

/**
 * A navigation route (Phase 3d, §5.2). Built from real CST nesting — no paren
 * counting. `fullPath` is computed by walking ancestors (go_router join rules);
 * `ShellRoute`/`StatefulShellRoute` contribute no path segment of their own and
 * pass the parent path through to their children.
 *
 * Honesty rule (§5.1, Working Rule 8): `screenWidget` is the constructor name as
 * written in the route's builder, never a resolved type. For auto_route it is the
 * generated `*Route` page class referenced (`page: HomeRoute.page` → "HomeRoute");
 * the *.gr.dart fallback (§7.4) resolves it to the real screen via the PageInfo
 * builder. Absent when the builder is not a single syntactically visible widget.
 */
export interface RouteInfo {
  router: RouterKind;
  /** Path as written (go_router), or auto_route's explicit `path:`. Absent for shells / derived paths. */
  path?: string;
  /**
   * Verbatim path reference when `path:` is not a string literal but a const
   * (`path: RoutePaths.home` → "RoutePaths.home"). The value is resolved against
   * the indexed string consts at display time (get_route_graph), falling back to
   * this raw text labelled "(unresolved const)". Never both `path` and `pathExpr`.
   */
  pathExpr?: string;
  /** True for ShellRoute/StatefulShellRoute — path-less by design, not a missing path. */
  isShell?: boolean;
  /** Route name: go_router `name:`, or the auto_route page class (`HomeRoute`). */
  name?: string;
  /** Computed from nesting: parent fullPath joined with own path. Absent when a path is. */
  fullPath?: string;
  /** Screen widget the route builds, as written — see honesty note above. */
  screenWidget?: string;
  /**
   * Wrapper widget a ShellRoute/StatefulShellRoute builder returns
   * (`ShellRoute(builder: (c, s, child) => ScaffoldShell(child: child))` →
   * "ScaffoldShell"). A shell wraps its child navigator; it is not a navigable
   * destination, so it is kept distinct from `screenWidget` and never both.
   */
  shellWidget?: string;
  /**
   * Redirect target of an auto_route `RedirectRoute(path: '*', redirectTo: '/login')`
   * — the destination path as written. Present only on redirect routes, which
   * carry no screen.
   */
  redirectTo?: string;
  file: string;
  /** 1-based line of the route construction. */
  line: number;
  /** Real nesting from the CST (go_router `routes:`/`branches:`, auto_route `children:`). */
  children: RouteInfo[];
  /** redirect/guard identifiers when present (`redirect: authGuard`, `guards: [AuthGuard]`). */
  guards?: string[];
}

/**
 * A route table the syntax layer cannot enumerate (§12, Working Rule 8):
 * `routes:` given by reference (`GoRouter(routes: sharedRoutes)`), or built with
 * a collection-`for`/spread. Reported as honest absence, never fabricated.
 */
export interface DynamicRouteNote {
  router: RouterKind;
  file: string;
  /** 1-based line of the construct that hides the routes. */
  line: number;
  reason: string;
}

/**
 * A router-level guard that applies to the whole table rather than one route:
 * go_router's `GoRouter(redirect: …)` global redirect. Surfaced separately from
 * per-route `guards` so the graph can show it once at the top instead of
 * fabricating a route to hang it on.
 */
export interface RouterGuardNote {
  router: RouterKind;
  file: string;
  /** 1-based line of the router construction. */
  line: number;
  /** The redirect as written: a tear-off identifier, or "(inline redirect)". */
  redirect: string;
}

export type EdgeKind =
  | 'createsBloc'
  | 'readsBloc'
  | 'watchesProvider'
  | 'constructsWidget'
  | 'extends'
  | 'implements'
  | 'mixesIn'
  | 'imports';

/** Honest about resolution: name-matching is syntactic, never type-resolved. */
export type EdgeConfidence = 'exact' | 'syntactic';

/**
 * A cross-cutting, syntax-derived relationship (§5.2). 3b emits the Bloc kinds —
 * `createsBloc` (`BlocProvider(create:)`) and `readsBloc` (`context.read/watch<X>()`,
 * `BlocBuilder<X, _>`); 3c adds `watchesProvider` (`ref.watch/read/listen(xProvider)`).
 * `from` is the enclosing class's symbolId (or the file path when at top level);
 * `to` is a bare name — resolution to a symbolId happens in 3e.
 */
export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 1-based line of the call site. */
  line: number;
  confidence: EdgeConfidence;
}
