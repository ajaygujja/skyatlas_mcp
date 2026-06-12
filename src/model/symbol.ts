/**
 * Core symbol model (TECHNICAL_DESIGN.md §5.1).
 *
 * Phase 1 populates the structural core: id, name, qualifiedName, kind, file,
 * range, nameRange, parentId, children. Declaration detail fields (type
 * params, extends/implements, annotations, modifiers, params, doc) land in
 * Phase 2 — they are declared here already so the shape is stable.
 *
 * Honesty rule: every type field is verbatim source text, never resolved.
 */

export type SymbolKind =
  | 'class'
  | 'mixin'
  | 'enum'
  | 'extension'
  | 'extensionType'
  | 'function'
  | 'method'
  | 'getter'
  | 'setter'
  | 'constructor'
  | 'field'
  | 'typedef';

export interface TypeRef {
  name: string;
  typeArgs: string[];
}

export interface Annotation {
  name: string;
  args?: string;
}

export interface Param {
  name: string;
  type?: string;
  named: boolean;
  required: boolean;
}

/** A declaration in source code. Nested: classes contain methods, etc. */
export interface Symbol {
  /** Stable: `${relPath}#${qualifiedName}`, e.g. "lib/blocs/user_bloc.dart#UserBloc.onLoad". */
  id: string;
  name: string;
  /** Includes enclosing scopes: "UserBloc.onLoad". Setters use Dart's `name=` convention. */
  qualifiedName: string;
  kind: SymbolKind;
  /** Workspace-relative path. */
  file: string;
  /** 1-based, inclusive; spans declaration through body. */
  range: { startLine: number; endLine: number };
  /** Position of the name token, for precise navigation. 1-based. */
  nameRange: { line: number; col: number };
  parentId?: string;
  children: Symbol[];

  typeParameters?: string[];
  extendsType?: TypeRef;
  implementsTypes?: TypeRef[];
  mixesIn?: TypeRef[];
  annotations: Annotation[];
  modifiers: string[];
  returnType?: string;
  parameters?: Param[];
  doc?: string;
}
