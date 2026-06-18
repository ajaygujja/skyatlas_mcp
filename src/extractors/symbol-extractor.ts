/**
 * Symbol extractor: classes, mixins, enums, extensions, functions, methods,
 * getters/setters, constructors, fields — names, kinds, ranges, parent/child
 * nesting, plus declaration detail (annotations, type params,
 * extends/implements/with, modifiers, return types, parameters, docs)
 * via declaration-detail.ts.
 *
 * Pure: CST in → data out, no I/O (TECHNICAL_DESIGN.md §9.1).
 *
 * All node type names below were observed empirically via scripts/dump-tree.ts
 * against tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working
 * Rule 2. Do not add a node name without dumping a snippet first.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { Symbol, SymbolKind } from '../model/symbol.js';
import {
  parseAnnotation,
  parseBodyModifier,
  parseDocFirstLine,
  parseLeadingType,
  parseModifiers,
  parseParameters,
  parseSuperTypes,
  parseTypeParameters,
} from './declaration-detail.js';

export interface ExtractionResult {
  /** Top-level symbols; nested declarations hang off `children`. */
  symbols: Symbol[];
  /** Human-readable notes for ERROR nodes — extraction continued past them. */
  parseErrors: string[];
}

/**
 * Doc comments and annotations preceding a declaration as SIBLINGS (observed:
 * always true for docs; true for annotations on methods/functions/fields,
 * while class-like declarations carry annotations as direct children instead).
 */
interface Pending {
  docs: Node[];
  annotations: Node[];
}

export function extractSymbols(tree: Tree, relPath: string): ExtractionResult {
  const symbols = extractScope(tree.rootNode, relPath, undefined);
  return { symbols, parseErrors: collectParseErrors(tree.rootNode) };
}

/**
 * Walks the named children of a scope node (`program`, `class_body`,
 * `extension_body`, `enum_body`) and extracts one Symbol per declaration.
 *
 * Observed CST: a function/method *signature* and its `function_body` are
 * SIBLINGS, not parent/child:
 *   (function_signature (identifier) (formal_parameter_list)) (function_body ...)
 * so the walk pairs each signature with a directly-following `function_body`
 * to compute the full range. Likewise `documentation_comment` and (for
 * non-class-like declarations) `annotation` precede their declaration as
 * siblings — accumulated in `pending` and attached to the next declaration.
 */
function extractScope(scope: Node, relPath: string, parent: Symbol | undefined): Symbol[] {
  const out: Symbol[] = [];
  const children = scope.namedChildren;
  let pending: Pending = { docs: [], annotations: [] };

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node === undefined) continue;
    if (node.type === 'documentation_comment') {
      pending.docs.push(node);
      continue;
    }
    if (node.type === 'annotation') {
      pending.annotations.push(node);
      continue;
    }

    const next = children[i + 1];
    const body = next?.type === 'function_body' ? next : undefined;

    const extracted = extractDeclaration(node, body, relPath, parent, pending);
    out.push(...extracted);
    if (body && extracted.length > 0) i++; // body consumed by the signature
    pending = { docs: [], annotations: [] };
  }
  return out;
}

function extractDeclaration(
  node: Node,
  followingBody: Node | undefined,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  switch (node.type) {
    // Observed: (class_definition (annotation)* (abstract)? (identifier)
    //   (type_parameters)? (superclass)? (interfaces)? (class_body))
    // A `mixin class` carries a `mixin` child token (NOT a parseModifiers
    // keyword) — report it as a mixin so callers don't treat it as a plain class.
    case 'class_definition': {
      const isMixinClass = node.namedChildren.some((c) => c.type === 'mixin');
      return containerSymbol(
        node,
        isMixinClass ? 'mixin' : 'class',
        'class_body',
        relPath,
        parent,
        pending,
      );
    }

    // Observed: (mixin_declaration (mixin) (identifier) (class_body))
    case 'mixin_declaration':
      return containerSymbol(node, 'mixin', 'class_body', relPath, parent, pending);

    // Observed: (enum_declaration (identifier) (mixins)? (interfaces)?
    //   (enum_body (enum_constant (identifier))*))
    case 'enum_declaration':
      return containerSymbol(node, 'enum', 'enum_body', relPath, parent, pending);

    // Observed: (extension_declaration (identifier) (type_identifier) (extension_body))
    case 'extension_declaration':
      return containerSymbol(node, 'extension', 'extension_body', relPath, parent, pending);

    // Observed: (extension_type_declaration (identifier) (representation_declaration) (class_body))
    case 'extension_type_declaration':
      return containerSymbol(node, 'extensionType', 'class_body', relPath, parent, pending);

    // Observed: (type_alias (type_identifier) ...) — first type_identifier is the alias name
    case 'type_alias': {
      const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
      if (!nameNode) return [];
      const sym = leafSymbol(node, nameNode, 'typedef', relPath, parent);
      applyPending(sym, pending);
      return [sym];
    }

    // Top-level function. Observed: (function_signature (type)? (identifier) (formal_parameter_list))
    case 'function_signature':
      return signatureSymbol(
        node,
        node,
        followingBody,
        parent ? 'method' : 'function',
        relPath,
        parent,
        pending,
      );

    // Observed wrapper for class members:
    // (method_signature (function_signature | getter_signature | setter_signature | factory_constructor_signature))
    case 'method_signature': {
      const inner = node.namedChildren[0];
      if (!inner) return [];
      return extractMemberSignature(node, inner, followingBody, relPath, parent, pending);
    }

    // Observed: class-body `declaration` wraps constructors, abstract method
    // signatures (no body), and fields:
    //   (declaration (constructor_signature ...) (initializers)?)
    //   (declaration (function_signature ...))            — abstract method
    //   (declaration (type_identifier)? (initialized_identifier_list ...))
    //   (declaration (const_builtin) (static_final_declaration_list ...))
    case 'declaration': {
      const inner = node.namedChildren.find((c) =>
        [
          'constructor_signature',
          'constant_constructor_signature',
          'function_signature',
          'getter_signature',
          'setter_signature',
          'initialized_identifier_list',
          'static_final_declaration_list',
        ].includes(c.type),
      );
      if (!inner) return [];
      if (
        inner.type === 'initialized_identifier_list' ||
        inner.type === 'static_final_declaration_list'
      ) {
        return fieldSymbols(node, inner, relPath, parent, pending);
      }
      return extractMemberSignature(node, inner, followingBody, relPath, parent, pending);
    }

    // Observed: (enum_constant (identifier))
    case 'enum_constant': {
      const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
      if (!nameNode) return [];
      const sym = leafSymbol(node, nameNode, 'field', relPath, parent);
      applyPending(sym, pending);
      return [sym];
    }

    // Top-level variables. Observed at program level as flat siblings:
    //   (final_builtin) (static_final_declaration_list (static_final_declaration (identifier) ...))
    //   (type_identifier) (initialized_identifier_list (initialized_identifier (identifier)))
    case 'static_final_declaration_list':
    case 'initialized_identifier_list':
      return fieldSymbols(node, node, relPath, parent, pending);

    default:
      return [];
  }
}

/** Class-like declaration whose members live in a body node; recurses into it. */
function containerSymbol(
  node: Node,
  kind: SymbolKind,
  bodyType: string,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return [];
  const sym = leafSymbol(node, nameNode, kind, relPath, parent);

  // Class-like declarations carry their annotations as direct children
  // (observed), unlike members where they precede as siblings.
  const ownAnnotations = node.namedChildren.filter((c) => c.type === 'annotation');
  sym.annotations = [...pending.annotations, ...ownAnnotations].map(parseAnnotation);
  sym.modifiers = parseModifiers(node);
  const doc = parseDocFirstLine(pending.docs);
  if (doc) sym.doc = doc;
  const typeParameters = parseTypeParameters(node);
  if (typeParameters) sym.typeParameters = typeParameters;
  const { extendsType, implementsTypes, mixesIn } = parseSuperTypes(node);
  if (extendsType) sym.extendsType = extendsType;
  if (implementsTypes) sym.implementsTypes = implementsTypes;
  if (mixesIn) sym.mixesIn = mixesIn;

  const bodyNode = node.namedChildren.find((c) => c.type === bodyType);
  if (bodyNode) sym.children = extractScope(bodyNode, relPath, sym);
  return [sym];
}

/** Dispatch on the inner signature node of a member declaration. */
function extractMemberSignature(
  outer: Node,
  inner: Node,
  followingBody: Node | undefined,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  switch (inner.type) {
    case 'function_signature':
      return signatureSymbol(
        outer,
        inner,
        followingBody,
        parent ? 'method' : 'function',
        relPath,
        parent,
        pending,
      );
    // Observed: (getter_signature (type)? (identifier)) — no formal_parameter_list
    case 'getter_signature':
      return signatureSymbol(outer, inner, followingBody, 'getter', relPath, parent, pending);
    case 'setter_signature':
      return signatureSymbol(outer, inner, followingBody, 'setter', relPath, parent, pending);
    // Observed: (operator_signature (type)? (binary_operator)? (formal_parameter_list))
    // The `operator` keyword and index tokens (`[]`, `[]=`) are ANONYMOUS — the
    // only named operator node is `binary_operator` (e.g. `<`), absent for `[]`.
    case 'operator_signature':
      return operatorSymbol(outer, inner, followingBody, relPath, parent, pending);
    // Observed: (constructor_signature (identifier) (identifier)? (formal_parameter_list))
    // Two identifiers = named constructor `Circle.unit`.
    // Observed: (constant_constructor_signature (const_builtin) (identifier) (formal_parameter_list))
    // Observed: (factory_constructor_signature (factory) (identifier) (identifier)? ...)
    case 'constructor_signature':
    case 'constant_constructor_signature':
    case 'factory_constructor_signature': {
      const ids = inner.namedChildren.filter((c) => c.type === 'identifier');
      const nameNode = ids[ids.length - 1] ?? ids[0];
      if (!nameNode) return [];
      const sym = leafSymbol(outer, nameNode, 'constructor', relPath, parent);
      if (followingBody) sym.range.endLine = followingBody.endPosition.row + 1;
      applyPending(sym, pending);
      sym.modifiers = parseModifiers(outer !== inner ? outer : undefined, inner);
      const parameters = parseParameters(inner);
      if (parameters) sym.parameters = parameters;
      return [sym];
    }
    default:
      return [];
  }
}

function signatureSymbol(
  outer: Node,
  signature: Node,
  followingBody: Node | undefined,
  kind: SymbolKind,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  const nameNode = signature.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return [];
  const sym = leafSymbol(outer, nameNode, kind, relPath, parent);
  if (followingBody) sym.range.endLine = followingBody.endPosition.row + 1;

  applyPending(sym, pending);
  sym.modifiers = parseModifiers(outer !== signature ? outer : undefined, signature);
  const bodyModifier = parseBodyModifier(followingBody);
  if (bodyModifier) sym.modifiers.push(bodyModifier);
  const typeParameters = parseTypeParameters(signature);
  if (typeParameters) sym.typeParameters = typeParameters;
  const returnType = parseLeadingType(signature, nameNode);
  if (returnType) sym.returnType = returnType;
  const parameters = parseParameters(signature);
  if (parameters) sym.parameters = parameters;
  return [sym];
}

/**
 * Operator overload (`bool operator <(...)`, `T operator [](int i)`) as a
 * `method` symbol named `operator <`, `operator []`, etc. The operator token is
 * anonymous in the CST, so the name is sliced from source text; the return type
 * is the leading type run before the `binary_operator` node (or the parameter
 * list when no such node exists, as for `[]`).
 */
function operatorSymbol(
  outer: Node,
  signature: Node,
  followingBody: Node | undefined,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  const match = /\boperator\b\s*([^\s(]+)/.exec(signature.text);
  if (!match?.[1]) return [];
  const name = `operator ${match[1]}`;

  // Anchor the symbol's range/nameRange on the operator token when present,
  // else on the signature node itself.
  const anchor = signature.namedChildren.find((c) => c.type === 'binary_operator') ?? signature;
  const sym = leafSymbol(outer, anchor, 'method', relPath, parent);
  sym.name = name;
  sym.qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
  sym.id = `${relPath}#${sym.qualifiedName}`;

  if (followingBody) sym.range.endLine = followingBody.endPosition.row + 1;
  applyPending(sym, pending);
  sym.modifiers = parseModifiers(outer !== signature ? outer : undefined, signature);
  const bodyModifier = parseBodyModifier(followingBody);
  if (bodyModifier) sym.modifiers.push(bodyModifier);
  const paramList = signature.namedChildren.find((c) => c.type === 'formal_parameter_list');
  const returnType = parseLeadingType(
    signature,
    anchor !== signature ? anchor : (paramList ?? signature),
  );
  if (returnType) sym.returnType = returnType;
  const parameters = parseParameters(signature);
  if (parameters) sym.parameters = parameters;
  return [sym];
}

/**
 * One Symbol per declarator. Observed:
 *   (initialized_identifier_list (initialized_identifier (identifier) <init expr>?)+)
 *   (static_final_declaration_list (static_final_declaration (identifier) <init expr>)+)
 * The declared type and modifiers live on the OUTER node (`declaration` or the
 * program-level sibling run) and are shared by every declarator in the list.
 */
function fieldSymbols(
  outer: Node,
  list: Node,
  relPath: string,
  parent: Symbol | undefined,
  pending: Pending,
): Symbol[] {
  const out: Symbol[] = [];
  const modifiers = parseModifiers(outer);
  // Field type is "returnType" in the model: verbatim leading type text (§5.1).
  const fieldType = outer !== list ? parseLeadingType(outer, list) : undefined;

  for (const declarator of list.namedChildren) {
    if (
      declarator.type !== 'initialized_identifier' &&
      declarator.type !== 'static_final_declaration'
    ) {
      continue;
    }
    const nameNode = declarator.namedChildren.find((c) => c.type === 'identifier');
    if (!nameNode) continue;
    const sym = leafSymbol(outer, nameNode, 'field', relPath, parent);
    applyPending(sym, pending);
    sym.modifiers = [...modifiers];
    if (fieldType) sym.returnType = fieldType;
    out.push(sym);
  }
  return out;
}

/** Attach sibling-style annotations and doc comment to a symbol. */
function applyPending(sym: Symbol, pending: Pending): void {
  if (pending.annotations.length > 0) {
    sym.annotations = pending.annotations.map(parseAnnotation);
  }
  const doc = parseDocFirstLine(pending.docs);
  if (doc) sym.doc = doc;
}

function leafSymbol(
  node: Node,
  nameNode: Node,
  kind: SymbolKind,
  relPath: string,
  parent: Symbol | undefined,
): Symbol {
  // Dart setter convention `name=` keeps getter/setter ids distinct (§5.1 id stability).
  const name = kind === 'setter' ? `${nameNode.text}=` : nameNode.text;
  const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
  const sym: Symbol = {
    id: `${relPath}#${qualifiedName}`,
    name,
    qualifiedName,
    kind,
    file: relPath,
    range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    nameRange: { line: nameNode.startPosition.row + 1, col: nameNode.startPosition.column + 1 },
    children: [],
    annotations: [],
    modifiers: [],
  };
  if (parent) sym.parentId = parent.id;
  return sym;
}

/** Error recovery is data, not exceptions (§9.4): note each ERROR node, keep going. */
function collectParseErrors(root: Node): string[] {
  if (!root.hasError) return [];
  return root
    .descendantsOfType('ERROR')
    .map(
      (n) =>
        `syntax error at ${String(n.startPosition.row + 1)}:${String(n.startPosition.column + 1)}`,
    );
}
