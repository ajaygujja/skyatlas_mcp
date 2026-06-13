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
import { ProjectIndex, type FileEntry } from './project-index.js';
import { isGeneratedFile, packageForFile, walkWorkspace } from './workspace.js';
import { loadCache, saveCache } from './cache.js';
import { logger } from '../shared/logger.js';

export interface IndexStats {
  fileCount: number;
  parsedCount: number;
  cachedCount: number;
  failedCount: number;
  packageCount: number;
  elapsedMs: number;
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
  let failedCount = 0;

  for (const relPath of dartFiles) {
    let text: string;
    try {
      text = await readFile(join(root, relPath), 'utf8');
    } catch (err) {
      // Per-file failures are data, not exceptions (§9.4).
      logger.warn('file unreadable, skipped', { file: relPath, error: String(err) });
      failedCount++;
      continue;
    }
    const contentHash = createHash('sha1').update(text).digest('hex');

    const cached = cache.get(relPath);
    if (cached && cached.contentHash === contentHash) {
      // Package membership is recomputed: pubspecs may have moved since caching.
      const entry: FileEntry = { ...cached };
      delete entry.package;
      const pkg = packageForFile(relPath, packages);
      if (pkg) entry.package = pkg;
      index.setFile(entry);
      cachedCount++;
      continue;
    }

    index.setFile(indexFileText(relPath, text, contentHash, packages));
    parsedCount++;
  }

  await saveCache(root, index.files);

  const stats: IndexStats = {
    fileCount: index.files.size,
    parsedCount,
    cachedCount,
    failedCount,
    packageCount: packages.length,
    elapsedMs: Math.round(performance.now() - started),
  };
  logger.info('index built', { ...stats });
  return { index, stats };
}

function indexFileText(
  relPath: string,
  text: string,
  contentHash: string,
  packages: { name: string; path: string }[],
): FileEntry {
  const tree = parseText(text);
  const { symbols, parseErrors } = extractSymbols(tree, relPath);
  const imports = extractImports(tree);
  const widgets = extractWidgets(tree, relPath);
  const { blocs, edges: blocEdges } = extractBlocs(tree, relPath);
  const { providers, edges: providerEdges } = extractProviders(tree, relPath);
  const { routes, dynamic: dynamicRoutes } = extractRoutes(tree, relPath);
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
    parseErrors,
  };
  const pkg = packageForFile(relPath, packages);
  if (pkg) entry.package = pkg;
  return entry;
}
