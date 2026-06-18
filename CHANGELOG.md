# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
