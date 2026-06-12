/**
 * Detected-stack summary for get_project_map: which state-management,
 * router, and codegen packages the repo actually imports, with file counts.
 * Pure index-data scan — syntactic, like everything else here.
 */
import type { ProjectIndex } from './project-index.js';

export interface StackHit {
  /** Display label, e.g. "Bloc", "go_router". */
  label: string;
  category: 'state' | 'router' | 'codegen' | 'di';
  /** Number of files importing any of the marker packages. */
  fileCount: number;
}

const MARKERS: { label: string; category: StackHit['category']; packages: string[] }[] = [
  { label: 'Bloc', category: 'state', packages: ['flutter_bloc', 'bloc'] },
  {
    label: 'Riverpod',
    category: 'state',
    packages: ['flutter_riverpod', 'hooks_riverpod', 'riverpod'],
  },
  { label: 'Provider', category: 'state', packages: ['provider'] },
  { label: 'GetX', category: 'state', packages: ['get'] },
  { label: 'MobX', category: 'state', packages: ['mobx', 'flutter_mobx'] },
  { label: 'go_router', category: 'router', packages: ['go_router'] },
  { label: 'auto_route', category: 'router', packages: ['auto_route'] },
  { label: 'freezed', category: 'codegen', packages: ['freezed_annotation'] },
  { label: 'json_serializable', category: 'codegen', packages: ['json_annotation'] },
  { label: 'riverpod_generator', category: 'codegen', packages: ['riverpod_annotation'] },
  { label: 'get_it', category: 'di', packages: ['get_it'] },
  { label: 'injectable', category: 'di', packages: ['injectable'] },
];

/** Package name from "package:foo/bar.dart", or undefined for dart:/relative URIs. */
function importedPackage(uri: string): string | undefined {
  const match = /^package:([^/]+)\//.exec(uri);
  return match?.[1];
}

export function detectStack(index: ProjectIndex): StackHit[] {
  const fileCounts = new Map<string, number>();
  for (const file of index.files.values()) {
    const pkgs = new Set<string>();
    for (const imp of file.imports) {
      const pkg = importedPackage(imp.uri);
      if (pkg) pkgs.add(pkg);
    }
    for (const pkg of pkgs) fileCounts.set(pkg, (fileCounts.get(pkg) ?? 0) + 1);
  }

  const hits: StackHit[] = [];
  for (const marker of MARKERS) {
    const count = marker.packages.reduce((n, p) => n + (fileCounts.get(p) ?? 0), 0);
    if (count > 0) hits.push({ label: marker.label, category: marker.category, fileCount: count });
  }
  return hits;
}
