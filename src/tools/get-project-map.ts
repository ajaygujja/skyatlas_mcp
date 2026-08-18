/**
 * get_project_map — the "read this first" tool (TECHNICAL_DESIGN.md §6):
 * packages, folder layout, symbol counts by kind, detected stack, index health.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import { detectStack } from '../index/stack-detect.js';
import type { Symbol, SymbolKind } from '../model/symbol.js';
import { capBody, errorResult, textResult, type BodyLimits } from './format.js';

/**
 * Path segments a folder listing starts at. Two segments describe a small
 * package; a package keeping most of its files under one of them describes
 * nothing, which is what `chooseDepth` deepens past.
 */
const MIN_FOLDER_DEPTH = 2;

/**
 * Deepest folder listing produced without being asked. Past four segments a
 * feature-first layout repeats its internal layers (`data`, `domain`,
 * `presentation`) once per feature, which multiplies rows without naming
 * anything the caller did not already know.
 */
const MAX_FOLDER_DEPTH = 4;

/**
 * Share of a package's files under one folder that makes the listing
 * uninformative, and so triggers a deeper one.
 */
const DOMINANT_FOLDER_SHARE = 0.4;

/**
 * Size limits for one package's folder listing. Applied per package so a large
 * package cannot consume the budget of the ones rendered after it.
 */
const FOLDER_LIMITS: BodyLimits = {
  maxLines: 60,
  maxChars: 3_000,
  narrowHint: 'use package= to narrow, or depth= for a shallower listing',
};

export function registerGetProjectMap(
  server: McpServer,
  getIndex: () => Promise<ProjectIndex>,
): void {
  server.registerTool(
    'get_project_map',
    {
      title: 'Project map',
      description:
        'Repo overview for a Flutter workspace: packages, folder layout, symbol counts, ' +
        'detected stack (state management, router, codegen), index health. ' +
        'Call this FIRST in a session, before grepping or opening files, to orient in the codebase. ' +
        'Folder rows go as deep as each package needs to describe itself, so a feature-first ' +
        'app lists its features; pass depth= for a shallower or deeper listing, package= for one package.',
      inputSchema: {
        package: z
          .string()
          .optional()
          .describe('Limit the map to one package (name from the packages list).'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_FOLDER_DEPTH)
          .optional()
          .describe(
            'Path segments per folder row (1-4). Omit to let each package choose: ' +
              'a package holding most of its files under one folder is listed one level ' +
              'deeper, so the first call names features rather than the folder above them.',
          ),
      },
    },
    async ({ package: pkg, depth }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      if (pkg && !index.packages.some((p) => p.name === pkg)) {
        const known = index.packages.map((p) => p.name).join(', ');
        return errorResult(`Unknown package '${pkg}'. Known packages: ${known || '(none)'}.`);
      }

      const files = [...index.files.values()].filter((f) => !pkg || f.package === pkg);
      const generated = files.filter((f) => f.generated).length;

      const kindCounts = new Map<SymbolKind, number>();
      let symbolCount = 0;
      for (const file of files) {
        for (const sym of walkAll(file.symbols)) {
          symbolCount++;
          kindCounts.set(sym.kind, (kindCounts.get(sym.kind) ?? 0) + 1);
        }
      }

      const lines: string[] = [];
      lines.push(
        `# Project map${pkg ? ` — package ${pkg}` : ''}: ` +
          `${String(index.packages.length)} package(s), ${String(files.length)} Dart files ` +
          `(${String(generated)} generated), ${String(symbolCount)} symbols`,
      );

      const errFiles = files.filter((f) => f.parseErrors.length > 0);
      lines.push(
        errFiles.length === 0
          ? 'Index health: all files parsed clean'
          : `Index health: ${String(errFiles.length)} file(s) with syntax errors — ` +
              `extraction continued past them: ${errFiles
                .slice(0, 5)
                .map((f) => f.path)
                .join(', ')}${errFiles.length > 5 ? ', …' : ''}`,
      );

      const stack = detectStack(index);
      lines.push(
        stack.length > 0
          ? `Detected stack: ${stack
              .map((s) => `${s.label} [${s.category}] (${String(s.fileCount)} files)`)
              .join(' · ')}`
          : 'Detected stack: none of the known state-management/router/codegen packages imported',
      );

      const kinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]);
      lines.push(`Symbols by kind: ${kinds.map(([k, n]) => `${k} ${String(n)}`).join(' · ')}`);

      for (const entry of index.packages) {
        if (pkg && entry.name !== pkg) continue;
        const pkgFiles = files.filter((f) => f.package === entry.name);
        lines.push('');
        const layout = packageFolders(pkgFiles, entry.path, depth);
        lines.push(
          `## ${entry.name} — ${entry.path === '' ? '(workspace root)' : entry.path}` +
            (layout.depth === undefined ? '' : ` (folders at depth ${String(layout.depth)})`),
        );
        lines.push(...layout.rows);
      }

      return textResult(lines.join('\n'));
    },
  );
}

function* walkAll(symbols: Symbol[]): Generator<Symbol> {
  for (const s of symbols) {
    yield s;
    yield* walkAll(s.children);
  }
}

/**
 * A package's folder rows and the segment depth they are grouped at. The depth
 * is stated in the response because it varies per package and is chosen from
 * the package's own layout, so a caller reading two packages side by side can
 * tell a shallow listing from a deep one — and knows the `depth=` argument that
 * reproduces or overrides it. It is absent for a package holding no Dart files,
 * which has no layout to describe.
 */
interface PackageLayout {
  rows: string[];
  depth?: number;
}

/**
 * One package's folder listing: hand-written files grouped by folder, then a
 * single row for the generated ones.
 *
 * Generated files are grouped separately rather than by folder because a
 * codegen tree mirrors the tree it is generated from (§7.4): listing both
 * doubles the rows and names no folder the hand-written listing does not
 * already name. Their count stays in the response, so the rows still account
 * for every file the header counts.
 */
function packageFolders(
  files: { path: string; generated: boolean }[],
  pkgPath: string,
  depth: number | undefined,
): PackageLayout {
  if (files.length === 0) return { rows: ['- (no Dart files)'] };

  const authored = files.filter((f) => !f.generated);
  const generated = files.length - authored.length;
  const chosen = depth ?? chooseDepth(authored, pkgPath);
  const rows = folderCounts(authored, pkgPath, chosen).map(
    ([folder, n]) => `- ${folder}: ${String(n)} file(s)`,
  );
  if (generated > 0) {
    rows.push(
      `- (generated): ${String(generated)} file(s) — *.g.dart / *.freezed.dart / *.gr.dart`,
    );
  }
  return { rows: capBody(rows, FOLDER_LIMITS, 'normal'), depth: chosen };
}

/**
 * Segment count at which this package's folders describe where its code lives.
 *
 * A listing exists to tell a caller who does not yet know the repo what it
 * holds, and a row covering most of the package tells them nothing — a
 * feature-first Flutter app keeps four fifths of its files under `lib/features`,
 * so two segments name the convention instead of the features. Deepening stops
 * as soon as no folder dominates, at `MAX_FOLDER_DEPTH`, or when the deeper
 * grouping does not split the package further, which is what bounds a flat
 * package to the shallow listing that already describes it.
 *
 * The choice depends only on the indexed paths, so the same workspace always
 * renders at the same depth.
 */
function chooseDepth(files: { path: string }[], pkgPath: string): number {
  let depth = MIN_FOLDER_DEPTH;
  let counts = folderCounts(files, pkgPath, depth);
  while (depth < MAX_FOLDER_DEPTH && dominantShare(counts, files.length) > DOMINANT_FOLDER_SHARE) {
    const deeper = folderCounts(files, pkgPath, depth + 1);
    if (deeper.length === counts.length) break;
    depth++;
    counts = deeper;
  }
  return depth;
}

/** Share of the package held by its largest folder; 0 when there are no files. */
function dominantShare(counts: [string, number][], total: number): number {
  if (total === 0) return 0;
  return Math.max(...counts.map(([, n]) => n)) / total;
}

/** Files grouped by their first `depth` path segments below the package root. */
function folderCounts(
  files: { path: string }[],
  pkgPath: string,
  depth: number,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const rel = pkgPath === '' ? file.path : file.path.slice(pkgPath.length + 1);
    const folder = rel.split('/').slice(0, -1).slice(0, depth).join('/') || '(root)';
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
