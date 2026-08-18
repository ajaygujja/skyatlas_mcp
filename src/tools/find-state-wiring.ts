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
import type { EdgeConfidence, EdgeKind } from '../model/flutter.js';
import {
  computeWiring,
  type CoverageGap,
  type Loc,
  type RepoDep,
  type ResolvedTarget,
  type SourceGroup,
  type SubjectInfo,
  type TargetGroup,
  type WireRef,
  type WiringFilter,
  type WiringResult,
} from '../index/wiring.js';
import {
  capBody,
  errorResult,
  FileScope,
  indexedResult,
  VERBOSITY_DESCRIPTION,
  VERBOSITY_VALUES,
  type BodyLimits,
  type Verbosity,
} from './format.js';

const MAX_DEPTH = 8;

/**
 * Size limits for the wiring body. The character budget (~3,000 tokens) is the
 * binding one: wiring width comes from the subject's dependency count, and one
 * dependency line carries a member, a type, a declaration site and a call site.
 */
const BODY_LIMITS: BodyLimits = {
  maxLines: 250,
  maxChars: 12_000,
  narrowHint: 'narrow with a different filter or verbosity="summary"',
};

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
        'unresolved or unwired subject is reported honestly, never guessed. ' +
        'For a wide subject start with verbosity="summary": it names every wired ' +
        'bloc/provider with its site and dependency counts, then expand what matters.',
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
        verbosity: z.enum(VERBOSITY_VALUES).optional().describe(VERBOSITY_DESCRIPTION),
      },
    },
    async ({ screen, bloc, provider, depth, verbosity }) => {
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
      return indexedResult(formatWiring(result, verbosity ?? 'normal'), index);
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

/**
 * The honesty guarantee (Working Rule 8) stated once per response. Every edge
 * carries the same `syntactic` confidence, so labelling each line individually
 * repeats one fact hundreds of times; a line whose confidence is anything else
 * is labelled inline (see `wireGroupLine`), which keeps the guarantee exact.
 */
const SYNTACTIC_FOOTER =
  'Connections are syntactic name-matches, not type-resolved, unless a line says otherwise. ' +
  'A location written `Name:120` is a line in the file of that declaration, named in full above.';

function formatWiring(result: WiringResult, verbosity: Verbosity): string[] {
  switch (result.filter) {
    case 'screen':
      return formatScreen(result, verbosity);
    case 'bloc':
      return formatBloc(result, verbosity);
    case 'provider':
      return formatProvider(result, verbosity);
  }
}

/** Points a summary reader at the call that expands it. */
const EXPAND_HINT = 'Pass verbosity="normal" for call sites and dependency chains.';

// ── screen ──────────────────────────────────────────────────────────────────

function formatScreen(r: WiringResult, verbosity: Verbosity): string[] {
  if (!r.found) {
    return [
      `No screen/widget named '${r.query}' in the index. find_state_wiring resolves a ` +
        `screen by class name.${suggestionSuffix(r.suggestions)} Try find_symbol to locate it, or ` +
        `get_project_map for the detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [`# State wiring: screen '${r.query}'${declSuffix(r.subject?.decl)}`];
  if (r.subject) lines.push(`Subject: ${r.subject.label}`);
  for (const route of r.routes) {
    const name = route.name ? ` (${route.name})` : '';
    lines.push(`Reachable via route: ${route.label}${name} — ${loc(route.loc)}`);
  }
  if (r.coverage) lines.push(coverageLine(r.coverage));
  lines.push('');

  if (r.targets.length === 0) {
    lines.push(emptyScreenWiring(r));
    return lines;
  }

  if (verbosity === 'summary') {
    lines.push(`Wires ${String(r.targets.length)} bloc(s)/provider(s):`);
    for (const group of r.targets) lines.push(`  ${targetSummary(group)}`);
    lines.push('');
    lines.push(EXPAND_HINT);
    return lines;
  }

  const body: string[] = [];
  for (const group of r.targets) renderTarget(group, r.subject, body);
  lines.push(...capBody(trimTrailingBlanks(body), BODY_LIMITS, verbosity));
  lines.push('');
  lines.push(SYNTACTIC_FOOTER);
  return lines;
}

/** `Name (kind, 2 sites, 33 deps) — decl`: the shape of a target without its detail. */
function targetSummary(group: TargetGroup): string {
  const t = group.target;
  const kind = t.kind === 'unknown' ? 'unresolved' : t.kind;
  const facts = [`${String(group.via.length)} site(s)`];
  if (group.repos.length > 0) facts.push(`${String(group.repos.length)} dep(s)`);
  const where = t.decl ? ` — ${loc(t.decl)}` : '';
  return `${t.name} (${kind}, ${facts.join(', ')})${where}`;
}

/**
 * One bloc/provider block: the target, the call sites that reach it, then its
 * dependency chain. The target's own file scopes the block, so its dependencies'
 * `via` sites — all declared on the target — cost a line number each.
 */
function renderTarget(group: TargetGroup, subject: SubjectInfo | undefined, out: string[]): void {
  // Two anchors: the call sites sit in the screen, the dependencies on the target.
  const sites = new FileScope(subject?.decl?.file, subject?.name);
  const target = group.target;
  out.push(`→ ${targetHeader(target)}`);
  for (const wires of groupRefs(group.via)) out.push(`    ${wireGroupLine(wires, sites)}`);
  renderDeps(
    group.repos,
    anchorOf(target.name, target.decl),
    (repo) => '    '.repeat(repo.depth),
    out,
  );
  out.push('');
}

function targetHeader(target: ResolvedTarget): string {
  if (target.kind === 'unknown') {
    return `${target.name} (unresolved — no matching declaration in the index)`;
  }
  const where = target.decl ? ` — ${loc(target.decl)}` : '';
  return `${target.name} (${target.kind})${where}`;
}

// ── bloc ──────────────────────────────────────────────────────────────────

function formatBloc(r: WiringResult, verbosity: Verbosity): string[] {
  if (!r.found) {
    const note = r.subject
      ? `'${r.query}' is a ${r.subject.label}${declSuffix(r.subject.decl)} — it does not extend a ` +
        `*Bloc/*Cubit base.`
      : `No Bloc/Cubit named '${r.query}' in the index.`;
    return [
      `${note}${suggestionSuffix(r.suggestions)} Try find_symbol, or get_project_map for the ` +
        `detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [
    `# State wiring: ${r.subject?.label ?? 'bloc'} '${r.query}'${declSuffix(r.subject?.decl)}`,
  ];
  if (r.coverage) lines.push(coverageLine(r.coverage));
  lines.push('');

  if (r.sources.length === 0) {
    lines.push(
      `No screen wires to '${r.query}' (no BlocProvider create / context.read / BlocBuilder ` +
        `references it in the index).`,
    );
  } else if (verbosity === 'summary') {
    lines.push(`Wired from ${String(r.sources.length)} source(s):`);
    for (const source of r.sources) lines.push(`  ${sourceSummary(source)}`);
  } else {
    lines.push(`Wired from ${String(r.sources.length)} source(s):`);
    const body: string[] = [];
    for (const source of r.sources) renderSource(source, body);
    lines.push(...capBody(trimTrailingBlanks(body), BODY_LIMITS, verbosity));
  }

  lines.push('');
  if (r.repos.length === 0) {
    lines.push(
      'Repositories: none resolved (no constructor-param/field type matches a class in the index).',
    );
  } else if (verbosity === 'summary') {
    lines.push(`Dependencies: ${String(r.repos.length)} — ${depRoleCounts(r.repos)}`);
    lines.push('');
    lines.push(EXPAND_HINT);
    return lines;
  } else {
    lines.push('Repositories (constructor/field deps):');
    // Capped in its own right: a deep walk makes this section, not the source
    // list, the widest part of the response.
    const deps: string[] = [];
    renderDeps(
      r.repos,
      anchorOf(r.subject?.name ?? r.query, r.subject?.decl),
      (repo) => `${'  '.repeat(repo.depth - 1)}${repo.depth === 1 ? '- ' : '↳ '}`,
      deps,
    );
    lines.push(...capBody(deps, BODY_LIMITS, verbosity));
  }

  lines.push('');
  lines.push(verbosity === 'summary' ? EXPAND_HINT : SYNTACTIC_FOOTER);
  return lines;
}

/** `usecase 12, repo 3`: what the dependency chain holds, without listing it. */
function depRoleCounts(repos: RepoDep[]): string {
  const counts = new Map<string, number>();
  for (const repo of repos) counts.set(repo.role, (counts.get(repo.role) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, n]) => `${role} ${String(n)}`)
    .join(', ');
}

/** `Name (State of Screen) (3 sites) — decl`: a source without its call sites. */
function sourceSummary(source: SourceGroup): string {
  const companion = source.screen ? ` (State of ${source.screen})` : '';
  const where = source.decl ? ` — ${loc(source.decl)}` : '';
  return `${source.name}${companion} (${String(source.via.length)} site(s))${where}`;
}

// ── provider ────────────────────────────────────────────────────────────────

function formatProvider(r: WiringResult, verbosity: Verbosity): string[] {
  if (!r.found) {
    return [
      `No provider named '${r.query}' in the index. find_state_wiring resolves a Riverpod ` +
        `provider by name.${suggestionSuffix(r.suggestions)} Try find_symbol, or get_project_map ` +
        `for the detected stack${stackSuffix(r.stateLabels)}.`,
    ];
  }

  const lines = [
    `# State wiring: provider '${r.query}' (${r.subject?.label ?? 'provider'})${declSuffix(r.subject?.decl)}`,
  ];
  if (r.coverage) lines.push(coverageLine(r.coverage));
  lines.push('');

  if (r.sources.length === 0) {
    lines.push(
      `No screen watches '${r.query}' (no ref.watch/read/listen references it in the index).`,
    );
  } else {
    lines.push(`Wired from ${String(r.sources.length)} source(s):`);
    if (verbosity === 'summary') {
      for (const source of r.sources) lines.push(`  ${sourceSummary(source)}`);
    } else {
      const body: string[] = [];
      for (const source of r.sources) renderSource(source, body);
      lines.push(...capBody(trimTrailingBlanks(body), BODY_LIMITS, verbosity));
    }
  }

  lines.push('');
  lines.push(verbosity === 'summary' ? EXPAND_HINT : SYNTACTIC_FOOTER);
  return lines;
}

// ── shared ──────────────────────────────────────────────────────────────────

function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

/**
 * One source block: the class that wires into the subject, then its call sites.
 * The source's file scopes the block, since a class reads a bloc from its own
 * body — the common case collapses to a list of line numbers.
 */
function renderSource(source: SourceGroup, out: string[]): void {
  const companion = source.screen ? ` (State of ${source.screen})` : '';
  const where = source.decl ? ` — ${loc(source.decl)}` : '';
  out.push(`← ${source.name}${companion}${where}`);
  const scope = new FileScope(source.decl?.file, source.name);
  for (const wires of groupRefs(source.via)) out.push(`    ${wireGroupLine(wires, scope)}`);
  out.push('');
}

/** Call sites of one edge kind in one file, at the same confidence. */
interface WireGroup {
  kind: EdgeKind;
  file: string;
  confidence: EdgeConfidence;
  lines: number[];
}

/**
 * Collapses call sites that differ only by line into one group. A widget that
 * reads the same bloc from fourteen places in one file states one fact, and
 * printing it fourteen times costs fourteen paths to say it. Groups keep the
 * order the index emitted them in, with line numbers ascending inside a group,
 * so the rendering is deterministic across runs.
 */
function groupRefs(refs: WireRef[]): WireGroup[] {
  const groups = new Map<string, WireGroup>();
  for (const ref of refs) {
    const key = `${ref.kind}|${ref.callSite.file}|${ref.confidence}`;
    const group = groups.get(key);
    if (group) group.lines.push(ref.callSite.line);
    else {
      groups.set(key, {
        kind: ref.kind,
        file: ref.callSite.file,
        confidence: ref.confidence,
        lines: [ref.callSite.line],
      });
    }
  }
  for (const group of groups.values()) group.lines.sort((a, b) => a - b);
  return [...groups.values()];
}

/**
 * `kind · file:12,48,90  (3 sites)`. The site count is stated because it is the
 * fact a caller acts on; `SYNTACTIC_FOOTER` covers the confidence, so only a
 * confidence other than syntactic is labelled here.
 */
function wireGroupLine(group: WireGroup, scope: FileScope): string {
  const first = group.lines[0] ?? 0;
  const rest = group.lines.slice(1);
  const sites =
    rest.length > 0 ? `,${rest.map(String).join(',')}  (${String(group.lines.length)} sites)` : '';
  const confidence = group.confidence === 'syntactic' ? '' : ` (${group.confidence})`;
  return `${group.kind} · ${scope.ref(group.file, first)}${sites}${confidence}`;
}

/**
 * Renders a dependency chain, indented by `indentFor`. Each hop's `via` site is
 * declared on the class the previous hop resolved to — the queried bloc for hop
 * 1 — so the chain is rendered against a per-hop file scope and a `via` in the
 * declaring class costs a line number rather than a second path.
 */
function renderDeps(
  repos: RepoDep[],
  owner: FileScope,
  indentFor: (repo: RepoDep) => string,
  out: string[],
): void {
  const hops = new Map<number, FileScope>([[1, owner]]);
  for (const repo of repos) {
    const scope = hops.get(repo.depth) ?? owner;
    out.push(`${indentFor(repo)}${depCore(repo, scope)}`);
    // An interface followed into its implementor declares the next hop's members.
    const next = repo.impl ?? repo;
    const nextName = repo.impl ? repo.impl.typeName : repo.typeName;
    hops.set(repo.depth + 1, new FileScope(next.decl.file, nextName));
  }
}

/** Anchor for locations inside a named declaration's file. */
function anchorOf(name: string, decl: Loc | undefined): FileScope {
  return new FileScope(decl?.file, name);
}

/** `<role> <member>: <Type>[ → <Impl> loc] — <decl> (via <site>)`; the impl note appears
 * when an interface dependency was followed into its concrete class to continue the chain. */
function depCore(repo: RepoDep, scope: FileScope): string {
  const impl = repo.impl
    ? ` → ${repo.impl.typeName} ${scope.ref(repo.impl.decl.file, repo.impl.decl.line)}`
    : '';
  const decl = scope.ref(repo.decl.file, repo.decl.line);
  return `${repo.role} ${repo.member}: ${repo.typeName}${impl} — ${decl} (via ${scope.ref(repo.via.file, repo.via.line)})`;
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

/**
 * `Did you mean: A, B?` — the names of the right kind closest to a query that
 * resolved to nothing, so a misremembered name costs one call rather than a
 * search. Empty when the index holds nothing similar enough to name.
 */
function suggestionSuffix(suggestions: string[]): string {
  return suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
}

/**
 * States an extraction gap in the subject's file. An absence reported from a
 * file the grammar could not fully parse is not evidence of absence in the code,
 * and only this note distinguishes the two.
 */
function coverageLine(gap: CoverageGap): string {
  return (
    `Note: ${gap.file} has ${String(gap.parseErrors)} syntax error(s) the grammar could not parse — ` +
    `extraction continued past them, so wiring declared inside those regions is not in the index.`
  );
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
