/**
 * find_references — who uses a name (AI_FIX_SPEC.md §9.1).
 *
 * `find_symbol` answers where something is declared; this answers where it is
 * used, which is the navigation question that otherwise falls back to grep. It is
 * the widest answer the server gives: on a 5,000-file workspace a shared
 * constants class is referenced 6,700 times across 820 files, so the response
 * aggregates per file and falls back to shape when the listing cannot fit a
 * budget — a truncated listing hides the tail, while counts per feature and the
 * widest files describe all of it and name the filters that narrow it.
 *
 * Layer boundary (Working Rule 6): resolution, scoping and aggregation live in
 * src/index/references.ts; this tool formats and bounds the response.
 *
 * Honesty (Working Rule 8): sites are name matches. Where several declarations
 * share the name they are all listed and the sites are not divided among them;
 * where none does, the name is external and that is said.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectIndex } from '../index/project-index.js';
import type { ReferenceKind, ReferenceSite } from '../model/reference.js';
import type { Symbol } from '../model/symbol.js';
import { listFeatures } from '../index/feature-scope.js';
import {
  findReferences,
  referencedNames,
  type FileReferenceGroup,
  type ReferenceReport,
  type ReferenceScope,
} from '../index/references.js';
import { nearestNames } from '../shared/nearest.js';
import {
  BARE_LINE_NOTE,
  capBody,
  errorResult,
  FileScope,
  indexedResult,
  type BodyLimits,
  type Verbosity,
  VERBOSITY_DESCRIPTION,
  VERBOSITY_VALUES,
} from './format.js';

const REFERENCE_KINDS = [
  'typeRef',
  'constructs',
  'annotation',
  'staticAccess',
  'nameRef',
  'calls',
] as const satisfies readonly ReferenceKind[];

/**
 * Size limits for the per-file listing. The character budget is the binding one:
 * a file row carries a path, a count and every line number in that file, so width
 * comes from how concentrated the references are, not from how many rows there are.
 */
const BODY_LIMITS: BodyLimits = {
  maxLines: 250,
  maxChars: 12_000,
  narrowHint: 'narrow with feature=, package= or kind=, or verbosity="summary"',
};

/** Rows in a summary's per-feature and widest-file lines. */
const SUMMARY_ROWS = 15;

/**
 * Declarations named when several share the queried name. Enough to show what
 * kind of collision it is; `find_symbol` is where a caller enumerates them.
 */
const MAX_DECLARATIONS_LISTED = 3;

/** Nearest names quoted back when a query matches nothing. */
const MAX_SUGGESTIONS = 5;

export function registerFindReferences(
  server: McpServer,
  getIndex: () => Promise<ProjectIndex>,
): void {
  server.registerTool(
    'find_references',
    {
      title: 'Find references',
      description:
        'Find where a name is USED across the whole repo — constructed, annotated, ' +
        'named in a type, statically accessed, or called. Use this INSTEAD of grep for ' +
        '"who uses X", "what would break if I change X", "is X dead code". ' +
        'Complements find_symbol, which finds where things are DECLARED. Sites are ' +
        'syntactic name matches, never type-resolved: same-named declarations share ' +
        'their references, and a call is matched by member name without resolving its ' +
        'receiver. A hot name can have thousands of sites — the response aggregates ' +
        'per file and reports shape when a full listing would not fit; narrow with ' +
        'feature=, package= or kind=.',
      inputSchema: {
        name: z
          .string()
          .describe('Exact name as written in the code, e.g. "FormRepository" or "copyWith".'),
        kind: z
          .array(z.enum(REFERENCE_KINDS))
          .optional()
          .describe(
            'Reference kinds to keep: "constructs" for `Name(...)`, "annotation" for ' +
              '`@Name`, "typeRef" for type positions, "staticAccess" for `Name.member`, ' +
              '"calls" for `name(...)`, "nameRef" for a bare mention. All kinds by default.',
          ),
        package: z.string().optional().describe('Only sites in this package (pubspec name).'),
        feature: z
          .string()
          .optional()
          .describe('Only sites in this feature folder (name from get_project_map).'),
        includeGenerated: z
          .boolean()
          .optional()
          .describe('Also count sites in *.g.dart / *.freezed.dart / *.gr.dart files.'),
        verbosity: z.enum(VERBOSITY_VALUES).optional().describe(VERBOSITY_DESCRIPTION),
      },
    },
    async ({ name, kind, package: pkg, feature, includeGenerated, verbosity }) => {
      if (name.trim().length === 0) {
        return errorResult('Provide the name to look for, e.g. "FormRepository".');
      }

      let index: ProjectIndex;
      try {
        index = await getIndex();
      } catch (err) {
        return errorResult(`Index unavailable: ${String(err)}`);
      }

      if (pkg !== undefined && !index.packages.some((p) => p.name === pkg)) {
        const known = index.packages.map((p) => p.name).join(', ');
        return errorResult(`Unknown package '${pkg}'. Known packages: ${known || '(none)'}.`);
      }
      if (feature !== undefined) {
        const known = listFeatures(index);
        if (!known.includes(feature)) {
          return errorResult(
            known.length === 0
              ? `This workspace has no feature folders (no features/, feature/ or modules/ ` +
                  `directory). Use package= or drop the filter.`
              : `Unknown feature '${feature}'. Known features: ${known.join(', ')}.`,
          );
        }
      }

      const scope: ReferenceScope = {};
      if (kind) scope.kinds = kind;
      if (pkg !== undefined) scope.package = pkg;
      if (feature !== undefined) scope.feature = feature;
      if (includeGenerated !== undefined) scope.includeGenerated = includeGenerated;

      const report = findReferences(index, name.trim(), scope);
      return indexedResult(formatReport(index, report, scope, verbosity ?? 'normal'), index);
    },
  );
}

/**
 * The honesty guarantee, stated once. Every site carries it, so labelling each
 * one would repeat a single fact hundreds of times.
 */
const NAME_MATCH_FOOTER =
  'Sites are syntactic name matches, not type-resolved: a call is matched by member name ' +
  'without resolving its receiver, and same-named declarations share these sites.';

function formatReport(
  index: ProjectIndex,
  report: ReferenceReport,
  scope: ReferenceScope,
  verbosity: Verbosity,
): string[] {
  if (report.siteCount === 0) return [emptyMessage(index, report, scope)];

  const header = [
    `# References to '${report.name}' — ${String(report.siteCount)} site(s) in ` +
      `${String(report.files.length)} file(s)${scopeSuffix(scope)}`,
    declarationLine(report.declarations),
    `Kinds: ${report.kindCounts.map(([k, n]) => `${k} ${String(n)}`).join(' · ')}`,
  ];
  const excluded = excludedNote(report, scope);
  if (excluded) header.push(excluded);
  header.push('');

  const anchor = new FileScope();
  const listing = report.files.flatMap((group) => fileRows(group, anchor));
  // A listing wider than the budget is replaced by shape rather than truncated:
  // the widest names run to tens of thousands of tokens, and a cut-off listing
  // describes the files it happened to reach instead of the whole answer.
  const overBudget = verbosity === 'normal' && listing.join('\n').length > BODY_LIMITS.maxChars;
  if (verbosity === 'summary' || overBudget) {
    return [...header, ...summaryBody(report, overBudget)];
  }
  return [
    ...header,
    ...capBody(listing, BODY_LIMITS, verbosity),
    '',
    `${NAME_MATCH_FOOTER} ${BARE_LINE_NOTE}`,
  ];
}

/**
 * One row per file and reference kind: `typeRef · path.dart:13,14,15  (3 sites)`.
 *
 * The kind leads because it is what a caller filters and skims on, and the sites
 * of one kind in one file are a single fact — printing a row per site would repeat
 * the path once per line number (ISSUE-3). Rows of the same file follow the first
 * one, which named the path in full, so their locations cost a line number each.
 */
function fileRows(group: FileReferenceGroup, scope: FileScope): string[] {
  const byKind = new Map<ReferenceKind, number[]>();
  for (const site of group.sites) {
    const lines = byKind.get(site.kind);
    if (lines) lines.push(site.line);
    else byKind.set(site.kind, [site.line]);
  }
  const ordered = [...byKind.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const rows: string[] = [];
  let annotated = false;
  for (const [kind, lines] of ordered) {
    const first = lines[0] ?? 0;
    const rest = lines.slice(1);
    const where = `${scope.ref(group.file, first)}${rest.length > 0 ? `,${rest.join(',')}` : ''}`;
    const count = lines.length > 1 ? `  (${String(lines.length)} sites)` : '';
    // The enclosing declarations are named once per file, on its first row.
    const owners = annotated ? '' : ownerSuffix(group.sites);
    annotated = true;
    scope.enter(group.file);
    rows.push(`${kind} · ${where}${count}${owners}`);
  }
  return rows;
}

/**
 * `[in FormRepositoryImpl]` — the declarations the sites sit inside, when they are
 * few enough to name. It is what a reader wants before opening the file, and one
 * file usually references a name from one or two places.
 */
function ownerSuffix(sites: ReferenceSite[]): string {
  const owners = [...new Set(sites.map((site) => site.owner).filter((o) => o !== undefined))];
  if (owners.length === 0 || owners.length > 2) return '';
  return `  [in ${owners.join(', ')}]`;
}

/**
 * Shape of the whole answer: how the sites distribute across features, and the
 * files holding most of them.
 *
 * Files are rendered one per row rather than as a single list, because a row of
 * fifteen absolute paths is a line an order of magnitude wider than any other
 * line in the response (ISSUE-3's measured failure mode). Where every file holds
 * a single site there is no concentration to report, and saying so is shorter and
 * more informative than fifteen rows all reading `(1)`.
 */
function summaryBody(report: ReferenceReport, overBudget: boolean): string[] {
  const lines: string[] = [];
  if (report.featureCounts.length > 1) {
    lines.push(`By feature: ${countList(report.featureCounts)}`);
  }

  const widest = report.files[0]?.sites.length ?? 0;
  if (widest <= 1) {
    lines.push(
      `One site in each of ${String(report.files.length)} file(s) — no file concentrates them.`,
    );
  } else {
    lines.push('Widest files:');
    for (const group of report.files.slice(0, SUMMARY_ROWS)) {
      lines.push(`  ${group.file} (${String(group.sites.length)})`);
    }
    if (report.files.length > SUMMARY_ROWS) {
      lines.push(`  … ${String(report.files.length - SUMMARY_ROWS)} more file(s).`);
    }
  }

  lines.push('');
  lines.push(
    overBudget
      ? `Listing every site would exceed this tool's response budget, so the shape is shown ` +
          `instead. Narrow with feature=, package= or kind=, or pass verbosity="full" to accept ` +
          `the full cost.`
      : 'Pass verbosity="normal" for the per-file site listing.',
  );
  lines.push(NAME_MATCH_FOOTER);
  return lines;
}

function countList(counts: [string, number][]): string {
  const shown = counts.slice(0, SUMMARY_ROWS).map(([key, n]) => `${key} ${String(n)}`);
  if (counts.length > shown.length) shown.push(`… +${String(counts.length - shown.length)} more`);
  return shown.join(' · ');
}

/**
 * What the name is declared as.
 *
 * A collision is reported by count with a few examples, not by listing every
 * declaration: a member name like `copyWith` is declared hundreds of times in a
 * clean-architecture repo, and printing them all costs more than the references
 * the caller asked for. `find_symbol` is the tool that enumerates declarations.
 *
 * No declaration at all means the name is declared outside the workspace; its
 * sites are still real, which is why they are not reported as an empty result.
 */
function declarationLine(declarations: Symbol[]): string {
  if (declarations.length === 0) {
    return (
      'Declared: not in this workspace — the name belongs to the SDK or a package outside it. ' +
      'The sites below are still where this workspace uses it.'
    );
  }
  const listed = declarationList(declarations);
  if (declarations.length === 1) return `Declared: ${listed}`;
  return (
    `Declared: ${String(declarations.length)} declarations share this name, e.g. ${listed} — ` +
    `find_symbol lists them all. Sites are matched by name and are not attributed between them.`
  );
}

/** A few declarations as `kind QualifiedName — file:line`, elision counted. */
function declarationList(declarations: Symbol[]): string {
  const shown = declarations
    .slice(0, MAX_DECLARATIONS_LISTED)
    .map((sym) => `${sym.kind} ${sym.qualifiedName} — ${sym.file}:${String(sym.range.startLine)}`);
  const rest = declarations.length - shown.length;
  return rest > 0 ? `${shown.join(' · ')} · … +${String(rest)} more` : shown.join(' · ');
}

/** What the scope and the generated-file default left out, when they left anything out. */
function excludedNote(report: ReferenceReport, scope: ReferenceScope): string | undefined {
  const notes: string[] = [];
  const filtered = report.totalSiteCount - report.siteCount - excludedGenerated(report, scope);
  if (filtered > 0) notes.push(`${String(filtered)} site(s) outside the filters`);
  const generated = excludedGenerated(report, scope);
  if (generated > 0) {
    notes.push(`${String(generated)} in generated files (includeGenerated=true to include)`);
  }
  return notes.length > 0 ? `Not shown: ${notes.join(', ')}.` : undefined;
}

function excludedGenerated(report: ReferenceReport, scope: ReferenceScope): number {
  return scope.includeGenerated === true ? 0 : report.generatedSiteCount;
}

/**
 * Which of the three empty results this is (§7.2): the name is unknown to the
 * index, it is declared and unused, or the filters excluded every site. The
 * unparsed-file count bounds all three — a reference inside syntax the grammar
 * could not read is absent from the index without being absent from the code.
 */
function emptyMessage(index: ProjectIndex, report: ReferenceReport, scope: ReferenceScope): string {
  const caveat =
    report.unparsedFileCount > 0
      ? ` ${String(report.unparsedFileCount)} file(s) hold syntax the grammar could not parse; ` +
        `references inside those regions are not indexed.`
      : '';

  if (report.totalSiteCount > 0) {
    return (
      `No references to '${report.name}'${scopeSuffix(scope)}, but ${String(report.totalSiteCount)} ` +
      `site(s) exist without the filters — drop or change them.${caveat}`
    );
  }
  if (report.declarations.length > 0) {
    const where = declarationList(report.declarations);
    return (
      `'${report.name}' is declared (${where}) and referenced nowhere in the index — ` +
      `possibly dead code, or used only via reflection/codegen.${caveat}`
    );
  }
  const near = nearestNames(referencedNames(index), report.name, MAX_SUGGESTIONS);
  const hint = near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '';
  return (
    `Nothing in the index declares or uses the name '${report.name}'.${hint}` +
    ` References are matched on the exact name as written.${caveat}`
  );
}

function scopeSuffix(scope: ReferenceScope): string {
  const parts = [
    scope.feature !== undefined && `feature=${scope.feature}`,
    scope.package !== undefined && `package=${scope.package}`,
    scope.kinds && scope.kinds.length > 0 && `kind=${scope.kinds.join(',')}`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
