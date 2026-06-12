# Flutter Code Intelligence MCP Server — Technical Design & Implementation Plan

> **Audience:** This document is written for both humans and AI coding assistants (Claude Code).
> If you are an AI assistant building this project: read this entire document before writing any code.
> Follow the **Working Rules for AI Assistants** section strictly. Do not assume — verify.

**Status:** In implementation — Phases 0, 1, 2 complete; Phase 3a (widgets) complete. See §8 for sub-phase status.
**Last verified:** 2026-06-13 (ecosystem facts §2 checked against live docs; grammar behaviour re-verified empirically against the vendored `tree-sitter-dart` build)

---

## 1. The Problem We Are Solving

### 1.1 The pain (observed, not assumed)

AI coding assistants (Claude Code, Cursor) working on large Flutter codebases re-discover the
codebase from scratch in **every new chat session**:

- They grep for keywords, open files, read hundreds of lines to answer questions like
  "which Bloc serves SettingsScreen?" or "what is the route structure?"
- On a 1000+ file enterprise monorepo this costs **10–20 tool calls and ~50k tokens per session**,
  repeated for every developer, every session, every day.
- Worse than cost: answers reconstructed by ad-hoc grepping are sometimes **wrong**
  (missed indirect usage, misread nesting), and the assistant states them confidently.

### 1.2 Why existing approaches fall short (verified by reading their source)

**Regex-based indexers (e.g. Engineering OS / EOS).** EOS's Dart support is ~230 lines of
hand-tuned regexes. Verified failure modes from its source:

- Needs a `NON_DECLARATION_NAMES` denylist because a call statement `log('x');` is
  shape-identical to a typeless abstract method declaration. The denylist can never be complete.
- Hand-counts `{`/`}` and `(`/`)` characters to find block ends and go_router nesting depth —
  manually re-implementing what a parser does, because **regular expressions provably cannot
  match recursively nested structures** (this is a formal-language-theory limit, not an
  implementation gap: regex = regular languages; nested brackets require context-free parsing).
- Its data model is a flat `CodeChunk { filePath, startLine, endLine, content, type, name }`:
  no parent/child relationships, no type parameters (a `Bloc<UserEvent, UserState>` becomes the
  bare string `"Bloc"`), no annotations, no widget hierarchy, no route graph.

**The official Dart/Flutter MCP server** (`dart mcp-server`, Dart SDK ≥ 3.9). Verified scope from
docs.flutter.dev/ai/mcp-server: per-symbol analyzer queries (resolve symbol, docs, signatures),
error analysis/fixes, runtime app interaction (hot reload, widget tree of a *running* app),
tests, format, pub. It does **not** provide whole-repo indexing, structural search, route graphs,
architecture maps, or persistent project knowledge. It is a *microscope*, not a *map*.

**Generic tree-sitter MCP servers** (wrale/mcp-server-tree-sitter, tree-sitter-analyzer, etc.).
Language-agnostic symbol extraction. No Flutter domain knowledge: no widget trees, no
Bloc/Riverpod mapping, no go_router/auto_route graphs.

### 1.3 The gap (our product)

**A Flutter-aware, whole-repo structural intelligence layer for AI assistants.**
Parse Dart with a real parser (tree-sitter), build a rich nested symbol model plus
Flutter-domain graphs (routes, widgets, state-management wiring), keep it fresh incrementally,
and expose it over MCP as a small set of sharp, token-efficient tools.

It **complements** the official Dart MCP server (semantics/runtime) — it does not compete with it.
Recommended developer setup is to run both.

### 1.4 Success criteria (measurable)

1. Cold index of a 1000+ file Flutter monorepo in **< 10 seconds**; re-index of one saved file in **< 50 ms**.
2. Claude answers "route graph", "which Bloc serves screen X", "what's inside class Y"
   in **1 tool call** instead of 10+ grep/read rounds.
3. Extraction accuracy validated by a fixture suite drawn from the real enterprise repo; zero
   known false positives of the call-vs-declaration class.
4. A new team member's Claude session uses the tools without custom prompting
   (tool descriptions alone are sufficient).

---

## 2. Verified Ecosystem Facts (do not re-assume; re-verify if > 3 months old)

| Fact | Value | Verified |
|---|---|---|
| Current stable Dart | **3.12** (May 2026) | dart.dev changelog, 2026-06-12 |
| Current stable Flutter | **3.44** (May 2026) | docs.flutter.dev archive, 2026-06-12 |
| Dart 3.x language features the grammar must handle | 3.0 patterns, records, class modifiers (`sealed`/`base`/`final`/`interface`/`mixin class`), switch expressions; 3.3 extension types; 3.6 digit separators (`1_000_000`); 3.7 wildcard variables (`_`); 3.8 null-aware collection elements; 3.10 **dot shorthands** (`.foo` for `ContextType.foo`); 3.12 private named parameters, experimental primary constructors | dart.dev language evolution |
| Dart macros | **Cancelled** (Jan 2025) — will never appear in code; "augmentations" may ship later as separate feature | dart.dev blog |
| tree-sitter grammar | `UserNobody14/tree-sitter-dart` — actively maintained, used by nvim-treesitter; supports records, patterns, class modifiers, extension types, dot shorthands; ships a WASM build in-repo | GitHub |
| Known grammar weakness | Record-literal vs record-type vs record-pattern ambiguity in some `(x, x)` contexts → occasional mis-parse; treat as edge case, cover with fixtures | GitHub issues |
| Grammar weakness **confirmed empirically (Phase 3a, 2026-06-13)** | A generic **constructor invocation at value position with ≥2 comma-separated type args** — `BlocBuilder<UserBloc, UserState>(...)` — mis-parses: the grammar reads `<`/`>` as comparison operators, yielding a `relational_expression` and spilling the real argument list into a sibling `record_literal`. A **single** type arg (`FutureBuilder<int>(...)`) parses cleanly (`type_arguments` inside `argument_part`), as do method-call sites (`context.read<X>()`, `on<Event>(...)`). The widget extractor recovers name + type args + builder subtree from the mis-parse and flags the node `recoveredFromMisparse`; fixture `fixtures/widgets/home_screen.dart` pins the behaviour | dump-tree, this repo |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` — `McpServer.registerTool(name, {title, description, inputSchema, outputSchema}, handler)`; accepts Zod v4 / Standard Schema; supports runtime tool update notifications | modelcontextprotocol/typescript-sdk |

**Implication of macros cancellation:** codegen stays annotation-driven (`freezed`,
`json_serializable`, `auto_route`, `riverpod_generator`). Annotations are plain syntax —
tree-sitter sees them perfectly. This is good for us.

---

## 3. What We Are Building

### 3.1 Product definition

A local MCP server (a CLI process speaking JSON-RPC over stdio — **no HTTP backend, no
database server, no deployment infrastructure**) that:

1. On startup, indexes all `.dart` files in a workspace into an in-memory structural model
   (with a disk cache so warm starts skip unchanged files).
2. Watches the filesystem and incrementally re-indexes changed files.
3. Exposes 6 MCP tools that answer repo-structure questions in compact, LLM-optimized text.

### 3.2 Explicit non-goals (scope discipline — re-read when tempted)

- ❌ **No semantic analysis**: no type inference, no "find implementations across packages",
  no const evaluation. That is the Dart analyzer's job (official Dart MCP server).
- ❌ **No runtime interaction**: no hot reload, no driving a running app (official server / marionette_mcp).
- ❌ **No code editing**: read-only intelligence. The assistant edits files itself.
- ❌ **No multi-language support**: Dart only. Depth over breadth is the whole thesis.
- ❌ **No embeddings/RAG in v1**: structural queries first. Chunking-for-embedding is a
  documented future extension (the data model is designed not to preclude it).

---

## 4. Architecture

### 4.1 Layer diagram

```
┌──────────────────────────────────────────────────────────┐
│  MCP Layer (src/tools/)                                   │
│  tool definitions, input validation, response formatting  │
│  knows: Index API.  knows nothing of: tree-sitter         │
├──────────────────────────────────────────────────────────┤
│  Index Layer (src/index/)                                  │
│  symbol store, lookup maps, file watcher, disk cache       │
│  knows: Symbol model.  knows nothing of: MCP, tree-sitter  │
├──────────────────────────────────────────────────────────┤
│  Extraction Layer (src/extractors/)                         │
│  CST → Symbol model; Flutter-domain extractors              │
│  (widgets, bloc, riverpod, routes)                          │
│  knows: tree-sitter node types + Flutter conventions        │
├──────────────────────────────────────────────────────────┤
│  Parser Layer (src/parser/)                                 │
│  web-tree-sitter init, parse, incremental re-parse          │
│  knows: nothing about Flutter or symbols                    │
└──────────────────────────────────────────────────────────┘
```

**The dependency rule:** each layer depends only on the layer below, expressed through an
interface. Parser knows nothing about Flutter. Extractors know nothing about MCP.
Tools know nothing about tree-sitter. This is what makes every layer independently
testable and lets an AI assistant work on one layer without breaking others.

### 4.2 Data flow

```
startup:  walk *.dart → hash check vs cache → parse changed → extract → index → ready
on save:  chokidar event → re-parse file → re-extract → replace file's symbols → rebuild
          affected graphs (routes/widgets) lazily
on tool call:  validate input → query index → format compact markdown → return
```

### 4.3 Technology choices (decided — do not relitigate without new facts)

| Decision | Choice | Rationale | Rejected alternative & why |
|---|---|---|---|
| Language | TypeScript (strict mode) | Best MCP SDK, best tree-sitter bindings, largest example corpus for AI-assisted development | Dart: MCP SDK exists but tree-sitter-from-Dart path is immature |
| Parser binding | `web-tree-sitter` (WASM) | Zero native compilation → installs cleanly on macOS/Linux/Windows/ARM; grammar repo ships a `.wasm` | `node-tree-sitter` (native): ~2× faster but node-gyp build failures are the #1 install complaint for similar tools; revisit only if profiling shows parse is the bottleneck |
| Storage | In-memory maps + JSON disk cache (content-hash keyed) | 1000 files of symbols ≈ a few MB; simplest correct thing | SQLite: add only when memory or startup profiling demands it |
| File watching | `chokidar` | Battle-tested cross-platform watcher | `fs.watch`: platform inconsistencies |
| Validation | Zod v4 | Native `inputSchema` support in MCP SDK | — |
| Tests | Vitest | Fast, TS-native | — |
| Lint/format | ESLint (typescript-eslint, strict) + Prettier | Industry default | — |
| Node version | ≥ 20 LTS | WASM + SDK requirements | — |
| Package manager | pnpm | Fast, strict node_modules | — |

**Storage scaling thresholds (when the in-memory decision changes):** ~1,000 files ≈ 10–25 MB
of symbols — trivial. ~10,000 files ≈ 250 MB — still acceptable on a dev machine. Beyond that,
swap the JSON cache for SQLite **inside the Index layer only** — the layer boundary (§4.1) means
tools and extractors are untouched by the storage swap. Trigger for the swap is *measured* memory
or warm-start pain reported by a real repo, never speculation. (100k+ file monorepos are out of
target scope; organizations at that scale run custom indexing infra.)

---

## 5. Data Model

### 5.1 Core symbol model (replaces EOS's flat CodeChunk)

```ts
/** A declaration in source code. Nested: classes contain methods, etc. */
interface Symbol {
  id: string;                    // stable: `${relPath}#${qualifiedName}` e.g. "lib/blocs/user_bloc.dart#UserBloc.onLoad"
  name: string;
  qualifiedName: string;         // "UserBloc.onLoad" — includes enclosing scopes
  kind: SymbolKind;              // see below
  file: string;                  // workspace-relative path
  range: { startLine: number; endLine: number };          // 1-based, inclusive
  nameRange: { line: number; col: number };               // for precise navigation
  parentId?: string;             // enclosing symbol (the thing EOS structurally lacks)
  children: Symbol[];

  // Declaration detail (all optional, populated when present in syntax)
  typeParameters?: string[];     // ["UserEvent", "UserState"] from Bloc<UserEvent, UserState>
  extendsType?: TypeRef;         // { name: "Bloc", typeArgs: ["UserEvent", "UserState"] }
  implementsTypes?: TypeRef[];
  mixesIn?: TypeRef[];
  annotations: Annotation[];     // [{ name: "freezed" }, { name: "RoutePage", args: "name: 'HomeRoute'" }]
  modifiers: string[];           // ["abstract", "sealed", "static", "async", ...]
  returnType?: string;           // verbatim source text (syntax-level, NOT resolved)
  parameters?: Param[];          // names + verbatim type text
  doc?: string;                  // first line of /// doc comment, if any
}

type SymbolKind =
  | 'class' | 'mixin' | 'enum' | 'extension' | 'extensionType'
  | 'function' | 'method' | 'getter' | 'setter' | 'constructor' | 'field'
  | 'typedef';

interface TypeRef { name: string; typeArgs: string[] }   // verbatim, unresolved
interface Annotation { name: string; args?: string }
interface Param { name: string; type?: string; named: boolean; required: boolean }
```

**Honesty rule baked into the model:** every type is *verbatim source text*, never claimed to be
resolved. Field names say `extendsType`, not `superclass resolved`. Tools must never present
syntax-level info as semantic fact.

### 5.2 Flutter domain models (built on top of symbols)

```ts
/** Widget classes and the static widget tree inside their build(). */
interface WidgetInfo {
  symbolId: string;
  flavor: 'stateless' | 'stateful' | 'state' | 'consumer' | 'hook' | 'unknownWidgetSubclass';
  buildTree?: WidgetNode;        // present when a build() method was found and parsed
}
interface WidgetNode {
  widget: string;                // constructor name as written: "Scaffold", "BlocBuilder"
  typeArgs?: string[];           // BlocBuilder<UserBloc, UserState>
  line: number;
  namedSlots: Record<string, WidgetNode[]>;  // child:, children:, builder-returned trees
  isBuilderCallback?: boolean;   // tree came from a builder closure (itemBuilder, etc.)
}

/** State management wiring. */
interface BlocInfo {
  symbolId: string;
  flavor: 'bloc' | 'cubit';
  eventType?: string;            // from Bloc<Event, State> type args
  stateType?: string;
  handlers: { eventType: string; methodName?: string; line: number }[];  // on<X>(...)
}
interface ProviderInfo {          // Riverpod
  symbolId?: string;             // for class-based / generated providers
  name: string;                  // variable or class name
  declKind: 'global' | 'generated';   // userProvider = Provider(...) vs @riverpod class/fn
  providerType?: string;         // Provider / StateNotifierProvider / AsyncNotifierProvider...
  typeArgs?: string[];
  file: string; line: number;
}

/** Navigation. */
interface RouteInfo {
  router: 'go_router' | 'auto_route' | 'navigator1';
  path?: string;                 // go_router path as written
  name?: string;                 // route name
  fullPath?: string;             // computed from nesting: parent path + own path
  screenWidget?: string;         // widget returned by builder, when syntactically determinable
  file: string; line: number;
  children: RouteInfo[];         // real nesting from the CST — no paren counting
  guards?: string[];             // redirect/guard identifiers when present
}

/** Cross-cutting edges, syntax-derived. */
interface Edge {
  from: string;                  // symbolId
  to: string;                    // symbolId OR bare name when target not in index
  kind: 'createsBloc'            // BlocProvider(create: (_) => XBloc())
      | 'readsBloc'              // context.read<X>() / BlocBuilder<X, _>
      | 'watchesProvider'        // ref.watch(xProvider)
      | 'constructsWidget'       // appears in a build tree
      | 'extends' | 'implements' | 'mixesIn'
      | 'imports';               // file-level
  line: number;
  confidence: 'exact' | 'syntactic';  // be honest: name-matching is syntactic, not resolved
}
```

### 5.3 Index structure

```ts
interface ProjectIndex {
  files: Map<string, FileEntry>;        // path → { contentHash, symbols, imports, parseErrors }
  symbolsById: Map<string, Symbol>;
  byName: Map<string, string[]>;        // name → symbolIds (for fast find)
  byKind: Map<SymbolKind, string[]>;
  widgets: Map<string, WidgetInfo>;
  blocs: Map<string, BlocInfo>;
  providers: ProviderInfo[];
  routes: RouteInfo[];                  // forest (multiple routers possible)
  edges: Edge[];
  packages: Map<string, PackageEntry>;  // monorepo: each pubspec.yaml found = one package
}
```

Disk cache: `.flutter-intel/cache.json` in the workspace (gitignored), keyed by file content
hash — warm start re-parses only changed files.

---

## 6. MCP Tool Surface (v1 — exactly six tools)

Few tools, sharp tools. Every description must tell the LLM *when* to use it.
All responses are compact markdown with `file:line` references, hard-capped in size
(default ~4000 tokens; `detail` param raises caps explicitly).

| Tool | Input (Zod) | Returns |
|---|---|---|
| `get_project_map` | `{ package?: string }` | Repo overview: packages, feature folders, counts by kind, detected stack (state mgmt, router, codegen) — the "read this first" tool |
| `find_symbol` | `{ query: string, kind?: SymbolKind, package?: string }` | Matching symbols: qualified name, kind, signature line, file:line, annotations |
| `get_symbol` | `{ id?: string, name?: string, includeChildren?: boolean }` | One symbol in depth: declaration header, type params, extends/implements, annotations, member list, edges in/out |
| `get_route_graph` | `{ router?: string }` | Route tree with computed full paths, screen widget per route, guards: `/home → HomeScreen (lib/...:12)` indented by nesting |
| `get_widget_tree` | `{ widget: string, depth?: number }` | Static build() tree of a widget, builder callbacks marked, Bloc/Provider wiring noted inline |
| `find_state_wiring` | `{ screen?: string, bloc?: string, provider?: string }` | Connections: screen ↔ bloc/provider ↔ (syntactically visible) repositories, each edge with file:line and confidence |

**Response formatting rules (the consumer is an LLM):**
1. Markdown, not JSON. Dense lines, no prose padding.
2. Every fact carries `file:line` so the assistant can jump to source.
3. Truncate with explicit notice: `… 47 more — narrow with kind= or package=`. Never truncate silently.
4. Distinguish certainty: syntactic name-matches are labeled `(syntactic match)`.
5. Empty results explain themselves: `No Bloc found wiring to 'SettingsScreen'. Detected state mgmt in this repo: Riverpod. Try find_state_wiring with provider=.`

---

## 7. Tree-sitter Usage Notes (Parser & Extraction layers)

### 7.1 Fundamentals the implementer must know

- tree-sitter produces a **CST** (concrete syntax tree): every token, including punctuation, is
  in the tree. **Named nodes** (e.g. `class_definition`) carry meaning; **anonymous nodes**
  (`{`, `,`) are syntax noise. Queries match named nodes.
- **Queries** are S-expressions with captures: `(class_definition name: (identifier) @name)`.
  Compile once at startup, reuse. A query that references a node type absent from the grammar
  throws **at compile time** — this is our safety net against hallucinated node names.
- **Error recovery:** invalid code yields a tree with localized `ERROR`/`MISSING` nodes; the
  rest of the file parses fine. Extract what's valid; record `parseErrors` per file; never abort.
- **Incremental parsing:** keep the old `Tree`; on edit call `tree.edit({...byte/point ranges})`
  then `parser.parse(newText, oldTree)` — unchanged subtrees are reused. For an MCP server
  reacting to *saves* (not keystrokes), a full re-parse of one file is ~1–3 ms anyway;
  implement incremental only if profiling justifies it. **Do not prematurely optimize.**

### 7.2 Critical discipline: never trust remembered node names

The exact node type names of `tree-sitter-dart` (`class_definition` vs `class_declaration`,
how it spells enhanced enums, dot shorthands, etc.) **must be discovered empirically**, not
recalled from training data. Mandatory workflow for every extractor:

1. Write a minimal Dart snippet exercising the construct.
2. Parse it and dump `tree.rootNode.toString()` (build a `scripts/dump-tree.ts` helper for this in Phase 1).
3. Write the query against the **observed** node names.
4. Commit snippet + expected extraction as a fixture test.

### 7.3 Where the grammar gives clean captures vs where post-processing is needed

| Target | Clean from grammar | Needs post-processing |
|---|---|---|
| Class + modifiers + type params + extends/implements/with | ✅ direct fields | — |
| Methods, getters, constructors, fields nested in class | ✅ body children | — |
| Annotations incl. args | ✅ sibling nodes of declaration | match annotation *names* to known codegen (freezed/RoutePage/riverpod) by string |
| Widget tree in build() | ✅ nested constructor/method invocations | decide which named args are "slots" (`child`, `children`, `builder`, `itemBuilder`…); enter builder closures and treat returned constructor as subtree |
| `Bloc<E,S>` (in `extends`) / `on<Event>(handler)` | ✅ type args are nodes (declaration & method-call sites parse cleanly) | classify: extends-Bloc vs extends-Cubit; resolve handler method name within class scope. NB: a `BlocBuilder<E,S>(...)` *constructor* call mis-parses — see §2 grammar-weakness row; recover, don't trust the raw tree there |
| go_router nesting | ✅ nested `GoRoute(...)` calls = nested nodes | compute fullPath by walking ancestors; handle `ShellRoute`/`StatefulShellRoute` (no own path) |
| Riverpod | ✅ global var initializers, `@riverpod` annotations | classify provider type by constructor name string |
| Imports/exports/parts | ✅ directive nodes | resolve `package:` URIs to workspace paths using pubspec name map (monorepo) |
| "Which repository does this Bloc use" | constructor params + field types visible | matching a param *type name* to a class elsewhere is **syntactic** — label confidence accordingly |

### 7.4 Generated files policy

`*.g.dart` / `*.freezed.dart` / `*.gr.dart`: **parse but mark `generated: true`**; exclude from
default tool responses (they're noise) but keep available behind `includeGenerated: true` —
auto_route's `*.gr.dart` is sometimes the only place the full route table exists.

---

## 8. Implementation Plan — End to End

Each phase ends with something runnable and tested. Do not start phase N+1 with phase N's
tests red.

### Phase 0 — Plumbing proof (target: 1 evening)
- Scaffold: pnpm + TypeScript strict + ESLint + Prettier + Vitest; `src/` layer folders.
- MCP server with one tool `ping` → `"pong"` via `@modelcontextprotocol/sdk` (`registerTool`, Zod schema, stdio transport).
- Register in Claude Code (`claude mcp add flutter-intel -- node dist/server.js`), invoke ping from a chat.
- **Exit criterion:** pong arrives in Claude. The riskiest unknown (MCP plumbing) is dead first.

### Phase 1 — Parse one file (target: 1–2 evenings)
- Parser layer: init web-tree-sitter, load `tree-sitter-dart.wasm`, `parseFile(path) → Tree`.
- `scripts/dump-tree.ts` (the empirical node-name discovery tool — used in every later phase).
- First extractor: classes + methods + functions with names/ranges/parents from a real file.
- Fixtures: `fixtures/basic/` with 5+ real-shaped Dart files; snapshot tests of extraction.
- **Exit criterion:** extraction matches hand-verified expectations on fixtures.

### Phase 2 — Whole-repo index + first real tools (target: 2–3 evenings)
- Walk workspace (respect `.gitignore`; collect every `pubspec.yaml` → package map).
- Full `Symbol` model (§5.1) incl. annotations, type params, extends/implements, modifiers.
- `ProjectIndex` with lookup maps; JSON disk cache keyed by content hash.
- Tools: `get_project_map`, `find_symbol`, `get_symbol`.
- Benchmark script: index the enterprise monorepo, record cold/warm timings.
- **Exit criteria:** cold index < 10 s on the 1000+ file repo; tools answer correctly in a live Claude session. *Tool is already daily-usable here.*

### Phase 3 — Flutter domain extractors (target: 2 weeks; one extractor at a time, each fixtures-first)

Phase 3 is split into five independently shippable sub-phases. Each ends green
(lint + typecheck + tests) and, where it adds a tool, answers correctly in a
live Claude session. Build order is 3a → 3e; 3b/3c emit partial `Edge`s that 3e
assembles. **Exit criterion per sub-phase:** fixture suite drawn from the real
repo's patterns passes; spot-check answers against ground truth known to the
team's Flutter expert.

#### 3a — Widgets ✅ **complete (2026-06-13)**
- Detect Stateless/Stateful/State/Consumer/Hook subclasses (flavor by superclass; anything else ending in `Widget` → `unknownWidgetSubclass`).
- Parse the static build() tree: named slots, `children` lists, `const` constructions, named constructors (`ListView.builder`), type args, builder-closure subtrees (marked `isBuilderCallback`).
- Event-handler slots (`^on[A-Z]` — `onPressed`/`onTap`/…) are excluded: they fire at runtime and often construct non-widgets (Bloc events).
- Recovers the §2 generic-constructor mis-parse (`BlocBuilder<A,B>(...)`), flagged `recoveredFromMisparse`.
- Model: `WidgetInfo`/`WidgetNode` in `src/model/flutter.ts`. Index: `ProjectIndex.widgets` + `FileEntry.widgets` (cache bumped to v2). Tool: `get_widget_tree`. Fixtures: `fixtures/widgets/`.
- Known limits (honest, Working Rule 8): tree is syntactic — dynamically built children (loops/conditionals/spreads/helper methods) are not unrolled; PascalCase static calls sharing constructor syntax (`Theme.of(context)`) are filtered only when followed by a property access.

#### 3b — Bloc/Cubit
- Type args, `on<E>` handlers, `emit` sites; classify extends-Bloc vs extends-Cubit.
- Emit partial `Edge`s: `BlocProvider(create:)`, `context.read/watch<X>()`, `BlocBuilder<X,_>`. Model: `BlocInfo`. No new tool (edges consumed by 3e).

#### 3c — Riverpod
- Global providers + `@riverpod` generated; classify provider type by constructor name.
- Emit partial `Edge`s: `ref.watch/read/listen`. Model: `ProviderInfo`. No new tool (edges consumed by 3e).

#### 3d — Routes
- go_router (GoRoute/ShellRoute/StatefulShellRoute nesting, `fullPath` computation, redirect guards) + auto_route (`@RoutePage`, `AutoRoute` lists, `*.gr.dart` fallback). Model: `RouteInfo`. Tool: `get_route_graph`.

#### 3e — Wiring
- Assemble the `Edge` graph from 3b–3d; resolve screen ↔ bloc/provider ↔ repository connections by name-match (label `confidence: 'syntactic'`). Tool: `find_state_wiring`.

### Phase 4 — Freshness (target: 2–3 evenings)
- chokidar watcher: debounce 200 ms, re-parse changed file, replace its symbols, invalidate affected domain graphs (recompute lazily on next tool call).
- Handle: file delete, rename, new file, branch switch (mass change → fall back to full re-scan when > N files change at once).
- **Exit criterion:** edit a route file, ask Claude for the route graph, see the change without restart; single-file update < 50 ms.

### Phase 5 — Hardening & team rollout (target: 1 week)
- Structured logging to stderr (stdout is the MCP channel — **never** print to stdout).
- Graceful degradation: parse error in one file → log, skip, continue; index never dies.
- README: install (`npx`-able package), Claude Code + Cursor config snippets, "run alongside the official Dart MCP server" guidance.
- Dogfood ladder: you (1 week) → 2 teammates → whole team. Every wrong answer becomes a fixture before it becomes a fix.
- **Exit criterion:** a teammate installs from README alone, with no help from you.

### Future features (explicitly deferred — design supports them; do NOT build in v1)

Roughly in expected-value order. Ship v1 first; let real team usage pick what's next.

1. **Impact analysis** — `what_breaks_if_i_change(symbol)`: syntactic version first (name
   references across the index), analyzer-backed later. Highest enterprise value.
2. **Semantic layer** — wrap the Dart `analyzer` package / analysis server as an optional
   sidecar: resolved types, true find-references. Removes the `(syntactic match)` hedge.
3. **Embeddings/RAG** — `search_by_meaning("where do we handle payment retries")`.
   Chunk = symbol subtree + breadcrumb header (file → class → method). Local embedding model
   only — "code never leaves the machine" must survive this feature.
4. **Architecture rules engine** — declare layer rules ("presentation must not import data");
   tool reports violations so the AI both *checks* and *follows* the architecture when writing code.
5. **Test intelligence** — map tests ↔ code under test: "which tests cover this Bloc",
   "what's untested in this feature".
6. **Diff-aware review context** — given a branch/PR, return a structural summary of what
   changed (routes added, widgets touched, blocs modified) for AI code review.
7. **Cross-repo linking** — multiple Flutter repos + shared packages in one index.
8. **More state-management extractors** — GetX, classic Provider, MobX (good first issues
   for community contributors once open-sourced).
9. **Generated architecture docs** — produce/refresh an ARCHITECTURE.md from the index so
   human-facing docs never go stale.

---

## 9. Engineering Standards

### 9.1 Code style
- TypeScript `strict: true`, plus `noUncheckedIndexedAccess: true`. No `any` (use `unknown` + narrowing). No non-null `!` except in tests.
- ESLint typescript-eslint strict preset + Prettier defaults. CI fails on warnings.
- Naming: types `PascalCase`; functions/vars `camelCase`; one concept per file; file names `kebab-case.ts` matching primary export (`widget-extractor.ts` → `extractWidgets`).
- Functions small and single-purpose; prefer pure functions in extraction layer (CST in → data out, no I/O) — this is what makes them trivially testable.
- No premature abstraction: duplicate twice before extracting a helper (rule of three).

### 9.2 Comments & documentation
- Comments explain **why**, never narrate *what* the code already says.
- Every tree-sitter query gets a doc comment showing **a Dart snippet it matches and the CST shape observed** (the empirical evidence from dump-tree). Example:

```ts
/**
 * Matches: `class UserBloc extends Bloc<UserEvent, UserState> {`
 * Observed CST (tree-sitter-dart @ <commit/version>):
 *   (class_definition name: (identifier) (superclass (type_identifier) (type_arguments ...)))
 * Note: `mixin class Foo` also reaches here; flavor decided in classify().
 */
```
- Every non-obvious decision gets a one-line `// Decision:` comment linking back to the relevant section of this doc.
- Public API of each layer documented with TSDoc on the interface, not the implementation.

### 9.3 Testing strategy
- **Fixtures are the quality engine.** `fixtures/<topic>/` holds real-world Dart files (copied/sanitized from the enterprise repo) + expected extraction snapshots. Every bug fix starts by adding the failing fixture.
- Test pyramid: many extractor unit tests (pure: CST → data) → index integration tests (mini fake repo in `fixtures/mini-app/`) → a few end-to-end MCP tests (spawn server, call tool over stdio, assert response).
- Snapshot tests for tool *response formatting* (the LLM-facing contract is the formatted text).
- Benchmark test (non-blocking, tracked): parse+extract time per 100 files; alert on regression > 2×.
- Coverage target: extraction layer ≥ 90%; don't chase numbers in plumbing.

### 9.4 Error handling
- Per-file failures are data, not exceptions: `FileEntry.parseErrors: string[]`, surfaced in `get_project_map` as an index-health line.
- Tool handlers never throw raw: catch → return an MCP error result with an actionable message.
- All logging to **stderr** with levels; stdout belongs to the protocol.

### 9.5 Performance principles
- Measure before optimizing — benchmark script exists from Phase 2; keep its history.
- Budgets: cold index < 10 s / 1000 files; file update < 50 ms; tool response < 100 ms; RSS < 500 MB on the monorepo.
- Lazy domain graphs: routes/widgets/wiring recompute on demand after invalidation, not on every save.

### 9.6 Git & releases
- Conventional Commits (`feat:`, `fix:`, `perf:`, `test:`); small PRs (one extractor or one tool each).
- CI: lint + typecheck + tests on every push; fixture snapshots are review artifacts — a snapshot diff in a PR is the reviewer's signal of behavior change.
- Versioning: semver; changelog per release; the tool-response *format* is part of the public contract (LLM prompts may depend on it) — format changes are minor versions, never patches.

### 9.7 Security & privacy
- Read-only filesystem access scoped to the workspace root passed at startup; refuse paths outside it.
- No network calls at runtime. No telemetry in v1. Cache stays inside the workspace (`.flutter-intel/`, gitignored).
- This matters explicitly for enterprise adoption: the pitch includes "your code never leaves the machine."

---

## 10. Working Rules for AI Assistants Building This Project

1. **Read this document first.** Architecture, layer boundaries (§4.1), and non-goals (§3.2) are decided. Do not redesign them mid-task; propose changes as an explicit "design change" discussion.
2. **Never invent tree-sitter node names.** Always run `scripts/dump-tree.ts` on a real snippet and write queries against observed output (§7.2). If the script doesn't exist yet, building it comes first.
3. **Verify, don't assume** — current library APIs (MCP SDK, web-tree-sitter, chokidar) must be checked against installed-version docs/types, not recalled. When the type checker disagrees with your memory, the type checker wins.
4. **Fixtures first.** New extraction behavior = failing fixture test first, then implementation.
5. **One phase per work session.** Finish, test, and leave green before starting the next.
6. **Respect layer boundaries.** If implementing a tool seems to require importing tree-sitter, stop — the Index layer API is missing something; extend it instead.
7. **Don't print to stdout.** It corrupts the MCP channel. `console.log` is forbidden; use the stderr logger.
8. **When extraction is ambiguous, prefer honest absence** over confident guessing: omit the field, or mark `confidence: 'syntactic'`. A missing answer costs a grep; a wrong answer costs an afternoon.
9. **Keep tool responses token-shaped** (§6 formatting rules). After changing a formatter, read the output yourself and ask: "could an LLM act on this without opening files?"
10. **Update this document** when a verified fact changes (grammar version bump, new Dart release, SDK API change) — it is the project's single source of truth.

---

## 11. Distribution & Publishing

### 11.1 Private first (team rollout, Phase 5)

- Internal git clone + `claude mcp add flutter-intel -- node /abs/path/dist/server.js`
  (or a private npm registry if the company has one). No public exposure while dogfooding.
- Enterprise fixtures stay in a **private overlay** (`fixtures/enterprise/`, separate private
  repo or gitignored) — they must never reach the public repo (see §12, legal risk).

### 11.2 Public release (when stable)

1. **npm registry** — package name reserved early; publish with `bin` entry so users run it
   without installing:
   ```bash
   claude mcp add flutter-intel -- npx -y flutter-intel-mcp
   ```
   That one line is the entire install story. The WASM parser choice (§4.3) is what makes this
   work first-try on macOS/Windows/Linux/ARM — protect that property in every dependency decision.
2. **GitHub public repo** — source, issues, README with copy-paste config for Claude Code and
   Cursor, explicit "run alongside the official Dart MCP server" positioning section.
3. **MCP registries** for discovery — official MCP registry, plus community directories
   (Smithery, PulseMCP, mcp.so). Submit once each.
4. **Announce** — r/FlutterDev, Flutter Discord, X. Angle: "Flutter-aware repo map for
   Claude/Cursor — complements the official Dart MCP server."

### 11.3 Release engineering

- npm publish from CI only (tag-triggered), with provenance enabled.
- `npx` cold-start must stay fast: keep the published package lean (no dev deps, prebuilt
  `dist/`, WASM bundled). Measure install-to-first-response time; budget < 15 s cold, < 2 s warm.
- Supported-versions statement in README: Node ≥ 20, Dart syntax through the grammar's
  supported version (state it explicitly, update on grammar bumps).

---

## 12. Risks & Mitigations (re-read quarterly)

| Risk | Reality | Mitigation |
|---|---|---|
| Grammar lags new Dart releases (Dart ships quarterly) | New syntax → localized `ERROR` nodes for weeks/months until grammar catches up | Error recovery makes this graceful degradation, not failure: rest of file still extracts. Watch grammar repo releases; add fixtures for each new Dart feature when support lands |
| Single volunteer-maintained grammar dependency | `UserNobody14/tree-sitter-dart` is active today; could stall | Pin exact version; we only consume (forkable worst-case); `yanok/tree-sitter-dart` (spec-derived) exists as fallback grammar |
| MCP spec/SDK churn | Young protocol; SDK has had breaking changes | Pin SDK version; upgrade deliberately; MCP layer is deliberately thin (§4.1) so churn is contained |
| Assistant ignores the tools and greps anyway | Tool *descriptions* decide adoption, not tool existence | Iterate descriptions like prompts; add a usage directive to the workspace CLAUDE.md; periodically check real sessions actually call the tools |
| Dynamic code is invisible to syntax-level extraction | Routes built in loops, conditionally registered providers | Honest responses: report "N routes generated dynamically at file:line — contents unknown". Never fabricate (Working Rule 8) |
| Enterprise code leaking via fixtures | Copying real repo files into a public OSS repo = leak | Sanitize/synthesize before open-sourcing; enterprise fixtures live only in the private overlay (§11.1) |
| Official Dart MCP server expands into repo indexing | Possible; it's experimental and evolving | Our moat is Flutter-domain depth (routes/widgets/wiring) + iteration speed; if they ship a repo map, pivot deeper into impact analysis & architecture rules. Review their release notes quarterly |
| Maintenance decay | Post-v1 needs ~few hours/month (grammar bumps, fixtures, triage) | Budget it explicitly; unbudgeted internal tools rot |

---

## Appendix A — Key references

- Dart language evolution: https://dart.dev/resources/language/evolution
- Dart macros cancellation: https://dart.dev/blog/an-update-on-dart-macros-data-serialization
- Official Dart/Flutter MCP server: https://docs.flutter.dev/ai/mcp-server
- tree-sitter-dart grammar: https://github.com/UserNobody14/tree-sitter-dart
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- web-tree-sitter: https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
- Adjacent (non-competing) tools for positioning: wrale/mcp-server-tree-sitter, Arenukvern/mcp_flutter, leancodepl/marionette_mcp

## Appendix B — Glossary (for team members new to the stack)

- **MCP** — Model Context Protocol: JSON-RPC over stdio between an AI client (Claude Code) and a local tool server. No network service involved.
- **CST** — Concrete Syntax Tree: full parse tree including punctuation; what tree-sitter produces.
- **Named vs anonymous nodes** — grammar-meaningful nodes vs literal tokens; queries target named nodes.
- **Query (tree-sitter)** — S-expression pattern with `@captures` matched against the tree.
- **Incremental parsing** — re-parsing after an edit while reusing unchanged subtrees.
- **Fixture** — a real code sample checked into the repo with its expected extraction, used as a regression test.
