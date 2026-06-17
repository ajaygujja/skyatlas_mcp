/**
 * Repro harness for get_widget_tree RC1 (shallow-AST) bugs.
 * Runs the REAL extractWidgets over a fixture and renders each build tree with
 * the same indented format get_widget_tree.ts uses. NOT a fix — diagnosis only.
 *
 *   pnpm tsx scripts/repro-widget-tree.ts [path/to/file.dart]
 */
import { readFileSync } from 'node:fs';
import { initParser, parseText } from '../src/parser/parser.js';
import { extractWidgets } from '../src/extractors/widget-extractor.js';
import type { WidgetNode } from '../src/model/flutter.js';

function renderNode(node: WidgetNode, slot: string | undefined, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const head = node.typeArgs ? `${node.widget}<${node.typeArgs.join(', ')}>` : node.widget;
  const prefix = slot ? `${slot}: ` : '';
  const tags: string[] = [];
  if (node.branch) tags.push('alternative branch');
  if (node.isBuilderCallback) tags.push('builder');
  if (node.recoveredFromMisparse) tags.push('generic recovered from mis-parse — slots best-effort');
  const tagText = tags.length > 0 ? `  [${tags.join('; ')}]` : '';
  out.push(`${indent}${prefix}${head} — :${String(node.line)}${tagText}`);
  for (const [label, children] of Object.entries(node.namedSlots)) {
    for (const child of children) {
      renderNode(child, label === '(positional)' ? undefined : label, depth + 1, out);
    }
  }
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? 'fixtures/basic/widget_tree_repro.dart';
  const source = readFileSync(target, 'utf8');
  await initParser();
  const tree = parseText(source);
  const widgets = extractWidgets(tree, target);

  for (const w of widgets) {
    process.stdout.write(`\n# ${w.name} (${w.flavor}) — :${String(w.line)}\n`);
    if (!w.buildTree?.length) {
      process.stdout.write('  <no build tree extracted>\n');
      continue;
    }
    const body: string[] = [];
    for (const root of w.buildTree) {
      renderNode(root, undefined, 1, body);
    }
    process.stdout.write(body.join('\n') + '\n');
  }
}

void main();
