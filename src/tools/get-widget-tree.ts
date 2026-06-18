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
import { resolveClass } from '../index/resolve.js';
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
        'dynamically built children (loops/conditionals) are not unrolled. ' +
        'Set follow=true to inline-expand child widget classes and cross ' +
        'StatefulWidget→State, so a shell widget resolves to its real tree in one call.',
      inputSchema: {
        widget: z.string().describe('Widget class name, e.g. "HomeScreen" or "ProfileView".'),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max nesting depth to render (default ${String(DEFAULT_DEPTH)}).`),
        follow: z
          .boolean()
          .optional()
          .describe(
            'Inline-expand leaf widgets that name another indexed widget class, ' +
              "crossing StatefulWidget→State (default false = only this class's build()).",
          ),
      },
    },
    async ({ widget, depth, follow }) => {
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
      return textResult(formatWidget(info, index, depth ?? DEFAULT_DEPTH, follow ?? false).join('\n'));
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

/** Carries the resolution context a follow walk needs into the recursion. */
interface RenderContext {
  index: ProjectIndex;
  follow: boolean;
  /** Widget symbolIds on the current path — guards against build-tree cycles. */
  visited: Set<string>;
}

function formatWidget(
  info: WidgetInfo,
  index: ProjectIndex,
  maxDepth: number,
  follow: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`# Widget tree: ${info.name} (${info.flavor}) — ${info.file}:${String(info.line)}`);
  if (info.superclass) lines.push(`extends ${info.superclass}`);

  // A StatefulWidget holds no build() of its own; under follow, render its State
  // class's tree in place rather than asking the caller to make a second call.
  let roots = info.buildTree;
  let from = info;
  if (!roots?.length && follow && info.flavor === 'stateful') {
    const state = stateClassOf(index, info.name);
    if (state?.buildTree?.length) {
      lines.push(`build() in State class ${state.name} — ${state.file}:${String(state.line)}`);
      roots = state.buildTree;
      from = state;
    }
  }

  if (!roots?.length) {
    lines.push('');
    lines.push(noBuildTreeNote(info, index));
    return lines;
  }

  lines.push('');
  const body: string[] = [];
  const ctx: RenderContext = {
    index,
    follow,
    visited: new Set([info.symbolId, from.symbolId]),
  };
  for (const root of roots) {
    renderNode(root, undefined, 0, maxDepth, body, ctx);
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
  ctx: RenderContext,
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

  const staticChildren = Object.entries(node.namedSlots).filter(([, arr]) => arr.length > 0);

  // Only a leaf is followed: a node with literal children already shows its tree,
  // and the syntactic output stays whatever build() wrote at the call site.
  let followed: FollowTarget | undefined;
  if (ctx.follow && staticChildren.length === 0) {
    const target = followTarget(ctx.index, node.widget);
    if (target && !ctx.visited.has(target.from.symbolId)) {
      followed = target;
      tags.push(`follows ${target.from.name} — ${target.from.file}:${String(target.from.line)}`);
    }
  }

  const tagText = tags.length > 0 ? `  [${tags.join('; ')}]` : '';
  out.push(`${indent}${prefix}${head} — :${String(node.line)}${tagText}`);

  const children = followed
    ? followed.roots.map((root) => ['(positional)', root] as const)
    : staticChildren.flatMap(([label, arr]) => arr.map((c) => [label, c] as const));

  if (depth + 1 > maxDepth) {
    if (children.length > 0) {
      out.push(`${indent}  … ${String(children.length)} child widget(s) — raise depth= to expand`);
    }
    return;
  }

  // A followed subtree comes from another class; record it so a build-tree cycle
  // (A builds B builds A) terminates instead of recursing forever.
  const childCtx = followed
    ? { ...ctx, visited: new Set(ctx.visited).add(followed.from.symbolId) }
    : ctx;
  for (const [label, child] of children) {
    renderNode(child, label === '(positional)' ? undefined : label, depth + 1, maxDepth, out, childCtx);
  }
}

interface FollowTarget {
  /** The indexed widget whose build tree is being inlined. */
  from: WidgetInfo;
  roots: WidgetNode[];
}

/**
 * Resolves a leaf constructor name to the build tree of the widget it names,
 * crossing a StatefulWidget to the State class that actually holds build().
 * Resolution goes through the shared seam (deterministic across duplicate
 * names); a name that is not an indexed widget, or one with no static tree,
 * returns undefined so the leaf stays as written rather than a guessed expansion.
 */
function followTarget(index: ProjectIndex, name: string): FollowTarget | undefined {
  const sym = resolveClass(index, name);
  if (!sym) return undefined;
  const target = index.widgets.get(sym.id);
  if (!target) return undefined;
  if (target.buildTree?.length) return { from: target, roots: target.buildTree };
  if (target.flavor === 'stateful') {
    const state = stateClassOf(index, target.name);
    if (state?.buildTree?.length) return { from: state, roots: state.buildTree };
  }
  return undefined;
}

/** The State class for a StatefulWidget: a 'state' widget whose superclass names it. */
function stateClassOf(index: ProjectIndex, statefulName: string): WidgetInfo | undefined {
  for (const w of index.widgets.values()) {
    if (w.flavor === 'state' && w.superclass?.includes(`<${statefulName}>`)) return w;
  }
  return undefined;
}

/**
 * A StatefulWidget's build() lives in its State class. Point the caller there
 * by finding a 'state' widget whose superclass names this widget.
 */
function noBuildTreeNote(info: WidgetInfo, index: ProjectIndex): string {
  if (info.flavor === 'stateful') {
    const state = stateClassOf(index, info.name);
    if (state) {
      return `No build() here — ${info.name} is a StatefulWidget. Its build tree is in its State class '${state.name}'. Call get_widget_tree with widget="${state.name}" (or pass follow=true).`;
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
