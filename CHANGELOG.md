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
