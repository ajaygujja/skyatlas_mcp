/**
 * find_symbol — name search across the whole repo (TECHNICAL_DESIGN.md §6).
 * One dense line per match: kind, qualified name, signature, file:line.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { Symbol } from '../model/symbol.js';
import {
  annotationsText,
  capLines,
  errorResult,
  fileLine,
  signatureText,
  textResult,
} from './format.js';

const SYMBOL_KINDS = [
  'class',
  'mixin',
  'enum',
  'extension',
  'extensionType',
  'function',
  'method',
  'getter',
  'setter',
  'constructor',
  'field',
  'typedef',
] as const;

const MAX_RESULTS = 50;

export function registerFindSymbol(server: McpServer, getIndex: () => Promise<ProjectIndex>): void {
  server.registerTool(
    'find_symbol',
    {
      title: 'Find symbol',
      description:
        'Find Dart declarations by name across the whole repo (classes, methods, functions, ' +
        'fields, …). Case-insensitive; exact matches rank first, then prefix, then substring. ' +
        'Use this INSTEAD of grep when looking for where something is declared. ' +
        'Generated files (*.g.dart etc.) are excluded unless includeGenerated=true.',
      inputSchema: {
        query: z.string().describe('Name or name fragment, e.g. "UserBloc" or "user".'),
        kind: z.enum(SYMBOL_KINDS).optional().describe('Restrict to one symbol kind.'),
        package: z.string().optional().describe('Restrict to one package (pubspec name).'),
        includeGenerated: z
          .boolean()
          .optional()
          .describe('Also search *.g.dart / *.freezed.dart / *.gr.dart files.'),
      },
    },
    async ({ query, kind, package: pkg, includeGenerated }) => {
      // Schema permits any string so the empty case yields a friendly hint
      // rather than a raw Zod min-length validation error at the SDK layer.
      if (query.trim().length === 0) {
        return textResult('Provide a name or fragment to search for, e.g. "UserBloc" or "user".');
      }

      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      const opts: Parameters<ProjectIndex['findByName']>[1] = {};
      if (kind) opts.kind = kind;
      if (pkg) opts.pkg = pkg;
      if (includeGenerated !== undefined) opts.includeGenerated = includeGenerated;
      const matches = index.findByName(query, opts);

      if (matches.length === 0) {
        const filters = [kind && `kind=${kind}`, pkg && `package=${pkg}`]
          .filter(Boolean)
          .join(', ');
        const unfiltered = filters ? index.findByName(query).length : 0;
        const hint =
          unfiltered > 0
            ? ` ${String(unfiltered)} match(es) exist without the ${filters} filter — drop or change it.`
            : ' Try a shorter fragment, or get_project_map to see what exists.';
        return textResult(
          `No symbols matching '${query}'${filters ? ` (${filters})` : ''}.${hint}`,
        );
      }

      const lines = matches.map(formatMatch);
      lines.unshift(
        `${String(matches.length)} match(es) for '${query}'` +
          `${kind ? ` kind=${kind}` : ''}${pkg ? ` package=${pkg}` : ''}:`,
      );
      return textResult(
        capLines(lines, MAX_RESULTS + 1, 'narrow with kind= or package=').join('\n'),
      );
    },
  );
}

function formatMatch(sym: Symbol): string {
  const ann = annotationsText(sym);
  return (
    `- ${sym.kind} ${sym.qualifiedName} — ${fileLine(sym)}` +
    ` · ${signatureText(sym)}${ann ? ` · ${ann}` : ''}${sym.doc ? ` · /// ${sym.doc}` : ''}`
  );
}
