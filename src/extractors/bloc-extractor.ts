/**
 * Bloc/Cubit extractor (TECHNICAL_DESIGN.md Phase 3b): detects classes
 * extending a `*Bloc`/`*Cubit` base, pulls their event/state type args,
 * `on<Event>(handler)` registrations and `emit(...)` sites, and emits the
 * partial state-management `Edge`s that 3e assembles into the wiring graph.
 *
 * Pure: CST in → data out, no I/O (§9.1).
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 *
 * GRAMMAR NOTE (§2): method-call sites parse cleanly — `on<Event>(...)` and
 * `context.read<X>()` give `argument_part > (type_arguments, arguments)`. But a
 * generic CONSTRUCTOR with ≥2 type args at value position — `BlocBuilder<A, B>(…)`
 * — mis-parses: `<`/`>` read as comparison operators yield a
 * `relational_expression`. We recover the bloc type (first type arg) from that
 * node, same family of recovery as widget-extractor.ts.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { BlocFlavor, BlocInfo, Edge } from '../model/flutter.js';

export interface BlocExtraction {
  blocs: BlocInfo[];
  edges: Edge[];
}

/** Bloc-widget constructors that read a bloc and all mis-parse (≥2 type args). */
const BLOC_WIDGET_FAMILY = new Set(['BlocBuilder', 'BlocListener', 'BlocConsumer', 'BlocSelector']);

/** `context.read/watch<X>()` — the selector methods 3b treats as a bloc read. */
const READ_SELECTORS = new Set(['read', 'watch']);

export function extractBlocs(tree: Tree, relPath: string): BlocExtraction {
  const blocs: BlocInfo[] = [];
  // Dart has no nested class declarations; all class_definitions are top-level.
  for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
    const info = blocInfoFor(cls, relPath);
    if (info) blocs.push(info);
  }
  const edges: Edge[] = [];
  collectEdges(tree.rootNode, undefined, relPath, edges);
  return { blocs, edges };
}

function blocInfoFor(cls: Node, relPath: string): BlocInfo | undefined {
  const nameNode = cls.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return undefined;

  // Observed: (superclass (type_identifier) (type_arguments)?)
  const superclass = cls.namedChildren.find((c) => c.type === 'superclass');
  if (!superclass) return undefined;
  const superId = superclass.namedChildren.find((c) => c.type === 'type_identifier');
  if (!superId) return undefined;

  const flavor = flavorFor(superId.text);
  if (!flavor) return undefined;

  const typeArgs = parseTypeArgs(superclass) ?? [];
  const name = nameNode.text;
  const info: BlocInfo = {
    symbolId: `${relPath}#${name}`,
    name,
    flavor,
    file: relPath,
    line: cls.startPosition.row + 1,
    handlers: [],
    emitSites: [],
  };
  // Bloc<Event, State> → event + state; Cubit<State> → state only.
  if (flavor === 'bloc') {
    if (typeArgs[0]) info.eventType = typeArgs[0];
    if (typeArgs[1]) info.stateType = typeArgs[1];
  } else if (typeArgs[0]) {
    info.stateType = typeArgs[0];
  }

  const body = cls.namedChildren.find((c) => c.type === 'class_body');
  if (body) {
    info.handlers = handlersIn(body);
    info.emitSites = emitSitesIn(body);
  }
  return info;
}

/** Suffix rule: `*Cubit` → cubit, `*Bloc` → bloc. Cubit wins (HydratedCubit). */
function flavorFor(superName: string): BlocFlavor | undefined {
  if (superName.endsWith('Cubit')) return 'cubit';
  if (superName.endsWith('Bloc')) return 'bloc';
  return undefined;
}

/**
 * `on<Event>(handler)` registrations. Observed clean parse:
 *   (identifier 'on') (selector (argument_part
 *     (type_arguments (type_identifier 'Event'))
 *     (arguments (argument (identifier '_onLoad' | function_expression)))))
 * `methodName` is the handler when it's a tear-off reference; absent for an
 * inline closure.
 */
function handlersIn(classBody: Node): BlocInfo['handlers'] {
  const out: BlocInfo['handlers'] = [];
  for (const id of classBody.descendantsOfType('identifier')) {
    if (id.text !== 'on') continue;
    const ap = argumentPartAfter(id);
    if (!ap) continue;
    const eventType = firstTypeArg(ap);
    if (!eventType) continue; // a bare `on(...)` is not an on<Event> registration
    const handler: { eventType: string; methodName?: string; line: number } = {
      eventType,
      line: id.startPosition.row + 1,
    };
    const methodName = handlerMethodName(ap);
    if (methodName) handler.methodName = methodName;
    out.push(handler);
  }
  return out;
}

/** First positional arg of `on<E>(...)` when it is a method tear-off identifier. */
function handlerMethodName(argumentPart: Node): string | undefined {
  const args = argumentPart.namedChildren.find((c) => c.type === 'arguments');
  const firstArg = args?.namedChildren.find((c) => c.type === 'argument');
  const inner = firstArg?.namedChildren[0];
  return inner?.type === 'identifier' ? inner.text : undefined;
}

/**
 * `emit(...)` call sites. Observed: (identifier 'emit') (selector (argument_part
 * (arguments ...))). Lines only — source order via document-order descendants.
 */
function emitSitesIn(classBody: Node): number[] {
  const out: number[] = [];
  for (const id of classBody.descendantsOfType('identifier')) {
    if (id.text !== 'emit') continue;
    if (!argumentPartAfter(id)) continue;
    out.push(id.startPosition.row + 1);
  }
  return out;
}

/**
 * Walks the tree tracking the enclosing class symbolId so each edge's `from`
 * is the class that contains the call site (or the file path at top level).
 */
function collectEdges(
  node: Node,
  enclosing: string | undefined,
  relPath: string,
  out: Edge[],
): void {
  let scope = enclosing;
  if (node.type === 'class_definition') {
    const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
    if (nameNode) scope = `${relPath}#${nameNode.text}`;
  }
  edgeAt(node, scope ?? relPath, out);
  for (const child of node.namedChildren) collectEdges(child, scope, relPath, out);
}

function edgeAt(node: Node, from: string, out: Edge[]): void {
  if (node.type === 'identifier') {
    if (node.text === 'BlocProvider') {
      const created = blocProviderCreates(node);
      if (created) {
        out.push({
          from,
          to: created,
          kind: 'createsBloc',
          line: line(node),
          confidence: 'syntactic',
        });
      }
    } else if (BLOC_WIDGET_FAMILY.has(node.text)) {
      // Clean parse: `BlocBuilder<X, Y>(…)` as identifier + argument_part. The
      // same constructor mis-parses in some value positions (see below).
      const ap = argumentPartAfter(node);
      const bloc = ap ? firstTypeArg(ap) : undefined;
      if (bloc) {
        out.push({ from, to: bloc, kind: 'readsBloc', line: line(node), confidence: 'syntactic' });
      }
    }
    return;
  }
  if (node.type === 'selector') {
    const bloc = readWatchTarget(node);
    if (bloc) {
      out.push({ from, to: bloc, kind: 'readsBloc', line: line(node), confidence: 'syntactic' });
    }
    return;
  }
  if (node.type === 'relational_expression') {
    const bloc = blocWidgetTarget(node);
    if (bloc) {
      out.push({ from, to: bloc, kind: 'readsBloc', line: line(node), confidence: 'syntactic' });
    }
  }
}

/**
 * `BlocProvider(create: (_) => XBloc(...))` → the constructed bloc name. Observed:
 *   (identifier 'BlocProvider') (selector (argument_part (arguments
 *     (named_argument (label (identifier 'create')) (function_expression …)))))
 * Returns the first constructor-cased name in the closure BODY — covering both a
 * direct `XBloc(...)` (an `identifier`) and a service-locator handoff
 * `sl<XCubit>()` / `getIt<XCubit>()` (a `type_identifier` inside `type_arguments`).
 * The body, not the whole value, is scanned: a typed closure param
 * (`(BuildContext c) => …`) carries a PascalCase `type_identifier` that is NOT
 * the bloc, and it precedes the body in document order.
 */
function blocProviderCreates(idNode: Node): string | undefined {
  const ap = argumentPartAfter(idNode);
  const args = ap?.namedChildren.find((c) => c.type === 'arguments');
  if (!args) return undefined;
  for (const arg of args.namedChildren) {
    if (arg.type !== 'named_argument' || labelOf(arg) !== 'create') continue;
    const value = arg.namedChildren.find((c) => c.type !== 'label');
    if (!value) return undefined;
    const scope =
      value.type === 'function_expression'
        ? (value.namedChildren.find((c) => c.type === 'function_expression_body') ?? value)
        : value;
    return firstConstructorCasedName(scope);
  }
  return undefined;
}

/**
 * First `identifier`/`type_identifier` with a constructor-cased name in document
 * order under `node`. `type_identifier` is included so `sl<XCubit>()` resolves —
 * the cubit lives in `type_arguments`, not as a plain `identifier`.
 */
function firstConstructorCasedName(node: Node): string | undefined {
  if (
    (node.type === 'identifier' || node.type === 'type_identifier') &&
    isConstructorName(node.text)
  ) {
    return node.text;
  }
  for (const child of node.namedChildren) {
    const found = firstConstructorCasedName(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * `<receiver>.read<X>()` / `.watch<X>()` → X. Observed as two sibling selectors:
 *   (selector (unconditional_assignable_selector (identifier 'read')))
 *   (selector (argument_part (type_arguments (type_identifier 'X')) (arguments)))
 * Detected on the method selector; the type arg lives on its next sibling.
 */
function readWatchTarget(selector: Node): string | undefined {
  const inner = selector.namedChildren[0];
  if (inner?.type !== 'unconditional_assignable_selector') return undefined;
  const method = inner.namedChildren.find((c) => c.type === 'identifier');
  if (!method || !READ_SELECTORS.has(method.text)) return undefined;
  const next = selector.nextNamedSibling;
  if (next?.type !== 'selector') return undefined;
  const ap = next.namedChildren.find((c) => c.type === 'argument_part');
  return ap ? firstTypeArg(ap) : undefined;
}

/**
 * Recovers the bloc from a mis-parsed `BlocBuilder<X, Y>(…)` (§2). The family
 * parses cleanly as an identifier + argument_part when it owns the whole arg
 * list (handled in edgeAt), but mis-parses when it sits in a named-arg value
 * following a sibling arg. Observed mis-parse:
 *   (relational_expression (identifier 'BlocBuilder') (relational_operator '<')
 *     (identifier 'X'))
 * The bloc is the first type arg — the identifier directly after `<`.
 */
function blocWidgetTarget(rel: Node): string | undefined {
  const kids = rel.namedChildren;
  const head = kids[0];
  if (head?.type !== 'identifier' || !BLOC_WIDGET_FAMILY.has(head.text)) return undefined;
  const ltIndex = kids.findIndex((c) => c.type === 'relational_operator' && c.text === '<');
  if (ltIndex === -1) return undefined;
  for (let i = ltIndex + 1; i < kids.length; i++) {
    const k = kids[i];
    if (k && (k.type === 'identifier' || k.type === 'type_identifier')) return k.text;
  }
  return undefined;
}

/** The `argument_part` of a call whose callee is `idNode` (its next sibling selector). */
function argumentPartAfter(idNode: Node): Node | undefined {
  const sel = idNode.nextNamedSibling;
  if (sel?.type !== 'selector') return undefined;
  const ap = sel.namedChildren[0];
  return ap?.type === 'argument_part' ? ap : undefined;
}

/** `(argument_part (type_arguments (type_identifier 'X') …))` → "X". */
function firstTypeArg(argumentPart: Node): string | undefined {
  const ta = argumentPart.namedChildren.find((c) => c.type === 'type_arguments');
  const first = ta?.namedChildren.find(
    (c) => c.type === 'type_identifier' || c.type === 'identifier',
  );
  return first?.text;
}

/** `(type_arguments (type_identifier|…)+)` on a superclass → verbatim arg texts. */
function parseTypeArgs(parent: Node): string[] | undefined {
  const ta = parent.namedChildren.find((c) => c.type === 'type_arguments');
  if (!ta) return undefined;
  const args = ta.namedChildren.map((c) => c.text);
  return args.length > 0 ? args : undefined;
}

/** `(label (identifier))` → the identifier text. */
function labelOf(namedArg: Node): string | undefined {
  const label = namedArg.namedChildren.find((c) => c.type === 'label');
  return label?.namedChildren.find((c) => c.type === 'identifier')?.text;
}

function isConstructorName(s: string): boolean {
  const core = s.replace(/^_+/, '');
  const c = core[0];
  return c !== undefined && c >= 'A' && c <= 'Z';
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}
