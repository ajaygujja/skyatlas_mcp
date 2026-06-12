/**
 * First extractor (Phase 1): classes, mixins, enums, extensions, functions,
 * methods, getters/setters, constructors, fields — names, kinds, ranges,
 * parent/child nesting. Declaration detail (annotations, type params,
 * extends/implements) is Phase 2.
 *
 * Pure: CST in → data out, no I/O (TECHNICAL_DESIGN.md §9.1).
 *
 * All node type names below were observed empirically via scripts/dump-tree.ts
 * against tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working
 * Rule 2. Do not add a node name without dumping a snippet first.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { Symbol, SymbolKind } from '../model/symbol.js';

export interface ExtractionResult {
  /** Top-level symbols; nested declarations hang off `children`. */
  symbols: Symbol[];
  /** Human-readable notes for ERROR nodes — extraction continued past them. */
  parseErrors: string[];
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
 * to compute the full range.
 */
function extractScope(scope: Node, relPath: string, parent: Symbol | undefined): Symbol[] {
  const out: Symbol[] = [];
  const children = scope.namedChildren;

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node === undefined) continue;
    const next = children[i + 1];
    const body = next?.type === 'function_body' ? next : undefined;

    const extracted = extractDeclaration(node, body, relPath, parent);
    out.push(...extracted);
    if (body && extracted.length > 0) i++; // body consumed by the signature
  }
  return out;
}

function extractDeclaration(
  node: Node,
  followingBody: Node | undefined,
  relPath: string,
  parent: Symbol | undefined,
): Symbol[] {
  switch (node.type) {
    // Observed: (class_definition (identifier) (type_parameters)? (superclass)? (interfaces)? (class_body))
    case 'class_definition':
      return containerSymbol(node, 'class', 'class_body', relPath, parent);

    // Observed: (mixin_declaration (mixin) (identifier) (class_body))
    case 'mixin_declaration':
      return containerSymbol(node, 'mixin', 'class_body', relPath, parent);

    // Observed: (enum_declaration (identifier) (enum_body (enum_constant (identifier))*))
    case 'enum_declaration':
      return containerSymbol(node, 'enum', 'enum_body', relPath, parent);

    // Observed: (extension_declaration (identifier) (type_identifier) (extension_body))
    case 'extension_declaration':
      return containerSymbol(node, 'extension', 'extension_body', relPath, parent);

    // Observed: (extension_type_declaration (identifier) (representation_declaration) (class_body))
    case 'extension_type_declaration':
      return containerSymbol(node, 'extensionType', 'class_body', relPath, parent);

    // Observed: (type_alias (type_identifier) ...) — first type_identifier is the alias name
    case 'type_alias': {
      const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
      if (!nameNode) return [];
      return [leafSymbol(node, nameNode, 'typedef', relPath, parent)];
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
      );

    // Observed wrapper for class members:
    // (method_signature (function_signature | getter_signature | setter_signature | factory_constructor_signature))
    case 'method_signature': {
      const inner = node.namedChildren[0];
      if (!inner) return [];
      return extractMemberSignature(node, inner, followingBody, relPath, parent);
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
        return fieldSymbols(node, inner, relPath, parent);
      }
      return extractMemberSignature(node, inner, followingBody, relPath, parent);
    }

    // Observed: (enum_constant (identifier))
    case 'enum_constant': {
      const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
      if (!nameNode) return [];
      return [leafSymbol(node, nameNode, 'field', relPath, parent)];
    }

    // Top-level variables. Observed at program level as flat siblings:
    //   (final_builtin) (static_final_declaration_list (static_final_declaration (identifier) ...))
    //   (type_identifier) (initialized_identifier_list (initialized_identifier (identifier)))
    case 'static_final_declaration_list':
    case 'initialized_identifier_list':
      return fieldSymbols(node, node, relPath, parent);

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
): Symbol[] {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return [];
  const sym = leafSymbol(node, nameNode, kind, relPath, parent);
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
      );
    // Observed: (getter_signature (type)? (identifier)) — no formal_parameter_list
    case 'getter_signature':
      return signatureSymbol(outer, inner, followingBody, 'getter', relPath, parent);
    case 'setter_signature':
      return signatureSymbol(outer, inner, followingBody, 'setter', relPath, parent);
    // Observed: (constructor_signature (identifier) (identifier)? (formal_parameter_list))
    // Two identifiers = named constructor `Circle.unit`.
    // Observed: (constant_constructor_signature (const_builtin) (identifier) (formal_parameter_list))
    case 'constructor_signature':
    case 'constant_constructor_signature':
    case 'factory_constructor_signature': {
      const ids = inner.namedChildren.filter((c) => c.type === 'identifier');
      const nameNode = ids[ids.length - 1] ?? ids[0];
      if (!nameNode) return [];
      const sym = leafSymbol(outer, nameNode, 'constructor', relPath, parent);
      if (followingBody) sym.range.endLine = followingBody.endPosition.row + 1;
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
): Symbol[] {
  const nameNode = signature.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return [];
  const sym = leafSymbol(outer, nameNode, kind, relPath, parent);
  if (followingBody) sym.range.endLine = followingBody.endPosition.row + 1;
  return [sym];
}

/**
 * One Symbol per declarator. Observed:
 *   (initialized_identifier_list (initialized_identifier (identifier) <init expr>?)+)
 *   (static_final_declaration_list (static_final_declaration (identifier) <init expr>)+)
 */
function fieldSymbols(
  outer: Node,
  list: Node,
  relPath: string,
  parent: Symbol | undefined,
): Symbol[] {
  const out: Symbol[] = [];
  for (const declarator of list.namedChildren) {
    if (
      declarator.type !== 'initialized_identifier' &&
      declarator.type !== 'static_final_declaration'
    ) {
      continue;
    }
    const nameNode = declarator.namedChildren.find((c) => c.type === 'identifier');
    if (!nameNode) continue;
    out.push(leafSymbol(outer, nameNode, 'field', relPath, parent));
  }
  return out;
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
