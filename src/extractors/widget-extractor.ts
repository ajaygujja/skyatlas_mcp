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
      const tree = scanSequence(buildBody.namedChildren, false)[0];
      if (tree) info.buildTree = tree;
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
function scanSequence(kids: readonly (Node | null)[], inBuilder: boolean): WidgetNode[] {
  const out: WidgetNode[] = [];
  let i = 0;
  while (i < kids.length) {
    const child = kids[i];
    if (!child) {
      i++;
      continue;
    }
    if (child.type === 'const_object_expression') {
      out.push(parseConstObject(child, inBuilder));
      i++;
    } else if (child.type === 'identifier' && isConstructorName(child.text)) {
      const r = parsePlainInvocation(kids, i, inBuilder);
      if (r.node) out.push(r.node);
      i = Math.max(r.next, i + 1);
    } else if (child.type === 'relational_expression' && isMisparsedGeneric(child)) {
      const r = recoverGeneric(kids, i, inBuilder);
      if (r.node) out.push(r.node);
      i = Math.max(r.next, i + 1);
    } else {
      // Wrapper node: descend. Entering a builder closure flips inBuilder on
      // for its returned construction.
      const childIsBuilder = inBuilder || child.type === 'function_expression';
      out.push(...scanSequence(child.namedChildren, childIsBuilder));
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
function parseConstObject(node: Node, inBuilder: boolean): WidgetNode {
  const typeId = node.namedChildren.find((c) => c.type === 'type_identifier');
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const out: WidgetNode = {
    widget: typeId?.text ?? '<const>',
    line: node.startPosition.row + 1,
    namedSlots: args ? slotsFromArgs(args.namedChildren) : {},
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
  const node: WidgetNode = {
    widget: name,
    line: head.startPosition.row + 1,
    namedSlots: slotsFromArgs(args.namedChildren),
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
    namedSlots: recordLit ? slotsFromRecordLiteral(recordLit) : {},
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
function slotsFromArgs(argKids: readonly (Node | null)[]): Record<string, WidgetNode[]> {
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
        const r = recoverGeneric(argKids, i, false);
        if (r.node) addSlot(slots, label, [r.node]);
        i = Math.max(r.next, i + 1);
        continue;
      }
      const nodes = scanSequence(arg.namedChildren, false);
      if (nodes.length > 0) addSlot(slots, label, nodes);
      i++;
    } else if (arg.type === 'argument') {
      const nodes = scanSequence(arg.namedChildren, false);
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
function slotsFromRecordLiteral(rec: Node): Record<string, WidgetNode[]> {
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
      const nodes = scanSequence(segment, false);
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

/** `(type_arguments (type_identifier|...)+)` → verbatim arg texts. */
function parseTypeArgs(parent: Node): string[] | undefined {
  const ta = parent.namedChildren.find((c) => c.type === 'type_arguments');
  if (!ta) return undefined;
  const args = ta.namedChildren.map((c) => c.text);
  return args.length > 0 ? args : undefined;
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
