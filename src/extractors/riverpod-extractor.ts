/**
 * Riverpod extractor (TECHNICAL_DESIGN.md Phase 3c): detects provider
 * declarations — global (`final xProvider = Provider<T>(…)`) and generated
 * (`@riverpod` function/class) — classifies the global form's constructor by
 * name, and emits the partial `watchesProvider` `Edge`s (`ref.watch/read/listen`)
 * that 3e assembles into the wiring graph.
 *
 * Pure: CST in → data out, no I/O (§9.1).
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 *
 * GRAMMAR NOTE (§2): the same generic-at-value-position mis-parse that bites the
 * widget/bloc extractors bites single-type-arg providers. `StateProvider<int>(…)`
 * mis-parses — `<`/`>` read as comparison — into a nested `relational_expression`;
 * `FutureProvider.autoDispose<User>(…)` likewise. But ≥2-type-arg constructors
 * (`NotifierProvider<N, S>(…)`) and `.family`/chained forms parse CLEANLY as
 * `identifier + selector(argument_part(type_arguments, arguments))`. Both shapes
 * are handled below; in both the constructor name is the leading identifier.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { Edge, ProviderInfo } from '../model/flutter.js';

export interface ProviderExtraction {
  providers: ProviderInfo[];
  edges: Edge[];
}

/** `ref.<m>(provider)` selector methods that establish a provider dependency. */
const REF_METHODS = new Set(['watch', 'read', 'listen']);

export function extractProviders(tree: Tree, relPath: string): ProviderExtraction {
  const providers: ProviderInfo[] = [];

  // Global form: a top-level `final xProvider = SomethingProvider(...)`.
  for (const decl of tree.rootNode.descendantsOfType('static_final_declaration')) {
    const p = globalProviderFor(decl, relPath);
    if (p) providers.push(p);
  }
  // Generated form: `@riverpod` on a function or class.
  for (const ann of tree.rootNode.descendantsOfType('annotation')) {
    const p = generatedProviderFor(ann, relPath);
    if (p) providers.push(p);
  }

  const edges: Edge[] = [];
  collectEdges(tree.rootNode, undefined, relPath, edges);
  return { providers, edges };
}

/** Riverpod provider constructors all end in `Provider` (suffix rule, like 3a/3b). */
function isProviderName(s: string): boolean {
  return s.endsWith('Provider');
}

/**
 * `final xProvider = <ctor>(...)` → ProviderInfo, or undefined when the
 * initializer is not a provider constructor. Observed shapes:
 *   clean (≥2 type args / .family):
 *     (static_final_declaration (identifier 'x') (identifier 'NotifierProvider')
 *       (selector (argument_part (type_arguments …) (arguments …))))
 *   mis-parse (single type arg):
 *     (static_final_declaration (identifier 'x')
 *       (relational_expression (relational_expression (identifier 'StateProvider')
 *         (relational_operator '<') (identifier 'int')) (relational_operator '>')
 *         (parenthesized_expression …)))
 */
function globalProviderFor(decl: Node, relPath: string): ProviderInfo | undefined {
  const kids = decl.namedChildren;
  const nameNode = kids[0];
  if (nameNode?.type !== 'identifier') return undefined;

  const ctor = providerCtor(kids);
  if (!ctor) return undefined;

  const info: ProviderInfo = {
    name: nameNode.text,
    declKind: 'global',
    providerType: ctor.name,
    file: relPath,
    line: decl.startPosition.row + 1,
  };
  if (ctor.typeArgs.length > 0) info.typeArgs = ctor.typeArgs;
  return info;
}

/** Reads the constructor name + type args from a declaration's named children. */
function providerCtor(kids: Node[]): { name: string; typeArgs: string[] } | undefined {
  const head = kids[1];
  if (!head) return undefined;

  // Clean form: the constructor is the second identifier; type args (if any)
  // live in a sibling selector's argument_part.
  if (head.type === 'identifier') {
    if (!isProviderName(head.text)) return undefined;
    return { name: head.text, typeArgs: typeArgsInSelectors(kids) };
  }
  // Mis-parse form: the constructor + single type arg hide in a relational_expression.
  if (head.type === 'relational_expression') return ctorFromRelational(head);
  return undefined;
}

/** Clean form: first `selector > argument_part > type_arguments` wins. */
function typeArgsInSelectors(kids: Node[]): string[] {
  for (const k of kids) {
    if (k.type !== 'selector') continue;
    const ap = k.namedChildren.find((c) => c.type === 'argument_part');
    const ta = ap?.namedChildren.find((c) => c.type === 'type_arguments');
    if (ta) return typeArgTexts(ta);
  }
  return [];
}

/**
 * Mis-parse: the constructor name is the leading identifier of the (possibly
 * nested) relational_expression; the single type arg is the identifier after `<`.
 * Handles the `.autoDispose`/`.family` chain (an interleaved selector) too.
 */
function ctorFromRelational(rel: Node): { name: string; typeArgs: string[] } | undefined {
  const inner = rel.namedChildren[0];
  const head = inner?.type === 'relational_expression' ? inner : rel;
  const kids = head.namedChildren;
  const ctorId = kids.find((c) => c.type === 'identifier');
  if (!ctorId || !isProviderName(ctorId.text)) return undefined;

  const typeArgs: string[] = [];
  const lt = kids.findIndex((c) => c.type === 'relational_operator' && c.text === '<');
  if (lt !== -1) {
    for (let i = lt + 1; i < kids.length; i++) {
      const k = kids[i];
      if (k && (k.type === 'identifier' || k.type === 'type_identifier')) typeArgs.push(k.text);
    }
  }
  return { name: ctorId.text, typeArgs };
}

/**
 * `@riverpod` on a function or class. Observed:
 *   function: (annotation (identifier 'riverpod')) is a sibling whose next named
 *     sibling is (function_signature … (identifier 'count')).
 *   class:    (class_definition (annotation (identifier 'riverpod')) (identifier 'UserCtrl') …)
 *     — the annotation is a child, so its parent carries the name.
 * Matches `@riverpod` and `@Riverpod(keepAlive: true)` (name compared lowercased).
 */
function generatedProviderFor(ann: Node, relPath: string): ProviderInfo | undefined {
  const annName = ann.namedChildren.find((c) => c.type === 'identifier')?.text;
  if (annName?.toLowerCase() !== 'riverpod') return undefined;

  const parent = ann.parent;
  if (parent?.type === 'class_definition') {
    const className = parent.namedChildren.find((c) => c.type === 'identifier')?.text;
    if (!className) return undefined;
    return {
      symbolId: `${relPath}#${className}`,
      name: className,
      declKind: 'generated',
      file: relPath,
      line: parent.startPosition.row + 1,
    };
  }
  // Function form: the signature is the annotation's next named sibling.
  const sig = ann.nextNamedSibling;
  if (sig?.type !== 'function_signature') return undefined;
  const fnName = sig.namedChildren.find((c) => c.type === 'identifier')?.text;
  if (!fnName) return undefined;
  return {
    symbolId: `${relPath}#${fnName}`,
    name: fnName,
    declKind: 'generated',
    file: relPath,
    line: ann.startPosition.row + 1,
  };
}

/**
 * Walks the tree tracking the enclosing class symbolId so each edge's `from`
 * is the class containing the call site (or the file path at top level).
 * Mirrors bloc-extractor.ts's collectEdges.
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
  if (node.type === 'selector') {
    const provider = refWatchTarget(node);
    if (provider) {
      out.push({
        from: scope ?? relPath,
        to: provider,
        kind: 'watchesProvider',
        line: node.startPosition.row + 1,
        confidence: 'syntactic',
      });
    }
  }
  for (const child of node.namedChildren) collectEdges(child, scope, relPath, out);
}

/**
 * `ref.watch/read/listen(xProvider)` → the provider name. Observed as sibling
 * selectors with `ref` as the receiver:
 *   (identifier 'ref') (selector (unconditional_assignable_selector (identifier 'watch')))
 *   (selector (argument_part (arguments (argument (identifier 'counterProvider')))))
 * Gated on receiver `ref` (the Riverpod idiom) so it never collides with the
 * bloc extractor's `context.read<X>()` — that one carries a type arg, this one a
 * positional provider arg. `.notifier`/`.select(...)` suffixes still resolve the
 * base provider (the argument's leading identifier).
 */
function refWatchTarget(methodSel: Node): string | undefined {
  const inner = methodSel.namedChildren[0];
  if (inner?.type !== 'unconditional_assignable_selector') return undefined;
  const method = inner.namedChildren.find((c) => c.type === 'identifier');
  if (!method || !REF_METHODS.has(method.text)) return undefined;

  const recv = methodSel.previousNamedSibling;
  if (recv?.type !== 'identifier' || recv.text !== 'ref') return undefined;

  const callSel = methodSel.nextNamedSibling;
  if (callSel?.type !== 'selector') return undefined;
  const ap = callSel.namedChildren.find((c) => c.type === 'argument_part');
  const args = ap?.namedChildren.find((c) => c.type === 'arguments');
  const firstArg = args?.namedChildren.find((c) => c.type === 'argument');
  const lead = firstArg?.namedChildren[0];
  return lead?.type === 'identifier' ? lead.text : undefined;
}

/** `(type_arguments (type_identifier|identifier)+)` → verbatim arg texts. */
function typeArgTexts(typeArguments: Node): string[] {
  return typeArguments.namedChildren
    .filter((c) => c.type === 'type_identifier' || c.type === 'identifier')
    .map((c) => c.text);
}
