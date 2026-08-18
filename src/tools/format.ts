/**
 * Shared response formatting for the MCP tools. The consumer is an LLM
 * (TECHNICAL_DESIGN.md §6): dense markdown lines, file:line on every fact,
 * explicit truncation, no prose padding.
 */
import type { Param, Symbol, TypeRef } from '../model/symbol.js';

export function typeRefText(ref: TypeRef): string {
  return ref.typeArgs.length > 0 ? `${ref.name}<${ref.typeArgs.join(', ')}>` : ref.name;
}

export function fileLine(sym: Symbol): string {
  return `${sym.file}:${String(sym.range.startLine)}`;
}

/**
 * Reconstructs `(a, [b], {required c, d})` from the Param model.
 *
 * `maxParams` bounds the list for a listing that identifies declarations rather
 * than describing them: an injected class can take dozens of constructor
 * parameters, and one such signature outweighs a whole page of matches. The
 * elision is explicit and the full list is one `get_symbol` call away.
 */
export function paramListText(params: Param[], maxParams?: number): string {
  const shown =
    maxParams !== undefined && params.length > maxParams ? params.slice(0, maxParams) : params;
  const positional = shown.filter((p) => !p.named && p.required);
  const optional = shown.filter((p) => !p.named && !p.required);
  const named = shown.filter((p) => p.named);
  const one = (p: Param): string => (p.type ? `${p.type} ${p.name}` : p.name);

  const parts = positional.map(one);
  if (optional.length > 0) parts.push(`[${optional.map(one).join(', ')}]`);
  if (named.length > 0) {
    parts.push(`{${named.map((p) => (p.required ? `required ${one(p)}` : one(p))).join(', ')}}`);
  }
  if (shown.length < params.length) parts.push(`… +${String(params.length - shown.length)} more`);
  return `(${parts.join(', ')})`;
}

/** Rendering limits for a signature; omitted fields mean "render in full". */
export interface SignatureOptions {
  /** Parameters to print before eliding the rest (see `paramListText`). */
  maxParams?: number;
}

/**
 * One-line declaration header, reconstructed from the model:
 *   `abstract class UserBloc<E> extends Bloc<UserEvent, UserState> with M implements D`
 *   `Future<void> load(String id, [int depth]) async`
 */
export function signatureText(sym: Symbol, options: SignatureOptions = {}): string {
  const parts: string[] = [];
  const containerKinds = ['class', 'mixin', 'enum', 'extension', 'extensionType', 'typedef'];

  if (containerKinds.includes(sym.kind)) {
    if (sym.modifiers.length > 0) parts.push(sym.modifiers.join(' '));
    parts.push(sym.kind === 'extensionType' ? 'extension type' : sym.kind);
    let name = sym.name;
    if (sym.typeParameters) name += `<${sym.typeParameters.join(', ')}>`;
    parts.push(name);
    if (sym.extendsType) parts.push(`extends ${typeRefText(sym.extendsType)}`);
    if (sym.mixesIn) parts.push(`with ${sym.mixesIn.map(typeRefText).join(', ')}`);
    if (sym.implementsTypes) {
      parts.push(`implements ${sym.implementsTypes.map(typeRefText).join(', ')}`);
    }
    return parts.join(' ');
  }

  const modifiers = sym.modifiers.filter((m) => !['async', 'async*', 'sync*'].includes(m));
  if (modifiers.length > 0) parts.push(modifiers.join(' '));
  if (sym.returnType) parts.push(sym.returnType);
  if (sym.kind === 'getter') parts.push(`get ${sym.name}`);
  else if (sym.kind === 'setter') parts.push(`set ${sym.name.replace(/=$/, '')}`);
  else {
    let name = sym.name;
    // Named constructors drop the class name (`fromJson` vs `User.fromJson`);
    // restore it from the qualified name so the signature reads like Dart source.
    // The default constructor's name already equals the class — leave it alone.
    if (sym.kind === 'constructor') {
      const segments = sym.qualifiedName.split('.');
      const className = segments[segments.length - 2];
      if (className && className !== sym.name) name = `${className}.${name}`;
    }
    if (sym.typeParameters) name += `<${sym.typeParameters.join(', ')}>`;
    parts.push(name);
  }
  if (sym.parameters) {
    const last = parts.length - 1;
    parts[last] = `${parts[last] ?? ''}${paramListText(sym.parameters, options.maxParams)}`;
  } else if (['method', 'function', 'constructor', 'setter'].includes(sym.kind)) {
    const last = parts.length - 1;
    parts[last] = `${parts[last] ?? ''}()`;
  }
  return parts.join(' ');
}

export function annotationsText(sym: Symbol): string {
  return sym.annotations
    .map((a) => (a.args !== undefined ? `@${a.name}(${a.args})` : `@${a.name}`))
    .join(' ');
}

/**
 * Hard size cap (§6: ~4000 tokens default). Truncates with an explicit,
 * actionable notice — never silently.
 */
export function capLines(lines: string[], maxLines: number, narrowHint: string): string[] {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept.push(`… ${String(lines.length - maxLines)} more — ${narrowHint}`);
  return kept;
}

/**
 * Size cap in characters, the unit a response is actually paid for. A line cap
 * cannot bound a response: a line carrying two absolute paths costs an order of
 * magnitude more than a one-word line, so a body of 200 wide lines outweighs
 * 250 narrow ones. Applied alongside `capLines`, whichever binds first.
 *
 * The kept prefix is whole lines, and the notice states how many were dropped
 * and how to ask for a narrower response — truncation is never silent (§6).
 */
export function capChars(lines: string[], maxChars: number, narrowHint: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += line.length + 1; // the newline this line contributes when joined
    if (used > maxChars) {
      kept.push(`… ${String(lines.length - kept.length)} more — ${narrowHint}`);
      return kept;
    }
    kept.push(line);
  }
  return kept;
}

/**
 * States the convention `FileScope` produces for responses that elide to a bare
 * `:120`. A response that anchors on declaration names instead (`FileScope` with
 * a label) needs no note: `UserBloc:120` names its own referent.
 */
export const BARE_LINE_NOTE =
  'A location written `:120` is a line in the last file named above it.';

/**
 * How much of a whole-repo answer to render.
 *
 * `summary` reports shape — counts and where things are declared — so a caller
 * that does not yet know what to narrow to can orient in a few hundred tokens.
 * `normal` renders every fact within a character budget. `full` renders the same
 * facts with the budget lifted, for a caller that accepts the cost; it is not a
 * different set of facts, because `normal` aggregates rather than truncates.
 */
export type Verbosity = 'summary' | 'normal' | 'full';

export const VERBOSITY_VALUES = ['summary', 'normal', 'full'] as const;

export const VERBOSITY_DESCRIPTION =
  'How much to render: "summary" for shape and counts only (cheapest — start here ' +
  'on an unfamiliar repo), "normal" (default) for full detail within a size budget, ' +
  '"full" for the same detail with the budget lifted.';

/** Size limits for a response body, in both units a body can overrun. */
export interface BodyLimits {
  maxLines: number;
  maxChars: number;
  /** How the caller can ask for less, quoted in any truncation notice. */
  narrowHint: string;
}

/**
 * Applies both caps to a response body: the line cap always, the character
 * budget unless the caller asked for `full`. Truncation is explicit in either
 * case (see `capLines` / `capChars`).
 */
export function capBody(lines: string[], limits: BodyLimits, verbosity: Verbosity): string[] {
  const capped = capLines(lines, limits.maxLines, limits.narrowHint);
  return verbosity === 'full' ? capped : capChars(capped, limits.maxChars, limits.narrowHint);
}

/**
 * The file a block of response lines is written against, so locations inside it
 * cost a line number instead of repeating the path.
 *
 * Repeated paths dominate a whole-repo response: a route graph of 215 routes
 * declared across 8 files spends half its characters reprinting those 8 paths,
 * and a bloc's dependency list repeats the bloc's own path once per dependency.
 * Referring to lines of an already-named file is the convention `get_symbol` and
 * `get_widget_tree` already use for the members of one declaration, and it drops
 * no fact — but the referent has to be unmistakable, which needs one of two
 * forms:
 *
 * - **Unlabelled** (`:120`) for a block whose lines each carry one location, so
 *   the last path named above a bare reference is always its file — the rule
 *   `BARE_LINE_NOTE` states.
 * - **Labelled** (`UserBloc:120`) for a block whose lines carry two locations,
 *   where the last path above a bare reference could be the wrong one. The label
 *   is the declaration the response already printed with its full path, so the
 *   reference resolves by name rather than by position.
 *
 * `ref` never changes the scope, so a line that names a second file — a
 * dependency declared elsewhere, alongside a `via` site in the block's own file —
 * keeps resolving correctly. A renderer that wants run-length behaviour instead
 * (each line establishing the scope for the next) calls `enter` explicitly.
 */
export class FileScope {
  private current: string | undefined;
  private label: string | undefined;

  constructor(file?: string, label?: string) {
    this.current = file;
    this.label = label;
  }

  /** `file:line` outside this scope; `label:line` or `:line` inside it. */
  ref(file: string, line: number): string {
    if (file !== this.current) return `${file}:${String(line)}`;
    return `${this.label ?? ''}:${String(line)}`;
  }

  /** Makes `file` the scope for subsequent `ref` calls, under an optional label. */
  enter(file: string, label?: string): void {
    this.current = file;
    this.label = label;
  }
}

/** Wraps tool handler output; catches handler errors per §9.4 (never throw raw). */
export function textResult(text: string): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}
