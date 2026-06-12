/**
 * Empirical node-name discovery tool (TECHNICAL_DESIGN.md §7.2, Working Rule 2).
 *
 * Every tree-sitter query in this project must be written against node names
 * observed via this script — never recalled from memory.
 *
 * Usage:
 *   pnpm dump-tree path/to/file.dart            # pretty-printed named-node tree
 *   pnpm dump-tree path/to/file.dart --sexp     # raw rootNode.toString()
 *   echo 'class A {}' | pnpm dump-tree -        # parse stdin
 */
import { readFileSync } from 'node:fs';
import { initParser, parseText } from '../src/parser/parser.js';
import type { Node } from 'web-tree-sitter';

function printNode(node: Node, source: string, depth: number): void {
  const pos = `${String(node.startPosition.row + 1)}:${String(node.startPosition.column + 1)}`;
  const snippet = node.text.length <= 60 ? node.text.replace(/\n/g, '\\n') : '';
  const label = snippet ? `  ‹${snippet}›` : '';
  process.stdout.write(`${'  '.repeat(depth)}${node.type} [${pos}]${label}\n`);
  for (const child of node.namedChildren) {
    printNode(child, source, depth + 1);
  }
}

async function main(): Promise<void> {
  const [target, flag] = process.argv.slice(2);
  if (!target) {
    process.stderr.write('usage: dump-tree <file.dart | -> [--sexp]\n');
    process.exit(1);
  }
  const source = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8');

  await initParser();
  const tree = parseText(source);

  if (flag === '--sexp') {
    process.stdout.write(`${tree.rootNode.toString()}\n`);
  } else {
    printNode(tree.rootNode, source, 0);
  }
}

void main();
