/**
 * Feature and package attribution for indexed declarations: which slice of the
 * workspace a route, screen or file belongs to.
 *
 * A repo-wide answer is only as useful as the caller's ability to ask for part
 * of it, and the part an AI asks for is a feature — the folder a team's work is
 * organized around. Attribution is derived from paths rather than stored,
 * because a feature is a layout convention and not a fact the extractors can
 * read from source.
 *
 * Attribution is SYNTACTIC (Working Rule 8): a workspace whose layout carries no
 * feature directory has no features, and `listFeatures` returns an empty list
 * rather than inventing one from some other segment.
 */
import type { ProjectIndex } from './project-index.js';
import type { RouteView } from './route-view.js';
import { resolveClass } from './resolve.js';

/**
 * Directory names that hold one directory per feature. A path segment directly
 * below one of these names is a feature, wherever in the tree it sits, which
 * covers `lib/features/<name>` and `lib/src/modules/<name>` alike.
 */
const FEATURE_ROOT_DIRS = new Set(['features', 'feature', 'modules']);

/** Feature owning a workspace-relative file, or undefined outside any feature. */
export function featureOfFile(file: string): string | undefined {
  const segments = file.split('/');
  // The last matching root wins: a nested feature tree attributes a file to the
  // innermost feature that contains it, which is the one a caller names.
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && FEATURE_ROOT_DIRS.has(segment)) return segments[i + 1];
  }
  return undefined;
}

/** Every feature the indexed layout carries, sorted, for filters and their errors. */
export function listFeatures(index: ProjectIndex): string[] {
  const features = new Set<string>();
  for (const path of index.files.keys()) {
    const feature = featureOfFile(path);
    if (feature !== undefined) features.add(feature);
  }
  return [...features].sort((a, b) => a.localeCompare(b));
}

/**
 * File a route is attributed to: the one declaring the screen it renders, and
 * the one declaring the route itself when no screen resolves.
 *
 * The declaring file alone cannot carry the attribution. A central router — the
 * dominant layout in a feature-first app — declares every route in one file, so
 * attributing by declaration puts most of an app in whatever slice holds the
 * router, and none in the features the routes lead to. The screen is what the
 * route means to a caller asking about a feature.
 */
export function routeOwnerFile(index: ProjectIndex, view: RouteView): string {
  const screen = view.screen ?? view.route.screenWidget;
  if (screen === undefined) return view.route.file;
  return resolveClass(index, screen, { fromFile: view.route.file })?.file ?? view.route.file;
}
