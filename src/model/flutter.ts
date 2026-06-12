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
  /** Present when a build() method was found and its returned tree parsed. */
  buildTree?: WidgetNode;
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
 * A cross-cutting, syntax-derived relationship (§5.2). Phase 3b emits only the
 * Bloc-related kinds — `createsBloc` (`BlocProvider(create:)`) and `readsBloc`
 * (`context.read/watch<X>()`, `BlocBuilder<X, _>`). `from` is the enclosing
 * class's symbolId (or the file path when at top level); `to` is a bare name —
 * resolution to a symbolId happens in 3e.
 */
export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 1-based line of the call site. */
  line: number;
  confidence: EdgeConfidence;
}
