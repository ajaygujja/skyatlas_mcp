# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `get_widget_tree`: constructor calls in non-layout slots (`listener:`, `create:`, `update:`,
  `validator:`, go_router `redirect:`, etc.) are no longer surfaced as fabricated layout nodes — the
  previous `/^on[A-Z]/`-only heuristic missed `listener:` and friends, so a BlocListener's dispatched
  event (and any spread arguments inside it) rendered as if it were part of the widget tree
  (ISSUE-1). Fixed at two layers: the extractor now excludes an explicit non-layout slot set in
  addition to the `on*` convention, and `get_widget_tree` additionally drops any constructor the
  index positively resolves to a non-Widget class, conservatively keeping anything absent, ambiguous,
  or unresolvable (most real widgets are unindexed Flutter SDK classes). Dropped nodes are marked
  `(Name — non-widget, not expanded)` rather than silently omitted.
- Disk cache bumped to v9: the extractor fix above changes `namedSlots` content for files already in
  a v8 cache without changing their content hash, so a stale cache would otherwise keep serving the
  old, incorrect tree until the file changed.
- `get_widget_tree`: the non-Widget filter (ISSUE-1 Layer B) now walks a constructor's declared
  supertype chain instead of checking only its direct superclass. `index.widgets` registers a class
  only when its direct superclass is a known Flutter base, so a widget subclassing another
  already-indexed widget (rather than a Flutter base class directly) was previously misjudged
  non-widget and dropped from the tree. The walk still keeps any node whose chain is ambiguous,
  leaves the index (external/SDK base), or cycles.
- `get_widget_tree`: the set of indexed widget names is now built once per `get_widget_tree` call and
  looked up in O(1), instead of scanning `index.widgets.values()` on every rendered node.
- `find_state_wiring` and `get_route_graph` no longer report different paths for the same route
  (ISSUE-2). Path, screen and mount resolution moved into `src/index/route-view.ts`, which both tools
  read, so a route has one path regardless of which tool is asked. Four cases previously disagreed:
  a `path:` written as a const (`RoutePaths.home`) reported as `(no path)`; a relative const child
  under a const parent (`/detail/edit`) with no resolvable path at all; a route mounted by a
  `...Owner.routes()` spread reported as unreachable, since static route tables sit outside
  `index.routes`; and every auto_route screen, because a hand-written entry names the generated page
  class (`HomeRoute`) rather than the screen, so a lookup by screen name matched only the pathless
  `*.gr.dart` entry. Routes are now reachable by both the resolved screen and the page class.
- `get_route_graph` output is unchanged, guarded by a whole-output snapshot; a cross-tool test now
  asserts both tools report the same path for every routed screen.

## [0.2.0] - 2026-06-19

### Added

- `find_symbol`: `match` modes (`exact`, `prefix`, `suffix`, `substring`, `regex`) and a `countOnly`
  option. An invalid regex returns a hint instead of throwing.
- `find_state_wiring`: a `depth` parameter that follows the dependency chain
  bloc → usecase → repository → datasource, with a role label for each hop.
- `get_widget_tree`: a `follow` option that expands a leaf widget and crosses a `StatefulWidget`
  into its `State` in a single call.

### Fixed

- `get_route_graph`: static route tables mounted by a spread (`...Owner.routes()`) are now
  enumerated instead of reported as unknown.
- `get_widget_tree`: spread-of-map children (`...items.map((e) => W())`) are now surfaced as a
  representative `dynamic (mapped)` child.
- `get_widget_tree`: a two-type-argument generic at a list position (`[BlocBuilder<A, B>(...)]`) now
  recovers its full builder subtree; the best-effort warning is dropped once the arguments are fully
  reconstructed.
- `find_state_wiring`: a dependency whose name is declared in more than one file now resolves to the
  declaration the caller imports.

## [0.1.0]

Initial release.

### Added

- MCP server exposing six read-only repo-structure tools: `get_project_map`, `find_symbol`,
  `get_symbol`, `get_route_graph`, `get_widget_tree`, and `find_state_wiring`.
- Whole-workspace Dart indexing via a vendored, pinned `tree-sitter-dart` WASM grammar (no native
  build), with graceful per-file degradation on unknown syntax.
- Flutter-domain extractors: routes, widget trees, and Bloc/Riverpod state wiring.
- Incremental re-indexing through a filesystem watcher, plus a content-hash-keyed warm-start cache
  under `.skyatlas/` in the indexed repo.
- `doctor` parse-coverage command (human and `--json` output) and a `benchmark` script.

[Unreleased]: https://github.com/ajaygujja/skyatlas_mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ajaygujja/skyatlas_mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ajaygujja/skyatlas_mcp/releases/tag/v0.1.0
