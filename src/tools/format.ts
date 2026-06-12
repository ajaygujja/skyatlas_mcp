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

/** Reconstructs `(a, [b], {required c, d})` from the Param model. */
export function paramListText(params: Param[]): string {
  const positional = params.filter((p) => !p.named && p.required);
  const optional = params.filter((p) => !p.named && !p.required);
  const named = params.filter((p) => p.named);
  const one = (p: Param): string => (p.type ? `${p.type} ${p.name}` : p.name);

  const parts = positional.map(one);
  if (optional.length > 0) parts.push(`[${optional.map(one).join(', ')}]`);
  if (named.length > 0) {
    parts.push(`{${named.map((p) => (p.required ? `required ${one(p)}` : one(p))).join(', ')}}`);
  }
  return `(${parts.join(', ')})`;
}

/**
 * One-line declaration header, reconstructed from the model:
 *   `abstract class UserBloc<E> extends Bloc<UserEvent, UserState> with M implements D`
 *   `Future<void> load(String id, [int depth]) async`
 */
export function signatureText(sym: Symbol): string {
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
    if (sym.typeParameters) name += `<${sym.typeParameters.join(', ')}>`;
    parts.push(name);
  }
  if (sym.parameters) {
    const last = parts.length - 1;
    parts[last] = `${parts[last] ?? ''}${paramListText(sym.parameters)}`;
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
