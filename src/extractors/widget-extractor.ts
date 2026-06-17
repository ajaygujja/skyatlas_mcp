/**
 * Widget extractor (TECHNICAL_DESIGN.md Phase 3a): detects widget classes and
 * parses the STATIC widget tree inside each build() method — the constructor
 * invocations as literally written, never what renders at runtime (§5.2).
 *
 * Pure: CST in → data out, no I/O (§9.1).
 *
 * Node names below were observed via scripts/dump-tree.ts against
 * tree-sitter-dart @ a9bdfa3 (vendor/GRAMMAR_VERSION), per Working Rule 2.
 *
 * KNOWN GRAMMAR WEAKNESS (§2): a generic constructor with >=2 comma-separated
 * type args at value position — `BlocBuilder<UserBloc, UserState>(...)` —
 * mis-parses. Instead of one invocation node the grammar yields a
 * `relational_expression` (reading `<`/`>` as comparison operators) and spills
 * the real argument list into a sibling `record_literal`. A single type arg
 * (`FutureBuilder<int>(...)`) parses cleanly. We recover name + type args from
 * the mis-parse and best-effort the slots, flagged `recoveredFromMisparse`.
 */
import type { Node, Tree } from 'web-tree-sitter';
import type { WidgetFlavor, WidgetInfo, WidgetNode } from '../model/flutter.js';
import { parseTypeArgList, RESOLVER_STATICS } from './dart-idioms.js';

/**
 * Per-widget-extraction scan context. Carries the class body so build-helper
 * calls (`_buildBody()`, `_buildHeader()`) can be resolved inline, and an
 * expanding set to break mutual-recursion cycles.
 */
interface ScanCtx {
  classBody?: Node;
  expanding: Set<string>;
}

/**
 * Iterable transforms whose closure produces children dynamically. The static
 * tree shows one representative element labelled `dynamic (mapped)`, never an
 * enumerable list — the runtime count is not statically knowable.
 */
const COLLECTION_TRANSFORMS = new Set(['map', 'where', 'expand']);

/** Known widget base classes → flavor. Anything else ending in `Widget` is `unknownWidgetSubclass`. */
const FLAVOR_BY_SUPERCLASS: Record<string, WidgetFlavor> = {
  StatelessWidget: 'stateless',
  StatefulWidget: 'stateful',
  State: 'state',
  ConsumerState: 'state',
  ConsumerWidget: 'consumer',
  ConsumerStatefulWidget: 'consumer',
  HookWidget: 'hook',
  HookConsumerWidget: 'hook',
  StatefulHookConsumerWidget: 'hook',
};

export function extractWidgets(tree: Tree, relPath: string): WidgetInfo[] {
  const out: WidgetInfo[] = [];
  // Dart has no nested class declarations; all class_definitions are top-level.
  for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
    const info = widgetInfoFor(cls, relPath);
    if (info) out.push(info);
  }
  return out;
}

function widgetInfoFor(cls: Node, relPath: string): WidgetInfo | undefined {
  const nameNode = cls.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return undefined;

  // Observed: (superclass (type_identifier) (type_arguments)?)
  const superclass = cls.namedChildren.find((c) => c.type === 'superclass');
  if (!superclass) return undefined;
  const superId = superclass.namedChildren.find((c) => c.type === 'type_identifier');
  if (!superId) return undefined;

  const flavor = flavorFor(superId.text);
  if (!flavor) return undefined;

  // id scheme must match symbol-extractor.ts leafSymbol(): `${relPath}#${qualifiedName}`.
  const name = nameNode.text;
  const info: WidgetInfo = {
    symbolId: `${relPath}#${name}`,
    name,
    flavor,
    file: relPath,
    line: cls.startPosition.row + 1,
  };
  const superText = superclass.text.replace(/^extends\s+/, '');
  if (superText) info.superclass = superText;

  const body = cls.namedChildren.find((c) => c.type === 'class_body');
  if (body) {
    const buildBody = findBuildBody(body);
    if (buildBody) {
      const ctx: ScanCtx = { classBody: body, expanding: new Set() };
      const roots = collectBuildRoots(buildBody, ctx);
      if (roots.length > 0) info.buildTree = roots;
    }
  }
  return info;
}

function flavorFor(superName: string): WidgetFlavor | undefined {
  const known = FLAVOR_BY_SUPERCLASS[superName];
  if (known) return known;
  if (superName.endsWith('Widget')) return 'unknownWidgetSubclass';
  return undefined;
}

/**
 * The function_body of the `build` method. Observed: a `method_signature`
 * (wrapping a `function_signature` whose identifier is `build`) is a SIBLING
 * of its `function_body`, same as in symbol-extractor.ts.
 */
function findBuildBody(classBody: Node): Node | undefined {
  const kids = classBody.namedChildren;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k) continue;
    const sig = k.type === 'method_signature' ? k.namedChildren[0] : k;
    if (sig?.type !== 'function_signature') continue;
    const id = sig.namedChildren.find((c) => c.type === 'identifier');
    if (id?.text !== 'build') continue;
    const next = kids[i + 1];
    if (next?.type === 'function_body') return next;
  }
  return undefined;
}

/**
 * Collects all alternative build roots from a build() function body.
 * Locates return_statement nodes (never descending into closures), extracts
 * their expressions, and expands conditional_expression / switch_expression
 * into per-branch roots. Roots are marked branch: true when ≥2 alternatives.
 *
 * Observed CST shapes (Working Rule 2, tree-sitter-dart @ a9bdfa3):
 *   - Multiple returns: return_statement siblings in block / nested in if_statement.
 *   - Ternary: return_statement → conditional_expression
 *       namedChildren: [cond, then_parts…, else_parts…]
 *       Skip child[0] (condition); scanSequence handles the interleaved pairs.
 *   - Switch expr: return_statement → switch_expression
 *       namedChildren: [parenthesized_expression, switch_expression_case*]
 *       switch_expression_case namedChildren: [pattern, expr_parts…] — skip pattern.
 */
function collectBuildRoots(buildBody: Node, ctx: ScanCtx): WidgetNode[] {
  const returnNodes = findTopLevelReturns(buildBody);
  const roots: WidgetNode[] = [];

  for (const ret of returnNodes) {
    const expr = ret.namedChildren[0];
    if (!expr) continue;

    if (expr.type === 'conditional_expression') {
      // Skip condition (child[0]); the then/else expression parts follow as
      // sibling children. scanSequence naturally groups each invocation pair.
      const nodes = scanSequence(expr.namedChildren.slice(1), false, ctx);
      roots.push(...nodes);
    } else if (expr.type === 'switch_expression') {
      // Each switch_expression_case contributes one branch expression.
      for (const cas of expr.namedChildren) {
        if (cas.type !== 'switch_expression_case') continue;
        // cas.namedChildren: [pattern, expr_parts…] — skip the pattern.
        const nodes = scanSequence(cas.namedChildren.slice(1), false, ctx);
        roots.push(...nodes);
      }
    } else {
      // Direct return: the expression and its selectors are siblings inside the
      // return_statement (e.g. identifier + selector for plain invocations).
      const nodes = scanSequence(ret.namedChildren, false, ctx);
      roots.push(...nodes);
    }
  }

  if (roots.length > 1) {
    for (const r of roots) r.branch = true;
  }
  return roots;
}

/**
 * Recursively collects return_statement nodes from a build body, stopping at
 * function_expression boundaries so closure returns are not included.
 */
function findTopLevelReturns(node: Node): Node[] {
  const results: Node[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'return_statement') {
      results.push(child);
    } else if (child.type !== 'function_expression') {
      results.push(...findTopLevelReturns(child));
    }
  }
  return results;
}

/**
 * Scans a sibling sequence for top-level widget constructions. A construction
 * is NOT a single node: tree-sitter-dart represents `Scaffold(...)` as an
 * `identifier` followed by `selector` siblings, so we walk the array with a
 * cursor. Non-construction wrapper nodes (block, return_statement, list_literal,
 * function_expression, …) are recursed into.
 *
 * `inBuilder` marks that this sequence is the direct body of a builder closure;
 * the first construction found carries `isBuilderCallback`. It does NOT
 * propagate into that construction's own slots (reset there to false).
 */
function scanSequence(kids: readonly (Node | null)[], inBuilder: boolean, ctx: ScanCtx): WidgetNode[] {
  const out: WidgetNode[] = [];
  let i = 0;
  while (i < kids.length) {
    const child = kids[i];
    if (!child) {
      i++;
      continue;
    }
    if (child.type === 'const_object_expression') {
      out.push(parseConstObject(child, inBuilder, ctx));
      i++;
    } else if (child.type === 'identifier' && isBuildHelperName(child.text) && ctx.classBody) {
      // Build-helper call: consume identifier + argument selector, inline body.
      const nextI = kids[i + 1]?.type === 'selector' ? i + 2 : i + 1;
      const inlined = resolveHelperMethod(child.text, ctx);
      if (inlined.length > 0) {
        if (inBuilder) { const first = inlined[0]; if (first) first.isBuilderCallback = true; }
        out.push(...inlined);
      }
      i = nextI;
    } else if (child.type === 'identifier' && isConstructorName(child.text)) {
      const r = parsePlainInvocation(kids, i, inBuilder, ctx);
      if (r.node) out.push(r.node);
      i = Math.max(r.next, i + 1);
    } else if (child.type === 'relational_expression' && isMisparsedGeneric(child)) {
      const r = recoverGeneric(kids, i, inBuilder, ctx);
      if (r.node) out.push(r.node);
      i = Math.max(r.next, i + 1);
    } else if (child.type === 'selector' && isCollectionTransform(child)) {
      // `.map`/`.where`/`.expand`: a dynamic transform, not a builder slot.
      // Emit one representative child labelled `dynamic (mapped)` and consume
      // the call's argument selector so its closure is not re-scanned as a
      // builder (the closure is a mapper, not a `builder:` callback — N2).
      const argSel = kids[i + 1];
      const closure = argSel?.type === 'selector' ? closureOf(argSel) : undefined;
      if (closure) {
        const rep = scanSequence(closure.namedChildren, false, ctx)[0];
        if (rep) {
          rep.dynamic = 'mapped';
          out.push(rep);
        }
        i += 2;
      } else {
        out.push(...scanSequence(child.namedChildren, inBuilder, ctx));
        i++;
      }
    } else if (child.type === 'if_element') {
      // Collection-`if` (`if (cond) Widget()`): the child(ren) render only when
      // the condition holds. Keep them, marked conditional — distinct from a
      // plain static child (W4). The condition expression yields no widget.
      for (const n of scanSequence(child.namedChildren, inBuilder, ctx)) {
        n.conditional = true;
        out.push(n);
      }
      i++;
    } else if (child.type === 'spread_element') {
      // Spread (`...widgets`): an opaque list reference whose element count and
      // shape are runtime-dependent. Emit one honest marker, never silently
      // drop it (W4).
      const src = child.namedChildren.find((c) => c.type === 'identifier');
      out.push({
        widget: src ? `...${src.text}` : '...',
        line: child.startPosition.row + 1,
        namedSlots: {},
        dynamic: 'spread',
      });
      i++;
    } else {
      // Wrapper node: descend. Entering a builder closure marks the first
      // construction found inside it as isBuilderCallback.
      const childIsBuilder = inBuilder || child.type === 'function_expression';
      out.push(...scanSequence(child.namedChildren, childIsBuilder, ctx));
      i++;
    }
  }
  return out;
}

/**
 * `const Text('x')` → (const_object_expression (const_builtin) (type_identifier)
 * (type_arguments)? (arguments)). Self-contained: args are a direct child, no
 * trailing selector.
 */
function parseConstObject(node: Node, inBuilder: boolean, ctx: ScanCtx): WidgetNode {
  const typeId = node.namedChildren.find((c) => c.type === 'type_identifier');
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const out: WidgetNode = {
    widget: typeId?.text ?? '<const>',
    line: node.startPosition.row + 1,
    namedSlots: args ? slotsFromArgs(args.namedChildren, ctx) : {},
  };
  const typeArgs = parseTypeArgs(node);
  if (typeArgs) out.typeArgs = typeArgs;
  if (inBuilder) out.isBuilderCallback = true;
  return out;
}

/**
 * kids[start] is a constructor-name identifier. Consumes following `selector`
 * siblings: `.builder` style selectors extend the name (named constructors);
 * the `argument_part` selector supplies type args + arguments. A property-access
 * selector AFTER the call (e.g. `Theme.of(context).primaryColor`) marks a value
 * expression, not a standalone widget → discarded.
 */
function parsePlainInvocation(
  kids: readonly (Node | null)[],
  start: number,
  inBuilder: boolean,
  ctx: ScanCtx,
): { node?: WidgetNode; next: number } {
  const head = kids[start];
  if (!head) return { next: start + 1 };
  let name = head.text;
  let typeArgs: string[] | undefined;
  let args: Node | undefined;
  let i = start + 1;

  while (i < kids.length) {
    const sel = kids[i];
    if (sel?.type !== 'selector') break;
    const inner = sel.namedChildren[0];
    if (inner?.type === 'argument_part') {
      typeArgs = parseTypeArgs(inner);
      args = inner.namedChildren.find((c) => c.type === 'arguments') ?? undefined;
      i++;
      // Chained property access after the call → value expression, not a widget.
      const after = kids[i];
      if (
        after?.type === 'selector' &&
        after.namedChildren[0]?.type === 'unconditional_assignable_selector'
      ) {
        return { next: i };
      }
      break;
    }
    if (inner?.type === 'unconditional_assignable_selector') {
      // Named constructor (`.builder`) when it precedes the args.
      if (args) break;
      const id = inner.namedChildren.find((c) => c.type === 'identifier');
      if (id) name += `.${id.text}`;
      i++;
      continue;
    }
    break;
  }

  if (!args) return { next: i };

  // Reject resolver statics: `Foo.of(ctx)`, `Foo.watch(ctx)` etc. share the
  // same CST shape as named constructors but return values, not widgets.
  const lastDot = name.lastIndexOf('.');
  if (lastDot >= 0 && RESOLVER_STATICS.has(name.slice(lastDot + 1))) {
    return { next: i };
  }

  const node: WidgetNode = {
    widget: name,
    line: head.startPosition.row + 1,
    namedSlots: slotsFromArgs(args.namedChildren, ctx),
  };
  if (typeArgs) node.typeArgs = typeArgs;
  if (inBuilder) node.isBuilderCallback = true;
  return { node, next: i };
}

/**
 * Recovers a mis-parsed generic constructor (see file header). kids[start] is a
 * `named_argument` or `argument` whose value begins a
 * `relational_expression` (`Widget < TypeArg0`). Type args continue across
 * sibling nodes until a `>`; the real argument list is a `record_literal`
 * somewhere in the consumed span. Best-effort, flagged on the node.
 */
function recoverGeneric(
  kids: readonly (Node | null)[],
  start: number,
  inBuilder: boolean,
  ctx: ScanCtx,
): { node?: WidgetNode; next: number } {
  const lead = kids[start];
  if (!lead) return { next: start + 1 };
  const rel0 =
    lead.type === 'relational_expression'
      ? lead
      : lead.namedChildren.find((c) => c.type === 'relational_expression');
  if (!rel0) return { next: start + 1 };

  const headId = rel0.namedChildren[0];
  if (!headId) return { next: start + 1 };

  const typeArgs: string[] = [];
  let recordLit: Node | undefined;

  // Walk this relational_expression's children, then following siblings, until
  // we pass the closing `>`. Accumulate type-arg identifiers; grab a record_literal.
  const collect = (n: Node): boolean => {
    // returns true once the closing `>` has been consumed
    for (const c of n.namedChildren) {
      if (c.type === 'relational_operator') {
        if (c.text === '>') return true;
        continue; // '<'
      }
      if (c === headId) continue;
      if (c.type === 'identifier' || c.type === 'type_identifier') {
        typeArgs.push(c.text);
      } else if (c.type === 'record_literal') {
        recordLit = c;
      } else if (c.type === 'relational_expression') {
        if (collect(c)) {
          // closing `>` found nested; the record_literal may be its sibling
          const rec = c.namedChildren.find((x) => x.type === 'record_literal');
          if (rec) recordLit = rec;
          return true;
        }
      }
    }
    return false;
  };

  let i = start;
  let closed = collect(rel0);
  i++;
  while (!closed && i < kids.length) {
    const sib = kids[i];
    if (!sib) {
      i++;
      continue;
    }
    // A clean named_argument with a label that is not a misparse continuation
    // ends the recovery span.
    if (sib.type === 'named_argument') break;
    if (sib.type === 'argument' || sib.type === 'relational_expression') {
      closed = collect(sib);
      i++;
      continue;
    }
    break;
  }

  const node: WidgetNode = {
    widget: headId.text,
    line: headId.startPosition.row + 1,
    namedSlots: recordLit ? slotsFromRecordLiteral(recordLit, ctx) : {},
    recoveredFromMisparse: true,
  };
  if (typeArgs.length > 0) node.typeArgs = typeArgs;
  if (inBuilder) node.isBuilderCallback = true;
  return { node, next: i };
}

/**
 * Slots from a normal `arguments` node: named_argument label → constructions;
 * positional → "(positional)". Uses a cursor because a mis-parsed generic in a
 * named slot spills its continuation (more type args + the real `record_literal`)
 * into FOLLOWING sibling `argument` nodes at THIS level — see recoverGeneric.
 */
function slotsFromArgs(argKids: readonly (Node | null)[], ctx: ScanCtx): Record<string, WidgetNode[]> {
  const slots: Record<string, WidgetNode[]> = {};
  let i = 0;
  while (i < argKids.length) {
    const arg = argKids[i];
    if (!arg) {
      i++;
      continue;
    }
    if (arg.type === 'named_argument') {
      const label = labelOf(arg);
      if (!label || isEventHandlerSlot(label)) {
        i++;
        continue;
      }
      const misparse = arg.namedChildren.find(
        (c) => c.type === 'relational_expression' && isMisparsedGeneric(c),
      );
      if (misparse) {
        const r = recoverGeneric(argKids, i, false, ctx);
        if (r.node) addSlot(slots, label, [r.node]);
        i = Math.max(r.next, i + 1);
        continue;
      }
      const nodes = scanSequence(arg.namedChildren, false, ctx);
      if (nodes.length > 0) addSlot(slots, label, nodes);
      i++;
    } else if (arg.type === 'argument') {
      const nodes = scanSequence(arg.namedChildren, false, ctx);
      if (nodes.length > 0) addSlot(slots, '(positional)', nodes);
      i++;
    } else {
      i++;
    }
  }
  return slots;
}

/**
 * Event-handler slots (`onPressed`, `onTap`, `onChanged`, …) hold callbacks that
 * fire at runtime, not part of the static layout tree — and they often construct
 * non-widgets (Bloc events, etc.). Builder slots (`builder`, `itemBuilder`) do
 * NOT match this and are kept. Convention: handlers are `on` + CapitalizedVerb.
 */
function isEventHandlerSlot(label: string): boolean {
  return /^on[A-Z]/.test(label);
}

/**
 * Slots from a `record_literal` recovered from a mis-parse. Children are a flat
 * sequence: `label`, value(s), `label`, value(s), …. We segment on labels.
 */
function slotsFromRecordLiteral(rec: Node, ctx: ScanCtx): Record<string, WidgetNode[]> {
  const slots: Record<string, WidgetNode[]> = {};
  const kids = rec.namedChildren;
  let i = 0;
  while (i < kids.length) {
    const k = kids[i];
    if (k?.type !== 'label') {
      i++;
      continue;
    }
    const label = labelText(k);
    const segment: Node[] = [];
    i++;
    while (i < kids.length && kids[i]?.type !== 'label') {
      const v = kids[i];
      if (v) segment.push(v);
      i++;
    }
    if (label) {
      const nodes = scanSequence(segment, false, ctx);
      if (nodes.length > 0) addSlot(slots, label, nodes);
    }
  }
  return slots;
}

function addSlot(slots: Record<string, WidgetNode[]>, label: string, nodes: WidgetNode[]): void {
  const existing = slots[label];
  if (existing) existing.push(...nodes);
  else slots[label] = nodes;
}

/** `(label: (identifier))` → the identifier text (the `:` is an anonymous node). */
function labelOf(namedArg: Node): string | undefined {
  const label = namedArg.namedChildren.find((c) => c.type === 'label');
  return label ? labelText(label) : undefined;
}

function labelText(label: Node): string | undefined {
  return label.namedChildren.find((c) => c.type === 'identifier')?.text;
}

/** `(type_arguments …)` → verbatim arg texts, nested generics preserved. */
function parseTypeArgs(parent: Node): string[] | undefined {
  const ta = parent.namedChildren.find((c) => c.type === 'type_arguments');
  if (!ta) return undefined;
  const args = parseTypeArgList(ta);
  return args.length > 0 ? args : undefined;
}

/** A `.map` / `.where` / `.expand` call selector (`unconditional_assignable_selector`). */
function isCollectionTransform(selector: Node): boolean {
  const inner = selector.namedChildren[0];
  if (inner?.type !== 'unconditional_assignable_selector') return false;
  const id = inner.namedChildren.find((c) => c.type === 'identifier');
  return id !== undefined && COLLECTION_TRANSFORMS.has(id.text);
}

/**
 * The `function_expression` argument of a call selector, reached via
 * `selector → argument_part → arguments → argument → function_expression`.
 * Undefined for a tear-off argument (`.map(buildTile)`), where no closure body
 * is statically visible.
 */
function closureOf(argSelector: Node): Node | undefined {
  const argPart = argSelector.namedChildren[0];
  if (argPart?.type !== 'argument_part') return undefined;
  const args = argPart.namedChildren.find((c) => c.type === 'arguments');
  const arg = args?.namedChildren.find((c) => c.type === 'argument');
  return arg?.namedChildren.find((c) => c.type === 'function_expression');
}

function isMisparsedGeneric(n: Node): boolean {
  const first = n.namedChildren[0];
  const op = n.namedChildren.find((c) => c.type === 'relational_operator');
  return first?.type === 'identifier' && isConstructorName(first.text) && op?.text === '<';
}

/** Constructor names are PascalCase by Dart convention; private widgets may lead with `_`. */
function isConstructorName(s: string): boolean {
  const core = s.replace(/^_+/, '');
  const c = core[0];
  return c !== undefined && c >= 'A' && c <= 'Z';
}

/**
 * Private build-helper methods that return a widget subtree.
 * Matches `_buildSomething` / `buildSomething` (optional leading underscore,
 * followed by the word `build` and an uppercase letter or underscore).
 */
function isBuildHelperName(s: string): boolean {
  return /^_?build[A-Z_]/.test(s);
}

/**
 * Returns the function_body of the named method within a class body.
 * The CST pairs a `method_signature` (or bare `function_signature`) with its
 * immediately following `function_body` sibling — the same layout used by
 * `build()` itself.
 */
function findMethodBody(classBody: Node, methodName: string): Node | undefined {
  const kids = classBody.namedChildren;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k) continue;
    const sig = k.type === 'method_signature' ? k.namedChildren[0] : k;
    if (sig?.type !== 'function_signature') continue;
    const id = sig.namedChildren.find((c) => c.type === 'identifier');
    if (id?.text !== methodName) continue;
    const next = kids[i + 1];
    if (next?.type === 'function_body') return next;
  }
  return undefined;
}

/**
 * Inlines the return tree of a build-helper method into the caller's slot.
 * Guards against infinite expansion via the `expanding` set in `ctx`.
 */
function resolveHelperMethod(name: string, ctx: ScanCtx): WidgetNode[] {
  if (!ctx.classBody || ctx.expanding.has(name)) return [];
  const body = findMethodBody(ctx.classBody, name);
  if (!body) return [];
  ctx.expanding.add(name);
  const roots = collectBuildRoots(body, ctx);
  ctx.expanding.delete(name);
  return roots;
}
