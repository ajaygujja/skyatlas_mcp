/**
 * find_state_wiring — the state-management connection map (TECHNICAL_DESIGN.md
 * §6, Phase 3e). Given exactly one of screen / bloc / provider, shows the
 * connection chain screen → bloc/provider → repository, each edge with file:line
 * and confidence.
 *
 * Layer boundary (Working Rule 6): all resolution lives in src/index/wiring.ts;
 * this tool only calls computeWiring and formats. No tree-sitter here.
 *
 * Honesty (Working Rule 8): connections are syntactic name-matches, never type
 * resolution; an unresolved target is labeled, never invented. Empty results
 * explain themselves and point at the detected stack (§6 rule 5).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import {
  computeWiring,
  type Loc,
  type RepoDep,
  type SourceGroup,
  type TargetGroup,
  type WireRef,
  type WiringFilter,
  type WiringResult,
} from '../index/wiring.js';
import { capLines, errorResult, textResult } from './format.js';

const MAX_LINES = 250;
const MAX_DEPTH = 8;

export function registerFindStateWiring(
  server: McpServer,
  getIndex: () => Promise<ProjectIndex>,
): void {
  server.registerTool(
    'find_state_wiring',
    {
      title: 'Find state wiring',
      description:
        'State-management connections for a Flutter feature: the chain screen → ' +
        'bloc/provider → repository, each edge with file:line and confidence. Pass ' +
        'EXACTLY ONE of screen=, bloc=, or provider=. Answers "which Bloc/provider ' +
        'serves screen X", "which screens use bloc Y", "what repository does bloc Z ' +
        'depend on". Connections are syntactic name-matches (not type-resolved); an ' +
        'unresolved or unwired subject is reported honestly, never guessed.',
      inputSchema: {
        screen: z.string().optional().describe('Screen/widget class name, e.g. "SettingsScreen".'),
        bloc: z.string().optional().describe('Bloc/Cubit class name, e.g. "UserBloc".'),
        provider: z
          .string()
          .optional()
          .describe('Riverpod provider name, e.g. "settingsProvider".'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .optional()
          .describe(
            'Dependency hops to follow from a bloc (default 1). Raise to cross a ' +
              'clean-arch chain bloc → usecase → repository → datasource.',
          ),
      },
    },
    async ({ screen, bloc, provider, depth }) => {
      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      const filter = pickFilter({ screen, bloc, provider });
      if (!filter) {
        return errorResult(
          'Provide exactly one of screen=, bloc=, or provider=. ' +
            'Use get_project_map to see the detected state-management stack.',
        );
      }

      const result = computeWiring(index, filter, depth);
      return textResult(formatWiring(result).join('\n'));
    },
  );
}

function pickFilter(args: {
  screen?: string | undefined;
  bloc?: string | undefined;
  provider?: string | undefined;
}): WiringFilter | undefined {
  const present: WiringFilter[] = [];
  if (args.screen) present.push({ kind: 'screen', name: args.screen });
  if (args.bloc) present.push({ kind: 'bloc', name: args.bloc });
  if (args.provider) present.push({ kind: 'provider', name: args.provider });
  return present.length === 1 ? present[0] : undefined;
}

const SYNTACTIC_FOOTER = 'Connections are syntactic name-matches, not type-resolved.';

function formatWiring(result: WiringResult): string[] {
  switch (result.filter) {
    case 'screen':
      return formatScreen(result);
    case 'bloc':
      return formatBloc(result);
    case 'provider':
      return formatProvider(result);
  }
}

// ── screen ──────────────────────────────────────────────────────────────────

function formatScreen(r: WiringResult): string[] {
  if (!r.found) {
    return [
      `No screen/widget named '${r.query}' in the index. find_state_wiring resolves a ` +
        `screen by class name. Try find_symbol to locate it, or get_project_map for the ` +
        `detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [`# State wiring: screen '${r.query}'${declSuffix(r.subject?.decl)}`];
  if (r.subject) lines.push(`Subject: ${r.subject.label}`);
  for (const route of r.routes) {
    const name = route.name ? ` (${route.name})` : '';
    lines.push(`Reachable via route: ${route.label}${name} — ${loc(route.loc)}`);
  }
  lines.push('');

  if (r.targets.length === 0) {
    lines.push(emptyScreenWiring(r));
    return lines;
  }

  const body: string[] = [];
  for (const group of r.targets) renderTarget(group, body);
  lines.push(...capLines(trimTrailingBlanks(body), MAX_LINES, 'narrow with a different filter'));
  lines.push('');
  lines.push(SYNTACTIC_FOOTER);
  return lines;
}

function renderTarget(group: TargetGroup, out: string[]): void {
  out.push(`→ ${targetHeader(group)}`);
  for (const ref of group.via) out.push(`    ${wireRefLine(ref)}`);
  for (const repo of group.repos) {
    out.push(`${'    '.repeat(repo.depth)}${depCore(repo)} (via ${loc(repo.via)}, syntactic)`);
  }
  out.push('');
}

function targetHeader(group: TargetGroup): string {
  const t = group.target;
  if (t.kind === 'unknown') return `${t.name} (unresolved — no matching declaration in the index)`;
  const where = t.decl ? ` — ${loc(t.decl)}` : '';
  return `${t.name} (${t.kind})${where}`;
}

// ── bloc ──────────────────────────────────────────────────────────────────

function formatBloc(r: WiringResult): string[] {
  if (!r.found) {
    const note = r.subject
      ? `'${r.query}' is a ${r.subject.label}${declSuffix(r.subject.decl)} — it does not extend a ` +
        `*Bloc/*Cubit base.`
      : `No Bloc/Cubit named '${r.query}' in the index.`;
    return [
      `${note} Try find_symbol, or get_project_map for the detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [
    `# State wiring: ${r.subject?.label ?? 'bloc'} '${r.query}'${declSuffix(r.subject?.decl)}`,
  ];
  lines.push('');

  if (r.sources.length === 0) {
    lines.push(
      `No screen wires to '${r.query}' (no BlocProvider create / context.read / BlocBuilder ` +
        `references it in the index).`,
    );
  } else {
    lines.push(`Wired from ${String(r.sources.length)} source(s):`);
    const body: string[] = [];
    for (const source of r.sources) renderSource(source, body);
    lines.push(...capLines(trimTrailingBlanks(body), MAX_LINES, 'narrow with a different filter'));
  }

  lines.push('');
  if (r.repos.length === 0) {
    lines.push(
      'Repositories: none resolved (no constructor-param/field type matches a class in the index).',
    );
  } else {
    lines.push('Repositories (constructor/field deps, syntactic):');
    for (const repo of r.repos) {
      const indent = '  '.repeat(repo.depth - 1);
      const bullet = repo.depth === 1 ? '- ' : '↳ ';
      lines.push(`${indent}${bullet}${depCore(repo)} (via ${loc(repo.via)})`);
    }
  }

  lines.push('');
  lines.push(SYNTACTIC_FOOTER);
  return lines;
}

// ── provider ────────────────────────────────────────────────────────────────

function formatProvider(r: WiringResult): string[] {
  if (!r.found) {
    return [
      `No provider named '${r.query}' in the index. find_state_wiring resolves a Riverpod ` +
        `provider by name. Try find_symbol, or get_project_map for the detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [
    `# State wiring: provider '${r.query}' (${r.subject?.label ?? 'provider'})${declSuffix(r.subject?.decl)}`,
  ];
  lines.push('');

  if (r.sources.length === 0) {
    lines.push(
      `No screen watches '${r.query}' (no ref.watch/read/listen references it in the index).`,
    );
  } else {
    lines.push(`Wired from ${String(r.sources.length)} source(s):`);
    const body: string[] = [];
    for (const source of r.sources) renderSource(source, body);
    lines.push(...capLines(trimTrailingBlanks(body), MAX_LINES, 'narrow with a different filter'));
  }

  lines.push('');
  lines.push(SYNTACTIC_FOOTER);
  return lines;
}

// ── shared ──────────────────────────────────────────────────────────────────

function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

function renderSource(source: SourceGroup, out: string[]): void {
  const companion = source.screen ? ` (State of ${source.screen})` : '';
  const where = source.decl ? ` — ${loc(source.decl)}` : '';
  out.push(`← ${source.name}${companion}${where}`);
  for (const ref of source.via) out.push(`    ${wireRefLine(ref)}`);
  out.push('');
}

function wireRefLine(ref: WireRef): string {
  return `${ref.kind} · ${loc(ref.callSite)} (${ref.confidence})`;
}

/** `<role> <member>: <Type>[ → <Impl> loc] — <decl>`; the impl note appears when an
 * interface dependency was followed into its concrete class to continue the chain. */
function depCore(repo: RepoDep): string {
  const impl = repo.impl ? ` → ${repo.impl.typeName} ${loc(repo.impl.decl)}` : '';
  return `${repo.role} ${repo.member}: ${repo.typeName}${impl} — ${loc(repo.decl)}`;
}

/** §6 rule 5: explain absence and point at the other filter via the detected stack. */
function emptyScreenWiring(r: WiringResult): string {
  const subjectNote = r.subject ? ` (a ${r.subject.label})` : '';
  const detected =
    r.stateLabels.length > 0
      ? ` Detected state mgmt in this repo: ${r.stateLabels.join(', ')}.`
      : '';
  const suggest = suggestOtherFilter(r.stateLabels);
  return (
    `No Bloc or provider found wiring to '${r.query}'${subjectNote}.${detected} ` +
    `${suggest} Or get_widget_tree to see what it builds.`
  );
}

function suggestOtherFilter(stateLabels: string[]): string {
  const hasBloc = stateLabels.includes('Bloc');
  const hasRiverpod = stateLabels.includes('Riverpod');
  if (hasRiverpod && !hasBloc) return 'Try find_state_wiring with provider=.';
  if (hasBloc && !hasRiverpod) return 'Try find_state_wiring with bloc=.';
  return 'Try find_state_wiring with bloc= or provider=.';
}

function stackSuffix(stateLabels: string[]): string {
  return stateLabels.length > 0 ? ` (state mgmt: ${stateLabels.join(', ')})` : '';
}

function declSuffix(decl: Loc | undefined): string {
  return decl ? ` — ${loc(decl)}` : '';
}

function loc(l: Loc): string {
  return `${l.file}:${String(l.line)}`;
}
