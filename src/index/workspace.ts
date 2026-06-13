/**
 * Workspace walker: finds every .dart file and pubspec.yaml under a root,
 * honoring .gitignore files at every directory level (TECHNICAL_DESIGN.md §8
 * Phase 2). Knows nothing about parsing or symbols — pure file discovery.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { logger } from '../shared/logger.js';

export interface PackageEntry {
  /** `name:` from pubspec.yaml. */
  name: string;
  /** Workspace-relative directory ('' for the root package). */
  path: string;
}

export interface WorkspaceListing {
  /** Workspace-relative paths of all non-ignored .dart files, sorted. */
  dartFiles: string[];
  /** One entry per pubspec.yaml found (monorepo = many). */
  packages: PackageEntry[];
}

/**
 * Reusable include test for a single workspace-relative path, sharing the exact
 * ignore rules `walkWorkspace` walks with (HARD_SKIP_DIRS + nested .gitignore
 * scopes + the .dart filter). The watcher (Phase 4) consults this per filesystem
 * event so it indexes precisely the same set of files a cold walk would.
 */
export interface WorkspaceFilter {
  shouldIndex(relPath: string): boolean;
}

/** Generated-code marker per §7.4: parse but exclude from default responses. */
export function isGeneratedFile(relPath: string): boolean {
  return /\.(g|freezed|gr)\.dart$/.test(relPath);
}

/** Deepest package whose directory contains the file, or undefined. */
export function packageForFile(relPath: string, packages: PackageEntry[]): string | undefined {
  let best: PackageEntry | undefined;
  for (const pkg of packages) {
    const inPkg = pkg.path === '' || relPath.startsWith(pkg.path + sep);
    if (inPkg && (best === undefined || pkg.path.length > best.path.length)) best = pkg;
  }
  return best?.name;
}

interface IgnoreScope {
  /** Workspace-relative dir the .gitignore lives in ('' = root). */
  base: string;
  matcher: Ignore;
}

// Never descended into regardless of .gitignore: VCS internals, our own cache,
// and pub/build output that is gitignored in any sane repo but costs a stat to learn.
const HARD_SKIP_DIRS = new Set(['.git', '.flutter-intel', '.dart_tool', 'build', 'node_modules']);

export async function walkWorkspace(root: string): Promise<WorkspaceListing> {
  const dartFiles: string[] = [];
  const packages: PackageEntry[] = [];
  await walkDir(root, root, [], dartFiles, packages);
  dartFiles.sort();
  packages.sort((a, b) => a.path.localeCompare(b.path));
  return { dartFiles, packages };
}

function isIgnored(relPath: string, scopes: IgnoreScope[], isDir: boolean): boolean {
  for (const scope of scopes) {
    const local = scope.base === '' ? relPath : relative(scope.base, relPath);
    // ignore() matches POSIX paths; trailing slash makes dir-only patterns work.
    const posix = local.split(sep).join('/');
    if (scope.matcher.ignores(isDir ? `${posix}/` : posix)) return true;
  }
  return false;
}

/**
 * If `dir` holds a .gitignore, return `scopes` extended with its matcher;
 * otherwise return `scopes` unchanged. Shared by the cold walk and the
 * Phase 4 filter so both honor the exact same per-directory ignore rules.
 */
async function appendGitignoreScope(
  dir: string,
  relDir: string,
  scopes: IgnoreScope[],
  hasGitignore: boolean,
): Promise<IgnoreScope[]> {
  if (!hasGitignore) return scopes;
  try {
    const patterns = await readFile(join(dir, '.gitignore'), 'utf8');
    return [...scopes, { base: relDir === '' ? '' : relDir, matcher: ignore().add(patterns) }];
  } catch (err) {
    logger.warn('.gitignore unreadable, ignored', { dir: relDir, error: String(err) });
    return scopes;
  }
}

async function walkDir(
  dir: string,
  root: string,
  scopes: IgnoreScope[],
  dartFiles: string[],
  packages: PackageEntry[],
): Promise<void> {
  const relDir = relative(root, dir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn('unreadable directory skipped', { dir: relDir, error: String(err) });
    return;
  }

  const hasGitignore = entries.some((e) => e.isFile() && e.name === '.gitignore');
  const localScopes = await appendGitignoreScope(dir, relDir, scopes, hasGitignore);

  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : join(relDir, entry.name);

    if (entry.isDirectory()) {
      if (HARD_SKIP_DIRS.has(entry.name)) continue;
      if (isIgnored(relPath, localScopes, true)) continue;
      // Symlinked dirs are skipped: cycle risk outweighs the rare legit use.
      await walkDir(join(dir, entry.name), root, localScopes, dartFiles, packages);
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name === 'pubspec.yaml') {
      const name = await readPubspecName(join(dir, entry.name));
      if (name) packages.push({ name, path: relDir });
      continue;
    }
    if (!entry.name.endsWith('.dart')) continue;
    if (isIgnored(relPath, localScopes, false)) continue;
    dartFiles.push(relPath);
  }
}

/**
 * Walk the tree once collecting every applicable .gitignore scope (skipping
 * HARD_SKIP_DIRS and ignored subtrees), so a path can later be tested without
 * re-reading .gitignores per event. Built at watcher start; rebuilt on a full
 * re-scan (a changed .gitignore / pubspec.yaml triggers one — Phase 4).
 */
async function collectIgnoreScopes(
  dir: string,
  root: string,
  scopes: IgnoreScope[],
  out: IgnoreScope[],
): Promise<void> {
  const relDir = relative(root, dir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn('unreadable directory skipped', { dir: relDir, error: String(err) });
    return;
  }

  const hasGitignore = entries.some((e) => e.isFile() && e.name === '.gitignore');
  const localScopes = await appendGitignoreScope(dir, relDir, scopes, hasGitignore);
  const added =
    localScopes.length > scopes.length ? localScopes[localScopes.length - 1] : undefined;
  if (added) out.push(added);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (HARD_SKIP_DIRS.has(entry.name)) continue;
    const relPath = relDir === '' ? entry.name : join(relDir, entry.name);
    if (isIgnored(relPath, localScopes, true)) continue;
    await collectIgnoreScopes(join(dir, entry.name), root, localScopes, out);
  }
}

/**
 * Build a reusable include test mirroring walkWorkspace's selection: .dart only,
 * never inside a HARD_SKIP_DIR, never matched by an applicable .gitignore.
 * (Cross-file `!negation` ordering is not modeled — an extreme edge a cold walk
 * resolves by descent order; if it ever bites, a changed .gitignore forces a
 * full re-scan anyway.)
 */
export async function createWorkspaceFilter(root: string): Promise<WorkspaceFilter> {
  const scopes: IgnoreScope[] = [];
  await collectIgnoreScopes(root, root, [], scopes);
  return {
    shouldIndex(relPath: string): boolean {
      if (!relPath.endsWith('.dart')) return false;
      if (relPath.split(sep).some((seg) => HARD_SKIP_DIRS.has(seg))) return false;
      const applicable = scopes.filter(
        (sc) => sc.base === '' || relPath === sc.base || relPath.startsWith(sc.base + sep),
      );
      return !isIgnored(relPath, applicable, false);
    },
  };
}

/**
 * `name:` from a pubspec. A one-line scan, not a YAML parser — package names
 * are plain identifiers in practice; revisit only on a real failing repo.
 */
async function readPubspecName(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const match = /^name:\s*(\S+)\s*$/m.exec(text);
    return match?.[1]?.replace(/^['"]|['"]$/g, '');
  } catch (err) {
    logger.warn('pubspec unreadable, package skipped', { path, error: String(err) });
    return undefined;
  }
}
