/**
 * State-management wiring resolution (TECHNICAL_DESIGN.md Phase 3e, §5.2, §6).
 *
 * Assembles the cross-cutting `Edge`s the 3b/3c extractors already emit
 * (createsBloc / readsBloc / watchesProvider) into resolved screen ↔
 * bloc/provider ↔ repository connections. This is the ONLY place resolution
 * lives — Working Rule 6: the find_state_wiring tool queries this module and
 * formats; it never touches tree-sitter or re-extracts.
 *
 * Honesty rule (§5.2, Working Rule 8): every link is a SYNTACTIC name-match,
 * never type resolution. An edge's bare `to` is resolved to a symbolId by
 * name only; an unresolved `to` stays a bare name and is reported as such —
 * never invented. Repository edges are param/field TYPE NAMES that happen to
 * match a class in the index (§7.3 last row) — also syntactic.
 *
 * Nothing here is stored on disk: wiring is recomputed from `index.edges` on
 * demand (§9.5 lazy), so there is no cache field and no version bump.
 */
import type { ProjectIndex } from './project-index.js';
import type { EdgeConfidence, EdgeKind } from '../model/flutter.js';
import type { Symbol } from '../model/symbol.js';
import { detectStack } from './stack-detect.js';
import { CONTAINER_KINDS, resolveClass } from './resolve.js';
import { resolveRoutes } from './route-view.js';
import { nearestNames } from '../shared/nearest.js';

/** Dependency hops followed from a bloc unless the caller asks for more. */
const DEFAULT_DEPTH = 1;

/** Edge kinds that connect a screen to its state (the outgoing wiring set). */
const WIRING_KINDS = new Set<EdgeKind>(['createsBloc', 'readsBloc', 'watchesProvider']);

export interface Loc {
  file: string;
  line: number;
}

/** A bloc/provider an edge points at, after name-match resolution. */
export interface ResolvedTarget {
  /** Bare name from the edge's `to`. */
  name: string;
  /** What the name resolved to: a bloc/cubit, a Riverpod provider, some other
   * class, or nothing in the index (`unknown`). */
  kind: 'bloc' | 'cubit' | 'provider' | 'class' | 'unknown';
  symbolId?: string;
  /** Declaration site of the resolved bloc/provider/class. */
  decl?: Loc;
}

/** Clean-architecture role of a dependency, inferred from its type-name suffix. */
export type DepRole = 'usecase' | 'repo' | 'datasource' | 'dependency';

/** A constructor-param/field dependency of a bloc whose type name resolves to a class. */
export interface RepoDep {
  /** Param or field name holding the dependency. */
  member: string;
  /** Type name as written (generics/nullable stripped to the base identifier). */
  typeName: string;
  /** Role read off the type-name suffix (syntactic, never type resolution). */
  role: DepRole;
  symbolId: string;
  /** Declaration site of the resolved dependency class. */
  decl: Loc;
  /** Where the dependency is declared on the owner (field or constructor line). */
  via: Loc;
  /** Hop distance from the queried bloc — 1 is a direct dependency. */
  depth: number;
  /** When `typeName` is an interface, the concrete class followed to continue the chain. */
  impl?: { typeName: string; decl: Loc };
}

/** One read/create/watch call site. */
export interface WireRef {
  kind: EdgeKind;
  callSite: Loc;
  confidence: EdgeConfidence;
}

/** A bloc/provider a screen wires to, with the bloc's repo deps (outgoing view). */
export interface TargetGroup {
  target: ResolvedTarget;
  via: WireRef[];
  repos: RepoDep[];
}

/** A screen/class that wires into the subject bloc/provider (incoming view). */
export interface SourceGroup {
  /** Enclosing class name, or `(file scope)` for a top-level call site. */
  name: string;
  symbolId?: string;
  decl?: Loc;
  /** When the source is a `State<Screen>` companion, the screen it belongs to. */
  screen?: string;
  via: WireRef[];
}

/** A route that renders the queried screen (reachability by route). */
export interface RouteRef {
  /** Resolved path, or a marker for a shell / path-less / unresolved-const route. */
  label: string;
  name?: string;
  loc: Loc;
}

export interface SubjectInfo {
  name: string;
  /** Display label, e.g. "stateless screen", "cubit", "StateProvider". */
  label: string;
  decl?: Loc;
}

/**
 * Known extraction gap in a file the answer was read from.
 *
 * Syntax the grammar could not parse is skipped, and extraction continues past
 * it (§9.4), so a wiring call site inside such a region is absent from the index
 * without being absent from the code. Reporting the gap is what separates
 * "nothing wires to this" from "the analysis could not see all of it" — the two
 * absences a caller must not confuse.
 */
export interface CoverageGap {
  file: string;
  parseErrors: number;
}

export type WiringFilter =
  | { kind: 'screen'; name: string }
  | { kind: 'bloc'; name: string }
  | { kind: 'provider'; name: string };

export interface WiringResult {
  filter: WiringFilter['kind'];
  query: string;
  /** True when the subject resolved as the requested kind. */
  found: boolean;
  /** Present when something matched the name — even a wrong-kind match (honest hint). */
  subject?: SubjectInfo;
  /** screen filter: blocs/providers this screen wires to. */
  targets: TargetGroup[];
  /** bloc/provider filter: screens/sources that wire into the subject. */
  sources: SourceGroup[];
  /** bloc filter: the subject bloc's resolved repository/dependency edges. */
  repos: RepoDep[];
  /** screen filter: routes that render this screen. */
  routes: RouteRef[];
  /** Detected state-management labels, for honest-absence guidance (§6 rule 5). */
  stateLabels: string[];
  /**
   * Names of the requested kind closest to an unresolved query — empty when the
   * subject resolved, or when nothing in the index is close enough to suggest.
   */
  suggestions: string[];
  /** Set when the subject's own file holds syntax the grammar could not parse. */
  coverage?: CoverageGap;
}

/** Resolve a wiring query against the index. Pure read over edges + symbols. */
export function computeWiring(
  index: ProjectIndex,
  filter: WiringFilter,
  depth: number = DEFAULT_DEPTH,
): WiringResult {
  const stateLabels = detectStack(index)
    .filter((h) => h.category === 'state')
    .map((h) => h.label);
  const base = {
    filter: filter.kind,
    query: filter.name,
    targets: [] as TargetGroup[],
    sources: [] as SourceGroup[],
    repos: [] as RepoDep[],
    routes: [] as RouteRef[],
    stateLabels,
    suggestions: [] as string[],
  };

  const result = ((): WiringResult => {
    switch (filter.kind) {
      case 'screen':
        return wireScreen(index, filter.name, base, depth);
      case 'bloc':
        return wireBloc(index, filter.name, base, depth);
      case 'provider':
        return wireProvider(index, filter.name, base);
    }
  })();

  if (!result.found)
    result.suggestions = nearestNames(candidateNames(index, filter.kind), filter.name);
  const gap = coverageGapOf(index, result.subject?.decl?.file);
  if (gap) result.coverage = gap;
  return result;
}

/**
 * The names a query of this kind could have resolved to. A suggestion drawn from
 * any wider pool would miss the same way the original query did, since each
 * filter resolves against one kind of declaration.
 */
function candidateNames(index: ProjectIndex, kind: WiringFilter['kind']): Iterable<string> {
  switch (kind) {
    case 'screen':
      return [...index.widgets.values()].map((w) => w.name);
    case 'bloc':
      return [...index.blocs.values()].map((b) => b.name);
    case 'provider':
      return index.providers.map((p) => p.name);
  }
}

/** The file's unparsable regions, when it has any — see `CoverageGap`. */
function coverageGapOf(index: ProjectIndex, file: string | undefined): CoverageGap | undefined {
  if (file === undefined) return undefined;
  const errors = index.files.get(file)?.parseErrors.length ?? 0;
  return errors > 0 ? { file, parseErrors: errors } : undefined;
}

type Base = Omit<WiringResult, 'found' | 'subject'>;

// ── screen ────────────────────────────────────────────────────────────────

function wireScreen(index: ProjectIndex, name: string, base: Base, depth: number): WiringResult {
  const ids = screenSymbolIds(index, name);
  if (ids.length === 0) return { ...base, found: false };

  const subject = screenSubject(index, name, ids);
  const idSet = new Set(ids);
  const edges = index.edges.filter((e) => idSet.has(e.from) && WIRING_KINDS.has(e.kind));
  const targets = groupTargets(index, edges, depth);
  const routes = routesForScreen(index, name);
  return { ...base, found: true, subject, targets, routes };
}

/**
 * The screen's own class symbolId plus any `State<ScreenName>` companion class —
 * a stateful screen's `context.read<X>()` sits in the State class, so its edge's
 * `from` is the State class, not the widget (§8-3e: "from is that screen's class
 * symbolId"). Including the companion keeps stateful screens reachable.
 */
function screenSymbolIds(index: ProjectIndex, name: string): string[] {
  const out = new Set<string>();
  for (const id of index.byName.get(name) ?? []) {
    const s = index.symbolsById.get(id);
    if (s && CONTAINER_KINDS.has(s.kind)) out.add(id);
  }
  for (const w of index.widgets.values()) {
    if (w.flavor === 'state' && w.superclass && stateOf(w.superclass) === name) out.add(w.symbolId);
  }
  return [...out];
}

function screenSubject(index: ProjectIndex, name: string, ids: string[]): SubjectInfo {
  const direct = ids.map((id) => index.symbolsById.get(id)).find((s) => s?.name === name);
  const sym = direct ?? index.symbolsById.get(ids[0] ?? '');
  const widget = sym ? index.widgets.get(sym.id) : undefined;
  const label = widget ? `${widget.flavor} screen` : (sym?.kind ?? 'screen');
  const info: SubjectInfo = { name, label };
  if (sym) info.decl = { file: sym.file, line: sym.range.startLine };
  return info;
}

/** `State<ProfileScreen>` → `ProfileScreen`. */
function stateOf(superclass: string): string | undefined {
  return /<\s*([A-Za-z_$][\w$]*)/.exec(superclass)?.[1];
}

/**
 * Routes that render the named screen, with the same paths get_route_graph
 * shows. Both read the resolved view, so a const path, a route mounted by a
 * `...Owner.routes()` spread, and an auto_route page class all reach the screen
 * here exactly as they do in the graph.
 */
function routesForScreen(index: ProjectIndex, name: string): RouteRef[] {
  const out: RouteRef[] = [];
  for (const view of resolveRoutes(index).byScreen.get(name) ?? []) {
    const ref: RouteRef = {
      label: view.path,
      loc: { file: view.route.file, line: view.route.line },
    };
    if (view.route.name) ref.name = view.route.name;
    out.push(ref);
  }
  return out;
}

// ── bloc ──────────────────────────────────────────────────────────────────

function wireBloc(index: ProjectIndex, name: string, base: Base, depth: number): WiringResult {
  const classSym = resolveClass(index, name);
  const info = classSym ? index.blocs.get(classSym.id) : undefined;
  if (!classSym || !info) {
    // A class by that name may exist but not be a Bloc/Cubit — surface it honestly.
    if (classSym) {
      const subject: SubjectInfo = {
        name,
        label: `${classSym.kind} (not a Bloc/Cubit)`,
        decl: { file: classSym.file, line: classSym.range.startLine },
      };
      return { ...base, found: false, subject };
    }
    return { ...base, found: false };
  }

  const subject: SubjectInfo = {
    name,
    label: info.flavor,
    decl: { file: classSym.file, line: classSym.range.startLine },
  };
  const incoming = index.edges.filter(
    (e) => e.to === name && (e.kind === 'createsBloc' || e.kind === 'readsBloc'),
  );
  const sources = groupSources(index, incoming);
  const repos = repoDepsOf(index, classSym.id, depth);
  return { ...base, found: true, subject, sources, repos };
}

// ── provider ────────────────────────────────────────────────────────────────

function wireProvider(index: ProjectIndex, name: string, base: Base): WiringResult {
  const info = index.providers.find((p) => p.name === name);
  if (!info) return { ...base, found: false };

  const subject: SubjectInfo = {
    name,
    label:
      info.declKind === 'generated' ? 'provider (@riverpod)' : (info.providerType ?? 'provider'),
    decl: { file: info.file, line: info.line },
  };
  const incoming = index.edges.filter((e) => e.to === name && e.kind === 'watchesProvider');
  const sources = groupSources(index, incoming);
  return { ...base, found: true, subject, sources };
}

// ── shared resolution ───────────────────────────────────────────────────────

interface RawEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  line: number;
  confidence: EdgeConfidence;
}

/** Groups a screen's outgoing edges by target name; attaches each bloc's repos. */
function groupTargets(index: ProjectIndex, edges: RawEdge[], depth: number): TargetGroup[] {
  const byTarget = new Map<string, TargetGroup>();
  for (const e of edges) {
    let group = byTarget.get(e.to);
    if (!group) {
      const target = resolveTarget(index, e.to, e.kind);
      const repos =
        target.symbolId && (target.kind === 'bloc' || target.kind === 'cubit')
          ? repoDepsOf(index, target.symbolId, depth)
          : [];
      group = { target, via: [], repos };
      byTarget.set(e.to, group);
    }
    group.via.push({ kind: e.kind, callSite: callSiteOf(e), confidence: e.confidence });
  }
  return [...byTarget.values()];
}

/** Groups incoming edges by their source class; flags `State<Screen>` companions. */
function groupSources(index: ProjectIndex, edges: RawEdge[]): SourceGroup[] {
  const byFrom = new Map<string, SourceGroup>();
  for (const e of edges) {
    let group = byFrom.get(e.from);
    if (!group) {
      const { className } = splitFrom(e.from);
      group = { name: className ?? '(file scope)', via: [] };
      const sym = className ? index.symbolsById.get(e.from) : undefined;
      if (sym) {
        group.decl = { file: sym.file, line: sym.range.startLine };
        group.symbolId = sym.id;
        const widget = index.widgets.get(sym.id);
        if (widget?.flavor === 'state' && widget.superclass) {
          const screen = stateOf(widget.superclass);
          if (screen) group.screen = screen;
        }
      }
      byFrom.set(e.from, group);
    }
    group.via.push({ kind: e.kind, callSite: callSiteOf(e), confidence: e.confidence });
  }
  return [...byFrom.values()];
}

/** Resolves an edge's bare `to` to a bloc, provider, other class, or nothing. */
function resolveTarget(index: ProjectIndex, name: string, kind: EdgeKind): ResolvedTarget {
  if (kind === 'watchesProvider') {
    const provider = resolveProvider(index, name);
    if (provider) return provider;
  }
  const classSym = resolveClass(index, name);
  if (classSym) {
    const bloc = index.blocs.get(classSym.id);
    return {
      name,
      kind: bloc ? bloc.flavor : 'class',
      symbolId: classSym.id,
      decl: { file: classSym.file, line: classSym.range.startLine },
    };
  }
  // A non-watch edge can still point at a provider (e.g. a misclassified read).
  const provider = resolveProvider(index, name);
  if (provider) return provider;
  return { name, kind: 'unknown' };
}

function resolveProvider(index: ProjectIndex, name: string): ResolvedTarget | undefined {
  const info = index.providers.find((p) => p.name === name);
  if (!info) return undefined;
  const target: ResolvedTarget = {
    name,
    kind: 'provider',
    decl: { file: info.file, line: info.line },
  };
  if (info.symbolId) target.symbolId = info.symbolId;
  else {
    // A global provider is a top-level field symbol: `${file}#${name}`.
    const fieldId = `${info.file}#${name}`;
    if (index.symbolsById.has(fieldId)) target.symbolId = fieldId;
  }
  return target;
}

/**
 * The dependency classes reachable from a bloc through its constructor params and
 * field declarations whose TYPE NAME resolves to a class in the index (§7.3 last
 * row — a syntactic edge). `maxDepth` bounds the walk: depth 1 is the bloc's own
 * dependencies, deeper levels follow each dependency's dependencies so a
 * clean-architecture chain bloc → usecase → repository → datasource resolves end
 * to end. A type that does not resolve to a container class (primitives, SDK
 * types, unindexed packages) is dropped.
 *
 * An interface dependency is followed into its concrete implementor, since the
 * datasource an interface declares lives on the implementing class, not the
 * interface. A per-class cycle guard stops mutually referencing classes looping.
 */
function repoDepsOf(index: ProjectIndex, blocSymbolId: string, maxDepth: number): RepoDep[] {
  const out: RepoDep[] = [];
  const seenClasses = new Set<string>([blocSymbolId]);
  // Built at most once per walk, and only if an interface dependency is reached:
  // resolving implementors by scanning every symbol per dependency is O(deps ×
  // symbols), which on a 70k-symbol repo dominates the whole query.
  let implementors: Map<string, Symbol[]> | undefined;

  const walk = (symbolId: string, depth: number): void => {
    if (depth > maxDepth) return;
    const sym = index.symbolsById.get(symbolId);
    if (!sym) return;
    const seenMembers = new Set<string>();

    const consider = (member: string, typeText: string, via: Loc): void => {
      if (seenMembers.has(member)) return;
      const typeName = baseTypeName(typeText);
      const cls = resolveClass(index, typeName, { fromFile: via.file });
      if (!cls || !CONTAINER_KINDS.has(cls.kind) || seenClasses.has(cls.id)) return;
      seenMembers.add(member);
      seenClasses.add(cls.id);

      let impl: Symbol | undefined;
      if (depth < maxDepth) {
        implementors ??= implementorsByInterface(index);
        impl = implementorOf(implementors, cls.name, cls.id, seenClasses);
      }
      const dep: RepoDep = {
        member,
        typeName,
        role: depRole(typeName),
        symbolId: cls.id,
        decl: { file: cls.file, line: cls.range.startLine },
        via,
        depth,
      };
      if (impl) {
        dep.impl = { typeName: impl.name, decl: { file: impl.file, line: impl.range.startLine } };
        seenClasses.add(impl.id);
      }
      out.push(dep);
      walk((impl ?? cls).id, depth + 1);
    };

    for (const child of sym.children) {
      if (child.kind === 'field' && child.returnType) {
        consider(child.name, child.returnType, { file: child.file, line: child.range.startLine });
      } else if (child.kind === 'constructor' && child.parameters) {
        for (const param of child.parameters) {
          if (param.type) {
            consider(param.name, param.type, { file: child.file, line: child.range.startLine });
          }
        }
      }
    }
  };

  walk(blocSymbolId, 1);
  return out;
}

/** Clean-architecture role read off the type-name suffix — syntactic, never a type
 * judgement (Working Rule 8); an unrecognised suffix stays a plain dependency. */
function depRole(typeName: string): DepRole {
  const n = typeName.toLowerCase();
  if (n.endsWith('usecase')) return 'usecase';
  if (n.endsWith('repository') || n.endsWith('repo')) return 'repo';
  if (n.endsWith('datasource') || n.endsWith('datastore')) return 'datasource';
  return 'dependency';
}

/**
 * Container classes grouped by each interface name they declare `implements`
 * for, ordered by symbol id so a pick among several is deterministic.
 *
 * Derived on demand rather than stored on the index, matching
 * `ProjectIndex.stringConsts()`: an aggregate kept across edits is an aggregate
 * that can disagree with the files it came from.
 */
function implementorsByInterface(index: ProjectIndex): Map<string, Symbol[]> {
  const out = new Map<string, Symbol[]>();
  for (const sym of index.symbolsById.values()) {
    if (!CONTAINER_KINDS.has(sym.kind) || !sym.implementsTypes) continue;
    for (const type of sym.implementsTypes) {
      const bucket = out.get(type.name);
      if (bucket) bucket.push(sym);
      else out.set(type.name, [sym]);
    }
  }
  for (const bucket of out.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * The concrete container class declaring `implements <name>` — the implementor
 * behind an interface. Picked deterministically (lowest symbol id) when several
 * implement it; an already-visited class is skipped so the cycle guard holds.
 */
function implementorOf(
  implementors: Map<string, Symbol[]>,
  name: string,
  interfaceId: string,
  seen: Set<string>,
): Symbol | undefined {
  for (const sym of implementors.get(name) ?? []) {
    if (sym.id === interfaceId || seen.has(sym.id)) continue;
    return sym;
  }
  return undefined;
}

/** `Future<List<int>>` → `Future`; `UserRepository?` → `UserRepository`. */
function baseTypeName(type: string): string {
  return /[A-Za-z_$][\w$]*/.exec(type)?.[0] ?? type.trim();
}

/** An edge's `from` is `${file}#${ClassName}` inside a class, or just `${file}`. */
function splitFrom(from: string): { file: string; className?: string } {
  const hash = from.indexOf('#');
  if (hash === -1) return { file: from };
  return { file: from.slice(0, hash), className: from.slice(hash + 1) };
}

function callSiteOf(edge: RawEdge): Loc {
  return { file: splitFrom(edge.from).file, line: edge.line };
}
