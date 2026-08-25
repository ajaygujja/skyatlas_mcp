/**
 * Reference resolution: what an indexed name is used by, and where.
 *
 * The extractor records a name per site with no knowledge of what it binds to
 * (`src/extractors/reference-extractor.ts`). This module is the only place that
 * turns those sites into an answer — it resolves the queried name against the
 * declarations the workspace holds, attributes each site's file to a package and
 * feature so a caller can scope a wide answer, and aggregates per file, since a
 * file is the unit a reader opens.
 *
 * Honesty rule (Working Rule 8): a reference is a NAME MATCH. Where several
 * declarations share the name, all of them are reported and the sites are not
 * divided between them, because the syntax layer cannot tell which one a site
 * meant. Where no declaration carries the name, the sites are still real — the
 * name belongs to the SDK or a package outside the workspace — and that is said
 * rather than treated as an empty result.
 *
 * Sites are read from the file entries on demand, never aggregated onto the
 * index: a 5,000-file workspace holds ~280,000 of them, and an aggregate kept
 * across edits is an aggregate that can disagree with the files it came from
 * (the rule `ProjectIndex.stringConsts()` already follows). A lookup for one
 * name costs one map read per file — well under a millisecond on that workspace.
 */
import type { ReferenceKind, ReferenceSite } from '../model/reference.js';
import type { Symbol } from '../model/symbol.js';
import type { ProjectIndex } from './project-index.js';
import { featureOfFile } from './feature-scope.js';

/** Bucket label for a file that sits outside any feature directory. */
export const NO_FEATURE = '(no feature)';

/** Which slice of a name's references to report. */
export interface ReferenceScope {
  /** Package owning the referencing file (pubspec name). */
  package?: string;
  /** Feature directory holding the referencing file. */
  feature?: string;
  /** Reference kinds to keep; all kinds when absent. */
  kinds?: ReferenceKind[];
  /** Include *.g.dart / *.freezed.dart / *.gr.dart as referencing files. */
  includeGenerated?: boolean;
}

/** One referencing file's sites, with the attribution the scope filters on. */
export interface FileReferenceGroup {
  file: string;
  package?: string;
  /** Feature directory, or `NO_FEATURE` when the path carries none. */
  feature: string;
  sites: ReferenceSite[];
}

/** What the index knows about the uses of one name. */
export interface ReferenceReport {
  name: string;
  /**
   * Declarations carrying the name, sorted by symbol id. Empty for a name the
   * workspace only uses — an SDK or third-party type.
   */
  declarations: Symbol[];
  /** Referencing files inside the scope: most sites first, then path order. */
  files: FileReferenceGroup[];
  /** Sites inside the scope, and in the whole index — the second shows what a filter cut. */
  siteCount: number;
  totalSiteCount: number;
  /** Scoped site counts by kind and by feature, each ordered by count then name. */
  kindCounts: [ReferenceKind, number][];
  featureCounts: [string, number][];
  /** Sites in generated files, excluded unless `includeGenerated` was set. */
  generatedSiteCount: number;
  /**
   * Files whose syntax the grammar could not fully parse. References inside those
   * regions are not recorded, so this bounds how complete an absence can be.
   */
  unparsedFileCount: number;
}

export function findReferences(
  index: ProjectIndex,
  name: string,
  scope: ReferenceScope = {},
): ReferenceReport {
  const kinds = scope.kinds && scope.kinds.length > 0 ? new Set(scope.kinds) : undefined;
  const files: FileReferenceGroup[] = [];
  let totalSiteCount = 0;
  let generatedSiteCount = 0;
  let unparsedFileCount = 0;

  for (const entry of index.files.values()) {
    if (entry.parseErrors.length > 0) unparsedFileCount++;
    const sites = Object.hasOwn(entry.references, name) ? entry.references[name] : undefined;
    if (!sites || sites.length === 0) continue;
    totalSiteCount += sites.length;
    if (entry.generated) {
      generatedSiteCount += sites.length;
      if (scope.includeGenerated !== true) continue;
    }
    const feature = featureOfFile(entry.path) ?? NO_FEATURE;
    if (scope.package !== undefined && entry.package !== scope.package) continue;
    if (scope.feature !== undefined && feature !== scope.feature) continue;
    const kept = kinds ? sites.filter((site) => kinds.has(site.kind)) : sites;
    if (kept.length === 0) continue;
    const group: FileReferenceGroup = { file: entry.path, feature, sites: kept };
    if (entry.package !== undefined) group.package = entry.package;
    files.push(group);
  }

  // Widest file first: it is where a change lands hardest, and a caller reading a
  // truncated listing should see those before the long tail of single mentions.
  files.sort((a, b) => b.sites.length - a.sites.length || a.file.localeCompare(b.file));
  for (const group of files) group.sites.sort((a, b) => a.line - b.line);

  return {
    name,
    declarations: declarationsNamed(index, name),
    files,
    siteCount: files.reduce((sum, group) => sum + group.sites.length, 0),
    totalSiteCount,
    kindCounts: tally(files.flatMap((group) => group.sites.map((site) => site.kind))),
    featureCounts: tally(files.flatMap((group) => group.sites.map(() => group.feature))),
    generatedSiteCount,
    unparsedFileCount,
  };
}

/**
 * Every declaration carrying the name, of any kind — a query for a name does not
 * know whether it names a class, a method or a top-level function, and reporting
 * only one kind would hide a real collision behind an apparently exact answer.
 */
function declarationsNamed(index: ProjectIndex, name: string): Symbol[] {
  const out: Symbol[] = [];
  for (const id of index.byName.get(name) ?? []) {
    const sym = index.symbolsById.get(id);
    // A class's implicit constructor carries the class's name; it is the same
    // declaration site, so listing it would double every class.
    if (sym && sym.kind !== 'constructor') out.push(sym);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Counts per distinct value, ordered by count descending then value, for stable output. */
function tally<T extends string>(values: T[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Every name the workspace references or declares, for suggesting the nearest one
 * to a query that matched nothing. Declared names alone would not do: a caller
 * may ask about an SDK type the workspace only uses.
 */
export function referencedNames(index: ProjectIndex): Set<string> {
  const names = new Set<string>(index.byName.keys());
  for (const entry of index.files.values()) {
    for (const name of Object.keys(entry.references)) names.add(name);
  }
  return names;
}
