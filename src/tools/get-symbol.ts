/**
 * get_symbol — one declaration in depth (TECHNICAL_DESIGN.md §6): header,
 * type params, super types, annotations, doc, member list. Edges land in
 * Phase 3.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { Symbol } from '../model/symbol.js';
import {
  annotationsText,
  capBody,
  errorResult,
  fileLine,
  signatureText,
  textResult,
  type BodyLimits,
} from './format.js';

/**
 * Size limits for the member list. A member count alone does not bound the
 * section: one dependency-injected constructor can carry a signature wider than
 * eighty ordinary members put together.
 */
const MEMBER_LIMITS: BodyLimits = {
  maxLines: 80,
  maxChars: 12_000,
  narrowHint: 'fetch a member directly via get_symbol id=',
};

export function registerGetSymbol(server: McpServer, getIndex: () => Promise<ProjectIndex>): void {
  server.registerTool(
    'get_symbol',
    {
      title: 'Get symbol',
      description:
        'Full detail for ONE declaration: signature, extends/implements/with, annotations, ' +
        'doc, and its member list with file:line for each. Use after find_symbol (pass the id) ' +
        'or directly with an exact name. Answers "what is inside class X" in one call.',
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('Stable symbol id from a previous result, e.g. "lib/a.dart#UserBloc".'),
        name: z
          .string()
          .optional()
          .describe('Exact name or qualified name, e.g. "UserBloc" or "UserBloc.add".'),
        includeChildren: z.boolean().optional().describe('List members (default true).'),
      },
    },
    async ({ id, name, includeChildren }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      if (!id && !name) return errorResult('Provide id or name.');

      let sym: Symbol | undefined;
      if (id) {
        sym = index.symbolsById.get(id);
        if (!sym) return errorResult(`No symbol with id '${id}'. Ids come from find_symbol.`);
      } else if (name) {
        let exact = index
          .findByName(name.includes('.') ? (name.split('.').pop() ?? name) : name)
          .filter((s) => s.name === name || s.qualifiedName === name);
        // A bare class name also matches its default constructor
        // (`UserBloc` → `UserBloc.UserBloc`); the top-level declaration is
        // what the caller means — nested hits only count when nothing
        // top-level matches.
        const topLevel = exact.filter((s) => s.qualifiedName === name);
        if (topLevel.length > 0) exact = topLevel;
        if (exact.length === 0) {
          const near = index.findByName(name).slice(0, 5);
          const hint =
            near.length > 0
              ? ` Close matches: ${near.map((s) => s.qualifiedName).join(', ')}. Try find_symbol.`
              : ' Try find_symbol with a fragment.';
          return textResult(`No symbol named '${name}'.${hint}`);
        }
        if (exact.length > 1) {
          const lines = exact
            .slice(0, 10)
            .map((s) => `- ${s.kind} ${s.qualifiedName} — ${fileLine(s)} · id: ${s.id}`);
          return textResult(
            `'${name}' is ambiguous (${String(exact.length)} declarations). Call again with id:\n` +
              lines.join('\n'),
          );
        }
        sym = exact[0];
      }
      if (!sym) return errorResult('Symbol resolution failed.');

      return textResult(formatSymbol(sym, index, includeChildren ?? true).join('\n'));
    },
  );
}

function formatSymbol(sym: Symbol, index: ProjectIndex, includeChildren: boolean): string[] {
  const lines: string[] = [];
  lines.push(
    `# ${sym.kind} ${sym.qualifiedName} — ${sym.file}:${String(sym.range.startLine)}-${String(sym.range.endLine)}`,
  );
  lines.push(signatureText(sym));
  const ann = annotationsText(sym);
  if (ann) lines.push(ann);
  if (sym.doc) lines.push(`/// ${sym.doc}`);
  lines.push(`id: ${sym.id}`);

  if (sym.parentId) {
    const parent = index.symbolsById.get(sym.parentId);
    if (parent) lines.push(`Parent: ${parent.kind} ${parent.qualifiedName} — ${fileLine(parent)}`);
  }

  const file = index.files.get(sym.file);
  if (file?.generated) lines.push('Note: declared in a GENERATED file.');

  if (includeChildren && sym.children.length > 0) {
    lines.push('');
    lines.push(`Members (${String(sym.children.length)}):`);
    const memberLines = sym.children.map((c) => {
      const ann = annotationsText(c);
      return `- ${c.kind} ${signatureText(c)} — :${String(c.range.startLine)}${ann ? ` · ${ann}` : ''}`;
    });
    lines.push(...capBody(memberLines, MEMBER_LIMITS, 'normal'));
  }
  return lines;
}
