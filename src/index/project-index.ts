/**
 * ProjectIndex: in-memory symbol store with lookup maps (TECHNICAL_DESIGN.md
 * §5.3). Knows the Symbol model; knows nothing of MCP or tree-sitter (§4.1).
 *
 * Phase 3 adds the Flutter-domain maps (widgets, blocs, providers, routes,
 * edges) alongside these fields.
 */
import type { Symbol, SymbolKind } from '../model/symbol.js';
import type {
  BlocInfo,
  DynamicRouteNote,
  Edge,
  ProviderInfo,
  RouteInfo,
  WidgetInfo,
} from '../model/flutter.js';
import type { ImportEntry } from '../extractors/import-extractor.js';
import type { StringConsts } from '../extractors/string-const-extractor.js';
import type { PackageEntry } from './workspace.js';

export interface FileEntry {
  /** Workspace-relative path. */
  path: string;
  /** sha1 of file content — the disk-cache key. */
  contentHash: string;
  /** §7.4: *.g.dart / *.freezed.dart / *.gr.dart — excluded from default tool output. */
  generated: boolean;
  /** Owning package name (deepest pubspec.yaml above the file). */
  package?: string;
  /** Top-level symbols; nested declarations hang off children. */
  symbols: Symbol[];
  imports: ImportEntry[];
  /** Widget classes declared in this file (Phase 3a). */
  widgets: WidgetInfo[];
  /** Bloc/Cubit classes declared in this file (Phase 3b). */
  blocs: BlocInfo[];
  /** Riverpod providers declared in this file (Phase 3c). */
  providers: ProviderInfo[];
  /** Top-level routes declared in this file (Phase 3d); nesting hangs off children. */
  routes: RouteInfo[];
  /** Route tables in this file the syntax layer cannot enumerate (Phase 3d). */
  dynamicRoutes: DynamicRouteNote[];
  /** Partial state-management edges sourced from this file (Phase 3b bloc + 3c provider). */
  edges: Edge[];
  /** String constants declared in this file, for route path-const resolution. */
  stringConsts: StringConsts;
  parseErrors: string[];
}

export class ProjectIndex {
  readonly files = new Map<string, FileEntry>();
  readonly symbolsById = new Map<string, Symbol>();
  readonly byName = new Map<string, string[]>();
  readonly byKind = new Map<SymbolKind, string[]>();
  /** Widget classes by symbolId (Phase 3a). */
  readonly widgets = new Map<string, WidgetInfo>();
  /** Bloc/Cubit classes by symbolId (Phase 3b). */
  readonly blocs = new Map<string, BlocInfo>();
  /** Riverpod providers, aggregated across files (Phase 3c → 3e). */
  readonly providers: ProviderInfo[] = [];
  /** Route forest, aggregated across files — multiple routers possible (Phase 3d). */
  readonly routes: RouteInfo[] = [];
  /** Dynamic route tables across files, for honest get_route_graph reporting (Phase 3d). */
  readonly dynamicRoutes: DynamicRouteNote[] = [];
  /** Cross-cutting syntactic edges, aggregated across files (Phase 3b → 3e). */
  readonly edges: Edge[] = [];
  packages: PackageEntry[] = [];

  /** Drop everything. Used before a full re-scan reloads the same instance. */
  clear(): void {
    this.files.clear();
    this.symbolsById.clear();
    this.byName.clear();
    this.byKind.clear();
    this.widgets.clear();
    this.blocs.clear();
    this.providers.length = 0;
    this.routes.length = 0;
    this.dynamicRoutes.length = 0;
    this.edges.length = 0;
    this.packages = [];
  }

  /**
   * Replace this index's contents with another's, in place. The watcher's
   * mass-change path rebuilds a fresh index, then folds it into the live
   * instance the server already holds a reference to (§8 Phase 4) — re-running
   * setFile rederives every lookup map from the new file entries.
   */
  replaceWith(other: ProjectIndex): void {
    this.clear();
    this.packages = other.packages;
    for (const entry of other.files.values()) this.setFile(entry);
  }

  /** Insert or replace a file's entry, keeping all lookup maps consistent. */
  setFile(entry: FileEntry): void {
    this.removeFile(entry.path);
    this.files.set(entry.path, entry);
    for (const sym of walk(entry.symbols)) {
      this.symbolsById.set(sym.id, sym);
      push(this.byName, sym.name, sym.id);
      push(this.byKind, sym.kind, sym.id);
    }
    for (const widget of entry.widgets) {
      this.widgets.set(widget.symbolId, widget);
    }
    for (const bloc of entry.blocs) {
      this.blocs.set(bloc.symbolId, bloc);
    }
    this.providers.push(...entry.providers);
    this.routes.push(...entry.routes);
    this.dynamicRoutes.push(...entry.dynamicRoutes);
    this.edges.push(...entry.edges);
  }

  removeFile(path: string): void {
    const old = this.files.get(path);
    if (!old) return;
    this.files.delete(path);
    for (const sym of walk(old.symbols)) {
      this.symbolsById.delete(sym.id);
      pull(this.byName, sym.name, sym.id);
      pull(this.byKind, sym.kind, sym.id);
    }
    for (const widget of old.widgets) {
      this.widgets.delete(widget.symbolId);
    }
    for (const bloc of old.blocs) {
      this.blocs.delete(bloc.symbolId);
    }
    // Providers, routes & edges are owned by reference: drop the exact objects this file added.
    for (const provider of old.providers) {
      const i = this.providers.indexOf(provider);
      if (i !== -1) this.providers.splice(i, 1);
    }
    for (const route of old.routes) {
      const i = this.routes.indexOf(route);
      if (i !== -1) this.routes.splice(i, 1);
    }
    for (const note of old.dynamicRoutes) {
      const i = this.dynamicRoutes.indexOf(note);
      if (i !== -1) this.dynamicRoutes.splice(i, 1);
    }
    for (const edge of old.edges) {
      const i = this.edges.indexOf(edge);
      if (i !== -1) this.edges.splice(i, 1);
    }
  }

  /**
   * Name search for find_symbol: case-insensitive; exact-name hits rank
   * before prefix hits before substring hits, alphabetical within a tier.
   */
  findByName(
    query: string,
    opts: { kind?: SymbolKind; pkg?: string; includeGenerated?: boolean } = {},
  ): Symbol[] {
    const q = query.toLowerCase();
    const tiers: [Symbol[], Symbol[], Symbol[]] = [[], [], []];
    for (const [name, ids] of this.byName) {
      const lower = name.toLowerCase();
      const tier = lower === q ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1;
      if (tier === -1) continue;
      for (const id of ids) {
        const sym = this.symbolsById.get(id);
        if (!sym) continue;
        if (opts.kind && sym.kind !== opts.kind) continue;
        const file = this.files.get(sym.file);
        if (file?.generated && opts.includeGenerated !== true) continue;
        if (opts.pkg && file?.package !== opts.pkg) continue;
        tiers[tier].push(sym);
      }
    }
    for (const tier of tiers) tier.sort((a, b) => a.id.localeCompare(b.id));
    return tiers.flat();
  }

  /**
   * Workspace-wide string constants, for resolving route path consts in
   * get_route_graph. Recomputed on demand (called once per route-graph request)
   * — no incremental aggregation to keep consistent across edits. Qualified keys
   * (`RoutePaths.home`) are unique; bare keys keep the first value seen.
   */
  stringConsts(): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of this.files.values()) {
      for (const [key, value] of Object.entries(file.stringConsts)) {
        if (key.includes('.')) map.set(key, value);
        else if (!map.has(key)) map.set(key, value);
      }
    }
    return map;
  }

  /** All parse errors across the index, for the get_project_map health line. */
  parseErrorCount(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.parseErrors.length;
    return n;
  }
}

function* walk(symbols: Symbol[]): Generator<Symbol> {
  for (const s of symbols) {
    yield s;
    yield* walk(s.children);
  }
}

function push(map: Map<string, string[]>, key: string, id: string): void;
function push(map: Map<SymbolKind, string[]>, key: SymbolKind, id: string): void;
function push(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

function pull(map: Map<string, string[]>, key: string, id: string): void;
function pull(map: Map<SymbolKind, string[]>, key: SymbolKind, id: string): void;
function pull(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (!list) return;
  const next = list.filter((x) => x !== id);
  if (next.length > 0) map.set(key, next);
  else map.delete(key);
}
