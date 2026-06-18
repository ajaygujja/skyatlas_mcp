# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ajaygujja/skyatlas_mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ajaygujja/skyatlas_mcp/releases/tag/v0.1.0
