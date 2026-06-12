/**
 * Flutter domain models, built on top of the core Symbol model
 * (TECHNICAL_DESIGN.md §5.2). Phase 3 fills these in one extractor at a time.
 *
 * 3a adds WidgetInfo / WidgetNode. Bloc/Provider/Route models join in 3b–3d.
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
