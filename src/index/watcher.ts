/**
 * Filesystem watcher: keeps the live index fresh as .dart files are saved,
 * added, or deleted — no server restart (TECHNICAL_DESIGN.md §8 Phase 4, §4.2).
 *
 * Index-layer concern (§4.1, Working Rule 6): it calls the indexer and mutates
 * the ProjectIndex, but imports neither MCP nor tree-sitter. All per-file work
 * goes through `indexFile`, which already logs-and-skips bad files (§9.4), so a
 * single unreadable/unparseable file never kills the watcher or the index.
 */
import { basename, relative, sep } from 'node:path';
import { once } from 'node:events';
import type { Stats } from 'node:fs';
import { watch } from 'chokidar';
import { buildIndex, indexFile } from './indexer.js';
import type { ProjectIndex } from './project-index.js';
import { createWorkspaceFilter, HARD_SKIP_DIRS } from './workspace.js';
import { saveCache } from './cache.js';
import { logger } from '../shared/logger.js';

/** Collect bursts of events before reacting — a single editor save can emit several (§8). */
const DEFAULT_DEBOUNCE_MS = 200;
/** The disk cache is an optimization, not hot-path state: save it lazily, well after the edits settle. */
const DEFAULT_CACHE_SAVE_DEBOUNCE_MS = 2000;
// Decision (§8 mass-change guard): above this many files in one debounced burst,
// a per-file loop is both slower (N×~file-update cost + repeated map churn) and
// incomplete — a branch switch / `git pull` also moves pubspecs and rewrites
// cross-file edges, which only a whole-repo pass reconciles. A full buildIndex
// re-scan reuses the content-hash cache for unchanged files, so it stays cheap.
// 50 sits comfortably above a hand-save (1–few files) yet far below a branch
// switch (typically hundreds), so normal editing always takes the cheap path.
const DEFAULT_MASS_CHANGE_THRESHOLD = 50;

type PendingKind = 'upsert' | 'remove';

/** What one processed batch did — surfaced to tests (await it) and useful for logging. */
export interface BatchSummary {
  upserted: string[];
  removed: string[];
  /** True when the batch fell back to a whole-repo re-scan (mass change / pubspec / .gitignore). */
  fullRescan: boolean;
}

export interface WatcherOptions {
  /** Called after each processed batch. Tests await this instead of sleeping. */
  onBatch?: (summary: BatchSummary) => void;
  debounceMs?: number;
  cacheSaveDebounceMs?: number;
  massChangeThreshold?: number;
  /**
   * Poll instead of relying on native OS events. Off by default (native fsevents/
   * inotify are cheaper). Useful on network filesystems — and in tests, where it
   * makes event delivery deterministic rather than subject to fsevents latency.
   */
  usePolling?: boolean;
  /** Poll interval in ms when `usePolling` is set. */
  pollInterval?: number;
}

export interface WatcherHandle {
  /** Stop watching and flush any pending cache save. */
  close(): Promise<void>;
}

/**
 * Start watching `root`, folding filesystem changes into `index` in place.
 * Resolves once the watcher is armed (initial scan ignored — `index` is already
 * built). Never throws for per-file problems; the caller wraps the whole start
 * so a watcher failure cannot kill the server.
 */
export async function startWatcher(
  root: string,
  index: ProjectIndex,
  opts: WatcherOptions = {},
): Promise<WatcherHandle> {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const cacheSaveDebounceMs = opts.cacheSaveDebounceMs ?? DEFAULT_CACHE_SAVE_DEBOUNCE_MS;
  const threshold = opts.massChangeThreshold ?? DEFAULT_MASS_CHANGE_THRESHOLD;

  // Mirrors walkWorkspace's selection so the watcher indexes exactly the cold-walk
  // set. Rebuilt after a full re-scan: a changed .gitignore can shift what's ignored.
  let filter = await createWorkspaceFilter(root);

  const pending = new Map<string, PendingKind>();
  // A pubspec.yaml (package map) or .gitignore (ignore rules) change can affect
  // many files at once — simplest correct thing is a full re-scan (§8).
  let pendingFullRescan = false;
  let batchTimer: NodeJS.Timeout | undefined;
  let cacheTimer: NodeJS.Timeout | undefined;
  let processing = false;
  let closed = false;

  const watcher = watch(root, {
    ignoreInitial: true,
    // Prune the heavy subtrees (and obvious non-targets) so chokidar never walks
    // node_modules etc. Fine-grained .gitignore/.dart selection happens per event
    // via `filter` — a dir must not be ignored here or chokidar won't recurse it.
    ignored: (p: string, stats?: Stats) => isPruned(root, p, stats),
    ...(opts.usePolling ? { usePolling: true, interval: opts.pollInterval ?? 10 } : {}),
  });

  watcher.on('add', (p) => {
    enqueue(p, 'upsert');
  });
  watcher.on('change', (p) => {
    enqueue(p, 'upsert');
  });
  watcher.on('unlink', (p) => {
    enqueue(p, 'remove');
  });
  // A rename surfaces as unlink(old) + add(new); both are handled above.
  watcher.on('error', (err) => {
    logger.warn('watcher error', { error: String(err) });
  });

  // Resolve only once the initial scan completes — "armed" means it will catch
  // subsequent changes. Lets callers (and tests) act without racing setup.
  await once(watcher, 'ready');

  function enqueue(absPath: string, kind: PendingKind): void {
    const rel = relative(root, absPath);
    if (rel === '' || rel.startsWith('..')) return;
    const base = basename(absPath);
    if (base === 'pubspec.yaml' || base === '.gitignore') {
      pendingFullRescan = true;
    } else {
      pending.set(rel, kind);
    }
    scheduleBatch();
  }

  function scheduleBatch(): void {
    if (closed) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      void runBatch();
    }, debounceMs);
  }

  async function runBatch(): Promise<void> {
    // Never let two batches overlap: defer if one is in flight, re-arm on completion.
    if (processing) {
      scheduleBatch();
      return;
    }
    processing = true;
    try {
      await processBatch();
    } finally {
      processing = false;
      if (!closed && (pending.size > 0 || pendingFullRescan)) scheduleBatch();
    }
  }

  async function processBatch(): Promise<void> {
    const batch = new Map(pending);
    pending.clear();
    const fullRescan = pendingFullRescan || batch.size > threshold;
    pendingFullRescan = false;
    if (batch.size === 0 && !fullRescan) return;

    const summary: BatchSummary = { upserted: [], removed: [], fullRescan };

    if (fullRescan) {
      try {
        const { index: fresh } = await buildIndex(root); // reuses the warm content-hash cache
        index.replaceWith(fresh);
        filter = await createWorkspaceFilter(root);
        summary.upserted = [...index.files.keys()];
        logger.info('watcher full re-scan', { files: index.files.size });
      } catch (err) {
        // Leave the existing index intact; a later edit will retry.
        logger.warn('watcher full re-scan failed, index unchanged', { error: String(err) });
      }
      // buildIndex already persisted the cache — no debounced save needed here.
      opts.onBatch?.(summary);
      return;
    }

    for (const [rel, kind] of batch) {
      try {
        if (kind === 'remove') {
          if (index.files.has(rel)) {
            index.removeFile(rel);
            summary.removed.push(rel);
          }
          continue;
        }
        if (!filter.shouldIndex(rel)) continue; // gitignored / non-.dart that slipped through
        const result = await indexFile(root, rel, index.packages);
        if (result) {
          index.setFile(result.entry);
          summary.upserted.push(rel);
        }
      } catch (err) {
        // indexFile swallows read/parse errors already; this guards setFile/removeFile too.
        logger.warn('watch update failed, file skipped', { file: rel, error: String(err) });
      }
    }

    if (summary.upserted.length > 0 || summary.removed.length > 0) scheduleCacheSave();
    opts.onBatch?.(summary);
  }

  function scheduleCacheSave(): void {
    if (closed) return;
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      cacheTimer = undefined;
      void saveCache(root, index.files); // saveCache logs its own failures (§9.4)
    }, cacheSaveDebounceMs);
  }

  logger.info('watcher started', { root });

  return {
    async close(): Promise<void> {
      closed = true;
      if (batchTimer) clearTimeout(batchTimer);
      // Flush a pending debounced save so the last edits survive a restart.
      if (cacheTimer) {
        clearTimeout(cacheTimer);
        cacheTimer = undefined;
        await saveCache(root, index.files);
      }
      await watcher.close();
    },
  };
}

/**
 * Coarse chokidar prune: drop HARD_SKIP_DIRS subtrees outright, and (when stats
 * say it's a file) anything that isn't .dart / pubspec.yaml / .gitignore. Returns
 * false for directories and for stat-less calls so traversal still reaches real
 * targets — the per-event `filter` makes the precise .dart/.gitignore decision.
 */
function isPruned(root: string, absPath: string, stats?: Stats): boolean {
  const rel = relative(root, absPath);
  if (rel === '' || rel.startsWith('..')) return false; // the watched root itself
  if (rel.split(sep).some((seg) => HARD_SKIP_DIRS.has(seg))) return true;
  if (stats?.isFile()) {
    const base = basename(absPath);
    if (base === 'pubspec.yaml' || base === '.gitignore') return false;
    return !absPath.endsWith('.dart');
  }
  return false;
}
