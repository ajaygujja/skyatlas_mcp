/**
 * Import/export directive extraction for FileEntry.imports (§5.3).
 *
 * Observed CST (scripts/dump-tree.ts, tree-sitter-dart @ a9bdfa3):
 *   (import_or_export (library_import (import_specification (configurable_uri (uri (string_literal))) (identifier)?)))
 *   (import_or_export (library_export (configurable_uri (uri (string_literal)))))
 * The optional identifier after the uri is an `as` prefix.
 */
import type { Tree } from 'web-tree-sitter';

export interface ImportEntry {
  /** URI as written, quotes stripped: "package:flutter/material.dart". */
  uri: string;
  kind: 'import' | 'export';
  /** `as` prefix, when present. */
  prefix?: string;
}

export function extractImports(tree: Tree): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'import_or_export') continue;
    const decl = node.namedChildren[0];
    if (!decl) continue;
    const uriNode = decl.descendantsOfType('uri')[0];
    if (!uriNode) continue;
    const entry: ImportEntry = {
      uri: uriNode.text.replace(/^['"]|['"]$/g, ''),
      kind: decl.type === 'library_export' ? 'export' : 'import',
    };
    const spec = decl.type === 'library_import' ? decl.namedChildren[0] : undefined;
    const prefix = spec?.namedChildren.find((c) => c.type === 'identifier');
    if (prefix) entry.prefix = prefix.text;
    out.push(entry);
  }
  return out;
}
