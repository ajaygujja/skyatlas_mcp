/**
 * Reference extractor (AI_FIX_SPEC.md §9.1): every site in one file that names
 * something by identifier — type positions, constructions, annotations, static
 * accesses and call sites.
 *
 * Pure: CST in → data out, no I/O and no index (TECHNICAL_DESIGN.md §9.1). It
 * therefore records every name a file uses, including names declared nowhere in
 * the workspace (`Widget`, `String`): whether a name resolves is whole-workspace
 * knowledge, and filtering here on a guess would drop real references the index
 * could have resolved once every file was in.
 *
 * Honesty rule (§5.1, Working Rule 8): a site records the name as written and
 * the position it was written in. It never claims which declaration the name
 * binds to, and it never infers a construction from a shape the grammar did not
 * parse as a call.
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { FileReferences, ReferenceKind, ReferenceSite } from '../model/reference.js';

/**
 * Declarations whose members a reference is attributed to. Dart has no nested
 * class declarations, so one enclosing name is enough — there is no stack.
 */
const OWNER_NODES = new Set([
  'class_definition',
  'mixin_declaration',
  'enum_declaration',
  'extension_declaration',
  'extension_type_declaration',
]);

/**
 * Parents whose `identifier` child is the name being DECLARED rather than a name
 * being used. Without this exclusion every declaration would reference itself.
 *
 * `type_alias` belongs here even though its name is a `type_identifier`: a
 * typedef is the one declaration whose own name parses in a type position
 * (`typedef Handler = void Function()`), so the type branch checks it too.
 */
const DECLARED_NAME_PARENTS = new Set([
  'class_definition',
  'mixin_declaration',
  'enum_declaration',
  'extension_declaration',
  'extension_type_declaration',
  'function_signature',
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'getter_signature',
  'setter_signature',
  'initialized_identifier',
  'static_final_declaration',
  'formal_parameter',
  'constructor_param',
  'enum_constant',
  'type_parameter',
  'type_alias',
  'declared_identifier',
  'label',
]);

/**
 * Longest receiver text kept on a call site. A receiver exists to tell the reader
 * what the call was made on; a whole nested expression as the receiver says less
 * than the line it sits on already does, and costs far more to store.
 */
const MAX_RECEIVER_CHARS = 40;

export function extractReferences(tree: Tree): FileReferences {
  // Prototype-free: keys are Dart identifiers, and one named `constructor` or
  // `toString` would otherwise read back an inherited member instead of a list.
  const out: FileReferences = Object.create(null) as FileReferences;
  walk(tree.rootNode, undefined, out);
  return out;
}

/** Walks the tree tracking the enclosing declaration each site is attributed to. */
function walk(node: Node, owner: string | undefined, out: FileReferences): void {
  let scope = owner;
  if (OWNER_NODES.has(node.type)) {
    const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
    if (nameNode) scope = nameNode.text;
  }
  record(node, scope, out);
  for (const child of node.namedChildren) walk(child, scope, out);
}

function record(node: Node, owner: string | undefined, out: FileReferences): void {
  const parentType = node.parent?.type ?? '';

  // A type position always names a type, whatever its case.
  if (node.type === 'type_identifier') {
    if (parentType !== 'type_alias') push(out, node.text, site('typeRef', node, owner));
    return;
  }
  if (node.type !== 'identifier' || DECLARED_NAME_PARENTS.has(parentType)) return;

  if (isConstructorCased(node.text)) {
    push(out, node.text, site(typeUseKind(node, parentType), node, owner));
    return;
  }
  const callSite = lowercaseCall(node, parentType, owner);
  if (callSite) push(out, node.text, callSite);
}

/**
 * How a capitalized name is being used, read off the syntax that follows it.
 *
 * `Name(...)` and `Name.member` are distinguished because the first uses the
 * declaration itself and the second reaches a static member of it. Everything
 * else — a name passed as an argument (`as: FormRepository`), a type argument the
 * grammar mis-parsed as a comparison (§2, `BlocProvider<X>(…)`) — stays a plain
 * mention rather than being reported as a construction the parse did not show.
 */
function typeUseKind(node: Node, parentType: string): ReferenceKind {
  if (parentType === 'annotation') return 'annotation';
  const next = node.nextNamedSibling;
  if (next?.type !== 'selector') return 'nameRef';
  return next.namedChildren[0]?.type === 'argument_part' ? 'constructs' : 'staticAccess';
}

/**
 * A lowercase identifier being called, in the three shapes a call takes:
 *
 *   `name(...)`             — identifier, then a `selector` holding the arguments
 *   `receiver.name(...)`    — identifier inside an `unconditional_assignable_selector`,
 *                             the arguments in the following sibling `selector`
 *   `..name(...)`           — identifier inside a `cascade_selector`, the arguments
 *                             a sibling of that selector inside the cascade section
 *
 * A lowercase name that is not called is not recorded: local variables, parameters
 * and property reads share the shape of any other identifier read, so recording
 * them would bury the sites a caller asked for under the ones they did not.
 */
function lowercaseCall(
  node: Node,
  parentType: string,
  owner: string | undefined,
): ReferenceSite | undefined {
  if (parentType === 'unconditional_assignable_selector') {
    const selector = node.parent?.parent;
    if (!selector || !carriesArguments(selector.nextNamedSibling)) return undefined;
    // The receiver precedes the member selector in the postfix chain; for a
    // longer chain it is the previous selector, whose text is the call target
    // as written.
    return site('calls', node, owner, selector.previousNamedSibling?.text);
  }
  if (parentType === 'cascade_selector') {
    // `..name(args)`: the arguments sit beside the cascade selector, and the
    // receiver is the cascade target further up the chain — not at this site.
    const hasArgs = node.parent?.nextNamedSibling?.type === 'argument_part';
    return hasArgs ? site('calls', node, owner) : undefined;
  }
  return carriesArguments(node.nextNamedSibling) ? site('calls', node, owner) : undefined;
}

/** Whether a postfix `selector` is the one holding a call's argument list. */
function carriesArguments(selector: Node | null): boolean {
  return selector?.type === 'selector' && selector.namedChildren[0]?.type === 'argument_part';
}

function site(
  kind: ReferenceKind,
  node: Node,
  owner: string | undefined,
  receiver?: string,
): ReferenceSite {
  const out: ReferenceSite = { kind, line: node.startPosition.row + 1 };
  if (owner !== undefined) out.owner = owner;
  if (receiver !== undefined && receiver.length <= MAX_RECEIVER_CHARS && !receiver.includes('\n')) {
    out.receiver = receiver;
  }
  return out;
}

function push(out: FileReferences, name: string, entry: ReferenceSite): void {
  const sites = Object.hasOwn(out, name) ? out[name] : undefined;
  if (sites) sites.push(entry);
  else out[name] = [entry];
}

/** Dart convention: a type name is capitalized, private names keep their `_`. */
function isConstructorCased(name: string): boolean {
  const first = name.replace(/^_+/, '')[0];
  return first !== undefined && first >= 'A' && first <= 'Z';
}
