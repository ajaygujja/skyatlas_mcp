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

  let localScopes = scopes;
  if (entries.some((e) => e.isFile() && e.name === '.gitignore')) {
    try {
      const patterns = await readFile(join(dir, '.gitignore'), 'utf8');
      localScopes = [
        ...scopes,
        { base: relDir === '' ? '' : relDir, matcher: ignore().add(patterns) },
      ];
    } catch (err) {
      logger.warn('.gitignore unreadable, ignored', { dir: relDir, error: String(err) });
    }
  }

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
