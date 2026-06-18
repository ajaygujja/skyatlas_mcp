/**
 * Shared Dart CST idiom helpers used across multiple extractors.
 *
 * Node names were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 */
import type { Node } from 'web-tree-sitter';

/**
 * Method names that return a value rather than produce a widget.
 *
 * InheritedWidget / Provider lookup (`of`, `maybeOf`) and Riverpod ref
 * accessors (`read`, `watch`, `select`) all follow the pattern
 * `Foo.of(context)`, which is structurally identical to a named constructor
 * `Foo.bar(args)` in the tree-sitter-dart CST. These names are used to
 * reject such calls from widget detection.
 */
export const RESOLVER_STATICS = new Set(['of', 'maybeOf', 'read', 'watch', 'select']);

/**
 * Parses the direct children of a `type_arguments` node into verbatim type-arg
 * strings, preserving nested generics.
 *
 * CST shape for `<List<int>>`:
 *   type_arguments
 *     type_identifier  ‹List›
 *     type_arguments   ‹<int>›   ← nested, sibling of the outer identifier
 *
 * A flat `.map(c => c.text)` produces `["List", "<int>"]`. This function groups
 * each `(type_identifier | identifier, type_arguments?)` pair so the result is
 * `["List<int>"]`. Top-level comma-separated args like `<A, B>` remain two
 * separate `type_identifier` children and correctly produce `["A", "B"]`.
 */
export function parseTypeArgList(typeArgumentsNode: Node): string[] {
  const children = typeArgumentsNode.namedChildren;
  const result: string[] = [];
  let i = 0;
  while (i < children.length) {
    const c = children[i];
    if (!c) {
      i += 1;
      continue;
    }
    if (c.type === 'type_identifier' || c.type === 'identifier') {
      const next = children[i + 1];
      if (next?.type === 'type_arguments') {
        result.push(c.text + next.text);
        i += 2;
      } else {
        result.push(c.text);
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return result;
}
