/**
 * Declaration-detail parsing (Phase 2): annotations, type parameters,
 * extends/implements/with clauses, modifiers, return types, parameters, docs.
 *
 * Pure: CST nodes in → data out, no I/O (TECHNICAL_DESIGN.md §9.1).
 * Honesty rule (§5.1): every type here is verbatim source text, never resolved.
 *
 * All node shapes observed empirically via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 * Critical observed facts:
 *   - `static` / `late` / `external` / `factory` / `required` / class-`final`
 *     are ANONYMOUS tokens — invisible in namedChildren; walk node.children.
 *   - `final_builtin` / `const_builtin` are named wrappers for field keywords.
 *   - `mixins` nests INSIDE `superclass` when `extends X with Y` (and when
 *     only `with Y` is present); enums carry `mixins` as a direct child.
 *   - In `interfaces`/`mixins`, a `type_arguments` node is a flat SIBLING of
 *     the `type_identifier` it belongs to — pair by adjacency.
 *   - In `optional_formal_parameters`, the `{`/`[` delimiter and per-param
 *     `required` keywords are anonymous siblings of the `formal_parameter`s.
 */
import type { Node } from 'web-tree-sitter';
import type { Annotation, Param, TypeRef } from '../model/symbol.js';

/** Keywords that may appear as modifier tokens on declarations. */
const MODIFIER_KEYWORDS = new Set([
  'abstract',
  'sealed',
  'base',
  'interface',
  'final',
  'static',
  'const',
  'late',
  'external',
  'covariant',
  'factory',
]);

/** Type-ish node types that can precede a name to form a return/field type. */
const TYPE_NODE_TYPES = new Set([
  'type_identifier',
  'type_arguments',
  'nullable_type',
  'void_type',
  'function_type',
  'record_type',
]);

/** Source text spanning two sibling nodes, sliced out of their parent's text. */
function spanText(parent: Node, first: Node, last: Node): string {
  return parent.text.slice(first.startIndex - parent.startIndex, last.endIndex - parent.startIndex);
}

/**
 * Observed: (annotation (identifier) (arguments)?). Name is everything
 * between `@` and the argument list (covers dotted names like `@material.x`).
 */
export function parseAnnotation(node: Node): Annotation {
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const name = args ? node.text.slice(1, args.startIndex - node.startIndex) : node.text.slice(1);
  const annotation: Annotation = { name: name.trim() };
  if (args) annotation.args = args.text.slice(1, -1); // strip outer parens
  return annotation;
}

/**
 * Modifier keywords appearing as direct children (named or anonymous) of the
 * given nodes. `final_builtin`/`const_builtin` are named wrappers; the rest
 * are bare tokens whose node type IS the keyword.
 */
export function parseModifiers(...nodes: (Node | undefined)[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!node) continue;
    for (const child of node.children) {
      if (child.type === 'final_builtin') out.push('final');
      else if (child.type === 'const_builtin') out.push('const');
      else if (MODIFIER_KEYWORDS.has(child.type)) out.push(child.type);
    }
  }
  return [...new Set(out)];
}

/** `async` / `async*` / `sync*` from the leading token of a function_body. */
export function parseBodyModifier(body: Node | undefined): string | undefined {
  const first = body?.children[0];
  return first && ['async', 'async*', 'sync*'].includes(first.type) ? first.type : undefined;
}

/** Own type parameters, verbatim: `<E, S extends Object>` → ["E", "S extends Object"]. */
export function parseTypeParameters(decl: Node): string[] | undefined {
  const tp = decl.namedChildren.find((c) => c.type === 'type_parameters');
  if (!tp) return undefined;
  const params = tp.namedChildren.filter((c) => c.type === 'type_parameter').map((c) => c.text);
  return params.length > 0 ? params : undefined;
}

/**
 * Type-argument texts of a `type_arguments` node. Observed: nested generics
 * are FLAT SIBLINGS too — `<DetailBloc<E, S>>` is (type_arguments
 * (type_identifier) (type_arguments)) — so a type_arguments child is merged
 * into the preceding argument's text rather than listed as its own argument.
 */
function typeArgTexts(typeArguments: Node): string[] {
  const out: string[] = [];
  for (const child of typeArguments.namedChildren) {
    if (child.type === 'type_arguments' && out.length > 0) {
      out[out.length - 1] = (out[out.length - 1] ?? '') + child.text;
    } else {
      out.push(child.text);
    }
  }
  return out;
}

/**
 * Pairs each `type_identifier` in a clause node with its adjacent
 * `type_arguments` sibling (observed flat layout in interfaces/mixins).
 */
function pairTypeRefs(clause: Node): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === 'type_identifier') {
      refs.push({ name: child.text, typeArgs: [] });
    } else if (child.type === 'type_arguments' && refs.length > 0) {
      const last = refs[refs.length - 1];
      if (last) last.typeArgs = typeArgTexts(child);
    }
  }
  return refs;
}

export interface SuperTypes {
  extendsType?: TypeRef;
  implementsTypes?: TypeRef[];
  mixesIn?: TypeRef[];
}

/**
 * Observed shapes:
 *   (class_definition ... (superclass (type_identifier) (type_arguments)? (mixins)?) (interfaces)?)
 *   (class_definition ... (superclass (mixins)))            — `class A with M {}`
 *   (enum_declaration (identifier) (mixins)? (interfaces)? (enum_body))
 */
export function parseSuperTypes(decl: Node): SuperTypes {
  const out: SuperTypes = {};
  const superclass = decl.namedChildren.find((c) => c.type === 'superclass');
  if (superclass) {
    const [extendsRef] = pairTypeRefs(superclass);
    if (extendsRef) out.extendsType = extendsRef;
    const nestedMixins = superclass.namedChildren.find((c) => c.type === 'mixins');
    if (nestedMixins) out.mixesIn = pairTypeRefs(nestedMixins);
  }
  const directMixins = decl.namedChildren.find((c) => c.type === 'mixins');
  if (directMixins) out.mixesIn = pairTypeRefs(directMixins);
  const interfaces = decl.namedChildren.find((c) => c.type === 'interfaces');
  if (interfaces) out.implementsTypes = pairTypeRefs(interfaces);
  return out;
}

/**
 * Verbatim type text preceding the name identifier in a signature or field
 * declaration: the contiguous run of type-ish named nodes before `stopAt`.
 * `Future<List<int>>` arrives as type_identifier + type_arguments siblings —
 * sliced as one source span, not concatenated nodes.
 */
export function parseLeadingType(container: Node, stopAt: Node): string | undefined {
  let first: Node | undefined;
  let last: Node | undefined;
  for (const child of container.namedChildren) {
    if (child.startIndex >= stopAt.startIndex) break;
    if (TYPE_NODE_TYPES.has(child.type)) {
      first ??= child;
      last = child;
    }
  }
  return first && last ? spanText(container, first, last) : undefined;
}

/**
 * Observed: (formal_parameter_list (formal_parameter)* (optional_formal_parameters)?)
 *   - direct formal_parameter children: required positional
 *   - optional_formal_parameters delimited by anonymous `{` (named) or `[`
 *     (optional positional); `required` is an anonymous sibling token directly
 *     before the formal_parameter it modifies; default values are siblings too
 *     (skipped — not part of the Param model).
 *   - constructor params: (formal_parameter (constructor_param (this) (identifier)))
 */
export function parseParameters(signature: Node): Param[] | undefined {
  const list = signature.namedChildren.find((c) => c.type === 'formal_parameter_list');
  if (!list) return undefined;
  const params: Param[] = [];

  for (const child of list.namedChildren) {
    if (child.type === 'formal_parameter') {
      const p = parseOneParam(child, false, true);
      if (p) params.push(p);
    } else if (child.type === 'optional_formal_parameters') {
      const isNamed = child.children[0]?.type === '{';
      let requiredNext = false;
      for (const opt of child.children) {
        if (opt.type === 'required') {
          requiredNext = true;
        } else if (opt.type === 'formal_parameter') {
          const p = parseOneParam(opt, isNamed, requiredNext);
          if (p) params.push(p);
          requiredNext = false;
        }
      }
    }
  }
  return params.length > 0 ? params : undefined;
}

function parseOneParam(node: Node, named: boolean, required: boolean): Param | undefined {
  // `this.x` / `super.x`: name is the identifier inside the wrapper; the field's
  // declared type lives elsewhere — honest absence over guessing (Working Rule 8).
  const ctorParam = node.namedChildren.find(
    (c) => c.type === 'constructor_param' || c.type === 'super_formal_parameter',
  );
  if (ctorParam) {
    const id = ctorParam.namedChildren.find((c) => c.type === 'identifier');
    if (!id) return undefined;
    return { name: id.text, named, required };
  }
  const ids = node.namedChildren.filter((c) => c.type === 'identifier');
  const nameNode = ids[ids.length - 1];
  if (!nameNode) return undefined;
  const param: Param = { name: nameNode.text, named, required };
  const type = parseLeadingType(node, nameNode);
  if (type) param.type = type;
  return param;
}

/** First line of a run of /// doc comments, stripped of the marker. */
export function parseDocFirstLine(docNodes: Node[]): string | undefined {
  const first = docNodes[0];
  if (!first) return undefined;
  const line = first.text.replace(/^\/\/\/\s?/, '').trim();
  return line.length > 0 ? line : undefined;
}
