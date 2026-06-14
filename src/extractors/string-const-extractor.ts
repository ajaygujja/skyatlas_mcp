/**
 * String-const extractor: collects compile-time string constants so the route
 * graph can resolve const path references (`path: RoutePaths.home` → "/home")
 * instead of dropping or labelling them as shells (§5.1 honesty, fallback to
 * verbatim when a value cannot be resolved).
 *
 * Pure: CST in → data out, no I/O (§9.1). Scope is deliberately narrow — only
 * declarations whose initializer is a single `string_literal`:
 *  - class fields:  `class RoutePaths { static const home = '/home'; }`
 *  - top-level:     `const homePath = '/home';`
 *
 * Both a class-qualified key (`RoutePaths.home`) and the bare field name (`home`)
 * are emitted; the qualified form is preferred at lookup, the bare form is the
 * fallback. Bare collisions keep the first value seen — acceptable for display
 * resolution that already degrades gracefully to verbatim text.
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2:
 *   (static_final_declaration (identifier 'home') (string_literal "'/home'"))
 */
import type { Node, Tree } from 'web-tree-sitter';

/** `RoutePaths.home` / `home` → resolved string value (quotes stripped). */
export type StringConsts = Record<string, string>;

export function extractStringConsts(tree: Tree): StringConsts {
  const out: StringConsts = {};
  walk(tree.rootNode, undefined, out);
  return out;
}

function walk(node: Node, enclosingClass: string | undefined, out: StringConsts): void {
  let scope = enclosingClass;
  if (node.type === 'class_definition') {
    scope = node.namedChildren.find((c) => c.type === 'identifier')?.text;
  }
  if (node.type === 'static_final_declaration') {
    const name = node.namedChildren.find((c) => c.type === 'identifier')?.text;
    const lit = node.namedChildren.find((c) => c.type === 'string_literal');
    if (name && lit) {
      const value = stripQuotes(lit.text);
      if (scope) {
        out[`${scope}.${name}`] = value;
      }
      if (!(name in out)) out[name] = value;
    }
  }
  for (const child of node.namedChildren) walk(child, scope, out);
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}
