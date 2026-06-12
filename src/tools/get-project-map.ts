/**
 * get_project_map — the "read this first" tool (TECHNICAL_DESIGN.md §6):
 * packages, folder layout, symbol counts by kind, detected stack, index health.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import { detectStack } from '../index/stack-detect.js';
import type { Symbol, SymbolKind } from '../model/symbol.js';
import { capLines, errorResult, textResult } from './format.js';

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
        'Call this FIRST in a session, before grepping or opening files, to orient in the codebase.',
      inputSchema: {
        package: z
          .string()
          .optional()
          .describe('Limit the map to one package (name from the packages list).'),
      },
    },
    async ({ package: pkg }) => {
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
        lines.push(`## ${entry.name} — ${entry.path === '' ? '(workspace root)' : entry.path}`);
        const folders = folderCounts(pkgFiles, entry.path);
        const folderLines = folders.map(([folder, n]) => `- ${folder}: ${String(n)} file(s)`);
        lines.push(...capLines(folderLines, 25, 'use package= to narrow'));
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

/** Files grouped by their first two path segments below the package root. */
function folderCounts(
  files: { path: string; package?: string }[],
  pkgPath: string,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const rel = pkgPath === '' ? file.path : file.path.slice(pkgPath.length + 1);
    const folder = rel.split('/').slice(0, -1).slice(0, 2).join('/') || '(root)';
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
