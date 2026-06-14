/**
 * Indexer: orchestrates walk → hash-check vs cache → parse → extract → index
 * (TECHNICAL_DESIGN.md §4.2). The only module that touches both the parser
 * and the index — extraction itself stays pure.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initParser, parseText } from '../parser/parser.js';
import { extractSymbols } from '../extractors/symbol-extractor.js';
import { extractImports } from '../extractors/import-extractor.js';
import { extractWidgets } from '../extractors/widget-extractor.js';
import { extractBlocs } from '../extractors/bloc-extractor.js';
import { extractProviders } from '../extractors/riverpod-extractor.js';
import { extractRoutes } from '../extractors/route-extractor.js';
import { extractStringConsts } from '../extractors/string-const-extractor.js';
import { ProjectIndex, type FileEntry } from './project-index.js';
import { isGeneratedFile, packageForFile, walkWorkspace, type PackageEntry } from './workspace.js';
import { loadCache, saveCache } from './cache.js';
import { logger } from '../shared/logger.js';

/** A file that could not be read or parsed at all (Tier A) — skipped, not indexed. */
export interface IndexFailure {
  file: string;
  error: string;
}

export interface IndexStats {
  fileCount: number;
  parsedCount: number;
  cachedCount: number;
  failedCount: number;
  packageCount: number;
  elapsedMs: number;
  /** Paths+reasons of the `failedCount` files that were skipped entirely. */
  failures: IndexFailure[];
}

export async function buildIndex(
  root: string,
): Promise<{ index: ProjectIndex; stats: IndexStats }> {
  const started = performance.now();
  await initParser();

  const [{ dartFiles, packages }, cache] = await Promise.all([
    walkWorkspace(root),
    loadCache(root),
  ]);

  const index = new ProjectIndex();
  index.packages = packages;

  let parsedCount = 0;
  let cachedCount = 0;
  const failures: IndexFailure[] = [];

  for (const relPath of dartFiles) {
    const result = await indexFile(root, relPath, packages, cache, failures);
    if (!result) continue;
    index.setFile(result.entry);
    if (result.fromCache) cachedCount++;
    else parsedCount++;
  }

  await saveCache(root, index.files);

  const stats: IndexStats = {
    fileCount: index.files.size,
    parsedCount,
    cachedCount,
    failedCount: failures.length,
    packageCount: packages.length,
    elapsedMs: Math.round(performance.now() - started),
    failures,
  };
  logger.info('index built', { ...stats });
  return { index, stats };
}

/** Result of indexing one file: the entry plus whether it came from the cache. */
export interface IndexedFile {
  entry: FileEntry;
  fromCache: boolean;
}

/**
 * Index a single file: read → hash → (cache hit?) → parse → extract → FileEntry.
 * The shared unit of work for both the cold walk and the Phase 4 watcher. Returns
 * null on any read/parse failure — logged to stderr and skipped, never thrown
 * (§9.4): one bad file must not abort the index or kill the watcher.
 *
 * Pass `cache` to short-circuit unchanged files by content hash (cold start);
 * omit it to force a re-parse (a watcher event means the file just changed).
 */
export async function indexFile(
  root: string,
  relPath: string,
  packages: PackageEntry[],
  cache?: Map<string, FileEntry>,
  failures?: IndexFailure[],
): Promise<IndexedFile | null> {
  let text: string;
  try {
    text = await readFile(join(root, relPath), 'utf8');
  } catch (err) {
    logger.warn('file unreadable, skipped', { file: relPath, error: String(err) });
    failures?.push({ file: relPath, error: `unreadable: ${String(err)}` });
    return null;
  }
  const contentHash = createHash('sha1').update(text).digest('hex');

  const cached = cache?.get(relPath);
  if (cached && cached.contentHash === contentHash) {
    // Package membership is recomputed: pubspecs may have moved since caching.
    const entry: FileEntry = { ...cached };
    delete entry.package;
    const pkg = packageForFile(relPath, packages);
    if (pkg) entry.package = pkg;
    return { entry, fromCache: true };
  }

  try {
    return { entry: indexFileText(relPath, text, contentHash, packages), fromCache: false };
  } catch (err) {
    logger.warn('parse/extract failed, skipped', { file: relPath, error: String(err) });
    failures?.push({ file: relPath, error: `parse/extract: ${String(err)}` });
    return null;
  }
}

function indexFileText(
  relPath: string,
  text: string,
  contentHash: string,
  packages: PackageEntry[],
): FileEntry {
  const tree = parseText(text);
  const { symbols, parseErrors } = extractSymbols(tree, relPath);
  const imports = extractImports(tree);
  const widgets = extractWidgets(tree, relPath);
  const { blocs, edges: blocEdges } = extractBlocs(tree, relPath);
  const { providers, edges: providerEdges } = extractProviders(tree, relPath);
  const { routes, dynamic: dynamicRoutes } = extractRoutes(tree, relPath);
  const stringConsts = extractStringConsts(tree);
  tree.delete(); // wasm-side memory is manual; the Symbol model owns the data now
  const entry: FileEntry = {
    path: relPath,
    contentHash,
    generated: isGeneratedFile(relPath),
    symbols,
    imports,
    widgets,
    blocs,
    providers,
    routes,
    dynamicRoutes,
    edges: [...blocEdges, ...providerEdges],
    stringConsts,
    parseErrors,
  };
  const pkg = packageForFile(relPath, packages);
  if (pkg) entry.package = pkg;
  return entry;
}
