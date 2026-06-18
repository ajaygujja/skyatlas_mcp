/**
 * Shared symbol resolution: a bare name → its concrete declaration.
 *
 * The single place a name becomes a Symbol, so wiring, route-table, and future
 * resolvers agree on the same pick. Resolution is SYNTACTIC (Working Rule 8): a
 * name either matches a declared symbol or it does not — types are never
 * inferred. When several declarations share a name the choice is deterministic
 * (lowest symbol id) so output is stable across runs; a caller's imports may
 * bias that tie toward the declaration it actually pulls in.
 */
import { posix } from 'node:path';
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

/** Caller context for resolution; only consulted to break a duplicate-name tie. */
export interface ResolveOpts {
  /** File whose `import` directives bias which same-named declaration wins. */
  fromFile?: string;
}

/** A class/mixin/etc declaration matching `name`, deterministic across duplicates. */
export function resolveClass(
  index: ProjectIndex,
  name: string,
  opts?: ResolveOpts,
): Symbol | undefined {
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
  if (containers.length <= 1) return containers[0] ?? fallback;
  containers.sort((a, b) => a.id.localeCompare(b.id));
  // Several classes share the name: prefer the one the caller actually imports,
  // so a chain links into the local feature rather than a same-named class
  // elsewhere. With no caller or no matching import the lowest-id pick stands —
  // the choice is never inferred, only biased by a written directive.
  const fromFile = opts?.fromFile;
  if (fromFile !== undefined) {
    const imported = containers.find((c) => callerImports(index, fromFile, c.file));
    if (imported) return imported;
  }
  return containers[0];
}

/** Whether `fromFile`'s import directives name the file declaring a candidate. */
function callerImports(index: ProjectIndex, fromFile: string, candidateFile: string): boolean {
  const entry = index.files.get(fromFile);
  if (!entry) return false;
  for (const imp of entry.imports) {
    if (imp.kind !== 'import' || imp.uri.startsWith('dart:')) continue;
    if (imp.uri.startsWith('package:')) {
      // `package:<pkg>/<tail>` maps to `<pkg root>/lib/<tail>`; the tail carries
      // the sub-path, so a suffix match identifies the file without the layout.
      const tail = imp.uri.slice('package:'.length).split('/').slice(1).join('/');
      if (tail && (candidateFile === tail || candidateFile.endsWith('/' + tail))) return true;
    } else if (candidateFile === posix.normalize(posix.join(posix.dirname(fromFile), imp.uri))) {
      // Relative URI resolved against the importing file's directory.
      return true;
    }
  }
  return false;
}
