/**
 * get_widget_tree — the static build() tree of a widget (TECHNICAL_DESIGN.md
 * §6): constructor invocations as written, indented by nesting, builder
 * callbacks marked, type args shown. Bloc/Provider wiring annotations join in
 * later Phase 3 sub-phases.
 *
 * The tree is SYNTACTIC (§5.2, Working Rule 8): what build() literally
 * constructs, not what renders at runtime. Conditionals/loops/spreads that
 * build widgets dynamically are not unrolled.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { WidgetInfo, WidgetNode } from '../model/flutter.js';
import { capLines, errorResult, textResult } from './format.js';

const MAX_LINES = 200;
const DEFAULT_DEPTH = 8;

export function registerGetWidgetTree(
  server: McpServer,
  getIndex: () => Promise<ProjectIndex>,
): void {
  server.registerTool(
    'get_widget_tree',
    {
      title: 'Get widget tree',
      description:
        'Static build() widget tree of a Flutter widget class: the constructor ' +
        'invocations it composes, indented by nesting, with type args and builder ' +
        'callbacks marked. Answers "what does widget X render / what is its layout" ' +
        'in one call instead of reading the build method. Tree is syntactic — ' +
        'dynamically built children (loops/conditionals) are not unrolled.',
      inputSchema: {
        widget: z.string().describe('Widget class name, e.g. "HomeScreen" or "ProfileView".'),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max nesting depth to render (default ${String(DEFAULT_DEPTH)}).`),
      },
    },
    async ({ widget, depth }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      const matches = resolveWidgets(index, widget);
      if (matches.length === 0) {
        return textResult(noMatchMessage(index, widget));
      }
      if (matches.length > 1) {
        const lines = matches.map((w) => `- ${w.name} (${w.flavor}) — ${w.file}:${String(w.line)}`);
        return textResult(
          `'${widget}' matches ${String(matches.length)} widget classes. Pick one by exact name:\n` +
            lines.join('\n'),
        );
      }

      const info = matches[0];
      if (!info) return errorResult('Widget resolution failed.');
      return textResult(formatWidget(info, index, depth ?? DEFAULT_DEPTH).join('\n'));
    },
  );
}

/** Exact-name (case-insensitive) widget classes in the index. */
function resolveWidgets(index: ProjectIndex, name: string): WidgetInfo[] {
  const lower = name.toLowerCase();
  const out: WidgetInfo[] = [];
  for (const w of index.widgets.values()) {
    if (w.name.toLowerCase() === lower) out.push(w);
  }
  return out.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
}

function formatWidget(info: WidgetInfo, index: ProjectIndex, maxDepth: number): string[] {
  const lines: string[] = [];
  lines.push(`# Widget tree: ${info.name} (${info.flavor}) — ${info.file}:${String(info.line)}`);
  if (info.superclass) lines.push(`extends ${info.superclass}`);

  if (!info.buildTree?.length) {
    lines.push('');
    lines.push(noBuildTreeNote(info, index));
    return lines;
  }

  lines.push('');
  const body: string[] = [];
  for (const root of info.buildTree) {
    renderNode(root, undefined, 0, maxDepth, body);
  }
  lines.push(...capLines(body, MAX_LINES, 'increase specificity or lower depth='));
  lines.push('');
  lines.push('Tree is syntactic: constructor calls as written, not runtime render.');
  return lines;
}

/** Indented one-line-per-node render. `slot` is the parent argument label, if any. */
function renderNode(
  node: WidgetNode,
  slot: string | undefined,
  depth: number,
  maxDepth: number,
  out: string[],
): void {
  const indent = '  '.repeat(depth);
  const head = node.typeArgs ? `${node.widget}<${node.typeArgs.join(', ')}>` : node.widget;
  const prefix = slot ? `${slot}: ` : '';
  const tags: string[] = [];
  if (node.branch) tags.push('alternative branch');
  if (node.conditional) tags.push('conditional');
  if (node.dynamic === 'mapped') tags.push('dynamic (mapped)');
  if (node.dynamic === 'spread') tags.push('spread (dynamic)');
  if (node.isBuilderCallback) tags.push('builder');
  if (node.recoveredFromMisparse) tags.push('generic recovered from mis-parse — slots best-effort');
  const tagText = tags.length > 0 ? `  [${tags.join('; ')}]` : '';
  out.push(`${indent}${prefix}${head} — :${String(node.line)}${tagText}`);

  if (depth + 1 > maxDepth) {
    const childCount = Object.values(node.namedSlots).reduce((n, arr) => n + arr.length, 0);
    if (childCount > 0) {
      out.push(`${indent}  … ${String(childCount)} child widget(s) — raise depth= to expand`);
    }
    return;
  }

  for (const [label, children] of Object.entries(node.namedSlots)) {
    for (const child of children) {
      renderNode(child, label === '(positional)' ? undefined : label, depth + 1, maxDepth, out);
    }
  }
}

/**
 * A StatefulWidget's build() lives in its State class. Point the caller there
 * by finding a 'state' widget whose superclass names this widget.
 */
function noBuildTreeNote(info: WidgetInfo, index: ProjectIndex): string {
  if (info.flavor === 'stateful') {
    for (const w of index.widgets.values()) {
      if (w.flavor === 'state' && w.superclass?.includes(`<${info.name}>`)) {
        return `No build() here — ${info.name} is a StatefulWidget. Its build tree is in its State class '${w.name}'. Call get_widget_tree with widget="${w.name}".`;
      }
    }
    return `No build() here — ${info.name} is a StatefulWidget; its build tree lives in a separate State class (not found in the index).`;
  }
  return `No build() tree extracted for ${info.name}. It may build via a helper method or have no build() in this class.`;
}

function noMatchMessage(index: ProjectIndex, name: string): string {
  const lower = name.toLowerCase();
  const near = [...index.widgets.values()]
    .filter((w) => w.name.toLowerCase().includes(lower))
    .slice(0, 8)
    .map((w) => `${w.name} (${w.flavor})`);
  if (near.length > 0) {
    return `No widget class named '${name}'. Similar: ${near.join(', ')}.`;
  }
  return `No widget class named '${name}'. ${String(index.widgets.size)} widget(s) indexed — use find_symbol to search, or get_project_map to orient.`;
}
