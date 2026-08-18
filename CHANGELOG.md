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
- Response size is now bounded in characters, the unit a response is paid for, instead of lines alone
  (ISSUE-3). Line caps never bound the widest responses — measured against a 5,054-file workspace, a
  215-route `get_route_graph` came to 224 lines and ~6,700 tokens, well under the 250-line cap — so
  every capped section now also carries a character budget, and the notice still says how many lines
  were dropped and how to ask for less.
- Locations are no longer repeated once per line. Where a block's lines each carry a single location
  (`get_route_graph`, `find_symbol`) a line inside the last-named file renders as `:120`; where a
  line carries two (`find_state_wiring` dependency and call-site lines) it renders as `UserBloc:120`,
  naming the declaration the response already printed in full. Half of a route graph's characters and
  two thirds of a wiring response's were repeated paths.
- `find_state_wiring`: call sites that differ only by line are aggregated —
  `readsBloc · FormScreen:541,717,880  (9 sites)` instead of nine lines. Every line number is kept.
- `find_state_wiring`: the per-line `(syntactic)` label moved to the response footer. Confidence is
  `syntactic` for every edge the extractors emit, so the label repeated one fact on every line; a
  line whose confidence is anything else is still labelled inline.
- `get_widget_tree`: with `follow=true`, a widget class reached down more than one branch is expanded
  once and pointed at afterwards (`[RepeatedCard expanded above — card.dart:20]`). Both call sites
  are still rendered; only the duplicate subtree is dropped, which was 65% of the characters in the
  measured worst case.
- `find_symbol`: signatures show the first four parameters. A dependency-injected constructor can
  carry thirty, and one such line outweighed the rest of the page of matches; `get_symbol` remains
  the tool for a full declaration.
- `find_state_wiring`: resolving the implementor behind an interface no longer scans every symbol per
  dependency. A `depth=3` query against the 70,501-symbol workspace fell from 213 ms to 10 ms.

### Added

- `find_state_wiring` and `get_route_graph`: a `verbosity` parameter. `summary` reports shape —
  counts, declaring files, top-level paths, per-target site and dependency counts — for a few hundred
  tokens; `normal` (the default) renders full detail within the character budget; `full` renders the
  same detail with the budget lifted.
- `benchmark` now measures the formatted size of every tool response the index can serve, alongside
  index timing, and records it to `benchmarks/history.jsonl` under `--record` — response growth is a
  regression the same way index time is. Calls are selected from the index (widest bloc, busiest
  screen) so the script runs against any workspace and two runs over one repo are comparable.
- `get_route_graph`: `feature`, `package` and `pathPrefix` filters. Feature and package select a
  route by the file declaring the screen it renders, not the file declaring the route — a central
  route table would otherwise attribute an entire app to whichever slice holds the router. Ancestors
  of a match are kept and counted separately, since a child inherits its shell's path and guards. On
  a 219-route workspace, `feature=` renders 29 routes for 565 tokens against 3,346 for the graph.
- `get_project_map`: a `depth` parameter, and a folder listing that goes as deep as each package
  needs without being asked. A package holding most of its files under one folder is listed one level
  deeper, up to four segments, stopping as soon as no folder dominates or the deeper grouping stops
  splitting the package. A feature-first app previously rendered one `lib/features: 3783 file(s)` row
  covering 83% of its code; it now names all 28 features and their sizes.

- An empty result now says which of three things it means (§7.2): the subject is not in the index, it
  is there and genuinely unconnected, or it is there and part of the file it lives in could not be
  parsed. The third previously read exactly like the second, which is the reading that costs trust —
  an absence reported out of a file with syntax errors is not evidence of absence in the code, and
  `find_state_wiring` and `get_widget_tree` now name the file and its error count.
- `find_symbol`, `get_symbol`, `get_widget_tree` and `find_state_wiring` answer a name that matched
  nothing with the closest names that exist (`Did you mean: CounterCubit?`). Matching is by character
  bigram similarity, so a misspelling is answered as readily as a truncation — substring search finds
  neither. Candidates come from the pool the query resolves against (widget classes for a widget
  lookup, Bloc classes for a Bloc lookup), and `find_symbol` reports an excluding `kind=`/`package=`
  filter instead, since suggestions would name symbols that filter excludes too.
- Every tool response now closes with the index state it was served from —
  `index: 5054 files · 0 parse errors · updated just now` — so an empty answer can be told apart from
  an unindexed one. A whole-workspace re-scan in flight is stated, and so is a watcher that failed to
  start: a frozen index answers exactly like a live one, and nothing in the results reveals it.

### Changed

- `get_project_map`: generated files are grouped into one row per package instead of listing a
  codegen tree that mirrors the hand-written one (§7.4), a package holding no Dart files says so
  rather than rendering an empty section, and the per-package listing is bounded in characters as
  well as lines, matching the other tools' budgets.
- `get_project_map`: the `Index health: all files parsed clean` line is gone — the index state line
  every response carries reports the parse-error count, and this tool now renders only what it alone
  knows, the names of the files that failed.
- The MCP handshake reports the version `package.json` publishes; a test asserts the two stay equal
  (ISSUE-7).

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
