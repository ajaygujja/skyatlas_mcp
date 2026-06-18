/**
 * Shared symbol resolution: a bare name → its concrete declaration.
 *
 * The single place a name becomes a Symbol, so wiring, route-table, and future
 * resolvers agree on the same pick. Resolution is SYNTACTIC (Working Rule 8): a
 * name either matches a declared symbol or it does not — types are never
 * inferred. When several declarations share a name the choice is deterministic
 * (lowest symbol id) so output is stable across runs; import-biased
 * disambiguation hangs off this seam later.
 */
import type { ProjectIndex } from './project-index.js';
import type { Symbol, SymbolKind } from '../model/symbol.js';

/** Container declarations a bare name can resolve to. */
export const CONTAINER_KINDS = new Set<SymbolKind>([
  'class',
  'mixin',
  'enum',
  'extension',
  'extensionType',
]);

/** A class/mixin/etc declaration matching `name`, deterministic across duplicates. */
export function resolveClass(index: ProjectIndex, name: string): Symbol | undefined {
  const ids = index.byName.get(name);
  if (!ids) return undefined;
  const containers: Symbol[] = [];
  let fallback: Symbol | undefined;
  for (const id of ids) {
    const sym = index.symbolsById.get(id);
    if (!sym) continue;
    if (CONTAINER_KINDS.has(sym.kind)) containers.push(sym);
    else fallback ??= sym;
  }
  containers.sort((a, b) => a.id.localeCompare(b.id));
  return containers[0] ?? fallback;
}
