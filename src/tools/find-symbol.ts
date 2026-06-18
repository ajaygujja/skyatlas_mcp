/**
 * find_symbol — name search across the whole repo (TECHNICAL_DESIGN.md §6).
 * One dense line per match: kind, qualified name, signature, file:line.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { Symbol } from '../model/symbol.js';
import { annotationsText, errorResult, fileLine, signatureText, textResult } from './format.js';

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
        match: z
          .enum(['exact', 'prefix', 'suffix', 'substring', 'regex'])
          .optional()
          .describe(
            'How query matches names (default substring). Use suffix for "ends in X" ' +
              '(e.g. Repository without RepositoryImpl), exact/prefix for anchored names, ' +
              'regex for a custom pattern.',
          ),
        countOnly: z
          .boolean()
          .optional()
          .describe('Return only the match count, skipping the per-symbol listing.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            `Skip this many ranked matches before the page (default 0). Page size is ${String(MAX_RESULTS)}; the response prints the next offset when more remain.`,
          ),
      },
    },
    async ({ query, kind, package: pkg, includeGenerated, match, countOnly, offset }) => {
      // Schema permits any string so the empty case yields a friendly hint
      // rather than a raw Zod min-length validation error at the SDK layer.
      if (query.trim().length === 0) {
        return textResult('Provide a name or fragment to search for, e.g. "UserBloc" or "user".');
      }

      // Validate the pattern here so a bad regex returns a friendly hint instead
      // of throwing out of findByName's compile.
      if (match === 'regex') {
        try {
          new RegExp(query);
        } catch (err) {
          return textResult(`'${query}' is not a valid regex: ${String(err)}`);
        }
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
      if (match) opts.match = match;
      const matches = index.findByName(query, opts);

      if (countOnly) {
        const filterText = `${kind ? ` kind=${kind}` : ''}${pkg ? ` package=${pkg}` : ''}`;
        return textResult(`${String(matches.length)} match(es) for '${query}'${filterText}.`);
      }

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

      const total = matches.length;
      const filterText = `${kind ? ` kind=${kind}` : ''}${pkg ? ` package=${pkg}` : ''}`;
      const start = offset ?? 0;
      if (start >= total) {
        return textResult(
          `offset ${String(start)} is past the end — only ${String(total)} match(es) for '${query}'${filterText}. Use a smaller offset.`,
        );
      }

      const page = matches.slice(start, start + MAX_RESULTS);
      const end = start + page.length; // exclusive index of the last shown match
      const window = total > page.length ? ` (showing ${String(start + 1)}-${String(end)})` : '';
      const lines = [`${String(total)} match(es) for '${query}'${filterText}${window}:`];
      lines.push(...page.map(formatMatch));
      if (end < total) {
        lines.push(
          `… ${String(total - end)} more — pass offset=${String(end)} for the next page, or narrow with kind= / package=.`,
        );
      }
      return textResult(lines.join('\n'));
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
