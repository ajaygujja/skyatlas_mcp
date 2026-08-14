/**
 * JSON disk cache, content-hash keyed (TECHNICAL_DESIGN.md §5.3): warm starts
 * re-parse only changed files. Lives at .skyatlas/cache.json inside the
 * workspace (gitignored; never leaves the machine, §9.7).
 *
 * A cache is an optimization, never a correctness dependency: any read or
 * version mismatch degrades to a cold start.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileEntry } from './project-index.js';
import { logger } from '../shared/logger.js';

// Bump whenever FileEntry/Symbol serialization changes shape.
// v2: FileEntry.widgets added (Phase 3a).
// v3: FileEntry.blocs + FileEntry.edges added (Phase 3b).
// v4: FileEntry.providers added; edges now include watchesProvider (Phase 3c).
// v5: FileEntry.routes + dynamicRoutes added (Phase 3d).
// v6: FileEntry.stringConsts added; RouteInfo gains pathExpr/isShell (path-const resolution).
// v7: FileEntry.routerGuards added; RouteInfo gains shellWidget/redirectTo (route-graph polish).
// v8: FileEntry.routeTables added; RouteInfo gains spread (static route-table mounts).
// v9: widget-extractor non-layout slot fix (ISSUE-1 Layer A) changes namedSlots
//     content (listener/create/etc. no longer scanned) for already-cached files;
//     shape is unchanged but stale entries would silently keep the old bug.
const CACHE_VERSION = 9;

interface CacheFile {
  version: number;
  files: Record<string, FileEntry>;
}

function cachePath(root: string): string {
  return join(root, '.skyatlas', 'cache.json');
}

export async function loadCache(root: string): Promise<Map<string, FileEntry>> {
  try {
    const raw = await readFile(cachePath(root), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION) {
      logger.info('cache version mismatch, cold start', {
        found: parsed.version,
        expected: CACHE_VERSION,
      });
      return new Map();
    }
    return new Map(Object.entries(parsed.files));
  } catch {
    return new Map(); // no cache / unreadable / corrupt JSON → cold start
  }
}

export async function saveCache(root: string, files: Map<string, FileEntry>): Promise<void> {
  const payload: CacheFile = { version: CACHE_VERSION, files: Object.fromEntries(files) };
  const path = cachePath(root);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload), 'utf8');
  } catch (err) {
    logger.warn('cache write failed — next start will be cold', { error: String(err) });
  }
}
