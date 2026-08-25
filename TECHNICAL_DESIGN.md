# Flutter Code Intelligence MCP Server — Technical Design & Implementation Plan

> **Audience:** This document is written for both humans and AI coding assistants (Claude Code).
> If you are an AI assistant building this project: read this entire document before writing any code.
> Follow the **Working Rules for AI Assistants** section strictly. Do not assume — verify.

**Status:** v1 code complete — Phases 0, 1, 2 done; Phase 3 done (3a widgets + 3b bloc/cubit + 3c riverpod + 3d routes + 3e wiring), all six v1 tools shipped; Phase 4 done (4a refactor-for-reuse + 4b filesystem watcher — live incremental index, no restart); Phase 5 done (hardening: validated log levels + stdout guard, parse-error health line, npm packaging, README/LICENSE/CONTRIBUTING). See §8 for sub-phase status. Remaining: the human dogfood rollout (§8 Phase 5, not code) and deferred future features (§8).
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
| Mis-parse is **context-dependent (Phase 3b, 2026-06-13)** | The ≥2-type-arg constructor mis-parse fires only when the call sits in a **named-arg value that follows a sibling arg** (`BlocProvider(create:…, child: BlocBuilder<A,B>(…))`). When the same `BlocBuilder<A,B>(…)` owns the **whole** arg list it can occupy (e.g. `Scaffold(body: BlocBuilder<A,B>(…))`, the sole/first arg) it parses **cleanly** as `identifier + argument_part(type_arguments, arguments)`. The bloc extractor therefore handles both: clean `identifier` in the Bloc-widget family → first type arg; `relational_expression` head in the family → recover the first type arg after `<`. Fixtures `fixtures/blocs/home_screen.dart` (clean) and `fixtures/blocs/multi_bloc_view.dart` (mis-parse) pin both paths | dump-tree, this repo |
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
| Node version | ≥ 22 LTS | WASM + SDK + pnpm requirements | — |
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

/** State management wiring. (3b adds name/file/line/emitSites — mirrors WidgetInfo.) */
interface BlocInfo {
  symbolId: string;
  name: string;                  // class name as written
  flavor: 'bloc' | 'cubit';      // classified by superclass suffix (*Bloc / *Cubit)
  file: string; line: number;
  eventType?: string;            // from Bloc<Event, State> type args (bloc only)
  stateType?: string;            // Bloc<_, State> / Cubit<State>
  handlers: { eventType: string; methodName?: string; line: number }[];  // on<X>(...)
  emitSites: number[];           // lines of emit(...) call sites
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

Disk cache: `.skyatlas/cache.json` in the workspace (gitignored), keyed by file content
hash — warm start re-parses only changed files.

---

## 6. MCP Tool Surface

Few tools, sharp tools. Every description must tell the LLM *when* to use it.
All responses are compact markdown with `file:line` references, hard-capped in size
(default ~4000 tokens; `detail` param raises caps explicitly).

| Tool | Input (Zod) | Returns |
|---|---|---|
| `get_project_map` | `{ package?: string, depth?: number }` | Repo overview: packages, feature folders (listed as deep as each package needs), counts by kind, detected stack (state mgmt, router, codegen) — the "read this first" tool |
| `find_symbol` | `{ query: string, kind?: SymbolKind, package?: string }` | Matching symbols: qualified name, kind, signature line, file:line, annotations |
| `find_references` | `{ name: string, kind?: ReferenceKind[], package?: string, feature?: string, includeGenerated?: boolean, verbosity?: string }` | Where a name is used: constructions, annotations, type positions, static accesses and calls, aggregated per file and kind. Name matches, never type-resolved; falls back to shape when a full listing would exceed the budget |
| `get_symbol` | `{ id?: string, name?: string, includeChildren?: boolean }` | One symbol in depth: declaration header, type params, extends/implements, annotations, member list, edges in/out |
| `get_route_graph` | `{ router?: string, package?: string, feature?: string, pathPrefix?: string, verbosity?: string }` | Route tree with computed full paths, screen widget per route, guards: `/home → HomeScreen (lib/...:12)` indented by nesting; scoped by where the screen is declared |
| `get_widget_tree` | `{ widget: string, depth?: number }` | Static build() tree of a widget, builder callbacks marked, Bloc/Provider wiring noted inline |
| `find_state_wiring` | `{ screen?: string, bloc?: string, provider?: string }` | Connections: screen ↔ bloc/provider ↔ (syntactically visible) repositories, each edge with file:line and confidence |

**Response formatting rules (the consumer is an LLM):**
1. Markdown, not JSON. Dense lines, no prose padding.
2. Every fact carries `file:line` so the assistant can jump to source.
3. Truncate with explicit notice: `… 47 more — narrow with kind= or package=`. Never truncate silently.
4. Distinguish certainty: syntactic name-matches are labeled `(syntactic match)`, or covered by a
   response-level guarantee where every line carries the same one.
5. State the index each response was read from: file count, parse errors, how recently it changed,
   and whether a watcher still feeds it (`AI_EFFICIENCY_ROADMAP.md` §7.3).
6. Empty results explain themselves, and say which kind of empty they are (§7.2): the subject is
   unknown to the index (with the nearest names), it is known and unconnected, or it is known and
   the file it lives in has syntax the grammar could not parse.

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
- Register in Claude Code (`claude mcp add skyatlas -- node dist/server.js`), invoke ping from a chat.
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

#### 3b — Bloc/Cubit ✅ **complete (2026-06-13)**
- Detect `*Bloc`/`*Cubit` subclasses (suffix rule, mirroring 3a's `endsWith('Widget')` — catches `HydratedBloc`/`HydratedCubit` without a hard-coded list). Flavor by suffix: bloc → event+state type args, cubit → state only.
- `on<Event>(handler)` registrations (handler method name for tear-offs, absent for inline closures, + line) and `emit(...)` call-site lines. Clean method-call parse — `argument_part > (type_arguments, arguments)`.
- Emits partial `Edge`s: `createsBloc` (`BlocProvider(create:)` → bloc constructed in the closure), `readsBloc` (`context.read/watch<X>()`, and the `BlocBuilder/BlocListener/BlocConsumer/BlocSelector<X, _>` family — both the clean and mis-parsed forms, see §2). `from` = enclosing class symbolId (file path at top level); `to` = bare name (resolved to symbolIds in 3e); `confidence: 'syntactic'`.
- Model: `BlocInfo` + `Edge`/`EdgeKind`/`EdgeConfidence` in `src/model/flutter.ts`. Index: `ProjectIndex.blocs` + `.edges`, `FileEntry.blocs` + `.edges` (cache bumped to v3). No new tool (edges consumed by 3e). Fixtures: `fixtures/blocs/`.
- Known limits (Working Rule 8): suffix classification can't distinguish a real Bloc base from an unrelated class whose name happens to end in `Bloc`/`Cubit`; `readsBloc` to a repository (`context.read<UserRepository>()`) is emitted too — syntax can't tell a bloc read from any other `context.read`, so 3e resolves/filters by name-match.

#### 3c — Riverpod ✅ **complete (2026-06-13)**
- Global providers (`final xProvider = SomethingProvider<…>(…)`) — suffix rule `endsWith('Provider')` (mirroring 3a/3b) classifies them; constructor name + type args captured verbatim. `@riverpod`/`@Riverpod(…)` generated function + class providers detected as `declKind: 'generated'` (the type lives in the un-generated `*.g.dart`, so `providerType` is absent there).
- The §2 generic-at-value mis-parse bites single-type-arg providers (`StateProvider<int>(…)`, `FutureProvider.autoDispose<User>(…)`) → recovered from `relational_expression`; ≥2-type-arg + `.family` forms parse cleanly via `selector > argument_part > (type_arguments, arguments)`. Both paths handled.
- Emits partial `watchesProvider` `Edge`s from `ref.watch/read/listen(xProvider)`, gated on receiver `ref` (the Riverpod idiom) so it never collides with 3b's `context.read<X>()` (type-arg form). `.notifier`/`.select(…)` suffixes resolve to the base provider.
- Model: `ProviderInfo` in `src/model/flutter.ts`. Index: `ProjectIndex.providers` + `FileEntry.providers` (cache bumped to v4). No new tool (edges consumed by 3e). Fixtures: `fixtures/riverpod/`.
- Known limits (Working Rule 8): the `endsWith('Provider')` suffix can't tell a real Riverpod constructor from an unrelated factory named `*Provider`; an edge whose first arg is a prefixed access (`repo.userProvider`) resolves the leading identifier (`repo`), not the provider — both reconciled by name-match in 3e.

#### 3d — Routes ✅ **complete (2026-06-13)**
- go_router: `GoRoute`/`ShellRoute`/`StatefulShellRoute` nesting read from the CST (no paren counting) — route ctors parse cleanly (not generic at value position, so the §2 mis-parse does not bite). `argsOfCall` skips named-constructor selectors (`StatefulShellRoute.indexedStack`); `branches:` are flattened into children. `fullPath` computed by ancestor-join (absolute child path wins; shells contribute no segment and pass the parent path through). Screen widget from `builder:`/`pageBuilder:` (a `MaterialPage`/`CupertinoPage`/… page wrapper is unwrapped to its `child:`). Guards from `redirect:` (tear-off identifier, or `(inline redirect)`).
- auto_route: the hand-written `AutoRoute(page: XRoute.page, path:, guards:, children:)` table (page ref captured verbatim) **plus** the `*.gr.dart` `PageRouteInfo` fallback (§7.4) — `static const String name` + the `PageInfo(builder:)` returned widget give the real screen. `get_route_graph` merges them by route name (`HomeRoute → HomeScreen`), falling back to the generated table when no hand-written one is indexed.
- Honest absence (§12, Working Rule 8): a `routes:` given by reference (`GoRouter(routes: x)`) or a collection-`for`/`if`/spread is reported as a `DynamicRouteNote` — static siblings in the same list are still extracted.
- Model: `RouteInfo` + `DynamicRouteNote` in `src/model/flutter.ts`. Index: `ProjectIndex.routes`/`.dynamicRoutes` + `FileEntry.routes`/`.dynamicRoutes` (cache bumped to v5). Tool: `get_route_graph`. Fixtures: `fixtures/routes/`.
- A `RouteInfo` is deliberately incomplete where completing it needs cross-file data: a const `path:` stays in `pathExpr`, `...Owner.routes()` tables stay in `ProjectIndex.routeTables` outside the forest, and an auto_route entry names its generated page class. `src/index/route-view.ts` (`resolveRoutes`) closes all three — resolving consts against the indexed string consts, splicing static tables, joining paths top-down, and mapping page classes to screens. It is the single source of truth for a route's path and screen: `get_route_graph` renders it and `find_state_wiring` looks screens up in it, so both report the same path for the same route (Working Rule 6).
- Known limits: auto_route paths absent from the table are derived by the generator from the page name — we leave them unknown rather than guess; the route ctor suffix set is fixed (`GoRoute`/`ShellRoute`/`StatefulShellRoute`) so custom `RouteBase` subclasses are not detected.

#### 3e — Wiring ✅ **complete (2026-06-13)**
- Assembles the `Edge` graph the earlier sub-phases emit (createsBloc/readsBloc from 3b, watchesProvider from 3c) into resolved connections — does **not** re-extract. All resolution lives in `src/index/wiring.ts` (`computeWiring`); the tool only queries + formats (Working Rule 6 — no tree-sitter reaches the tool).
- Each edge's bare `to` is resolved to a symbolId by name-match via `ProjectIndex.byName`; `confidence: 'syntactic'` kept throughout (name-match ≠ type resolution). An unresolved `to` stays a bare name, labeled `(unresolved …)` — never invented (Working Rule 8).
- Screen ↔ bloc/provider: a screen's connections = edges whose `from` is the screen's class symbolId **plus** its `State<Screen>` companion class (a stateful screen's `context.read` is anchored on the State class). Route reachability comes from the resolved route view (3d), so a screen is found by route whether the path is a literal, a const, or mounted through a static table.
- Repositories: read the bloc/cubit class's Symbol children — constructor params + field declarations; a param/field whose type **name** resolves to a class in the index is a syntactic repo edge (§7.3 last row). Unresolved types (primitives/SDK/unindexed) are dropped.
- Tool: `find_state_wiring { screen? | bloc? | provider? }` (exactly one filter) — shows the chain screen → bloc/provider → repo, each edge with `file:line` and confidence; reverses the view (sources in, repos out) for bloc/provider filters. Honest absence (§6 rule 5) points at the detected stack. No new `FileEntry` field → wiring recomputed on demand (§9.5 lazy), **no cache bump** (stays v5). Fixtures: `fixtures/wiring/` (cross-file mini-graph). The 6th and final v1 tool.

### Phase 4 — Freshness (target: 2–3 evenings)

Split into two independently-green sub-phases: 4a is a no-behavior-change refactor
that gives the watcher its reusable primitives; 4b is the watcher itself.

#### 4a — Refactor for reuse ✅ **complete (2026-06-13)**
- Extracted `indexFile(root, relPath, packages, cache?)` from `indexer.ts`: the shared
  read → hash → (cache hit?) → parse → extract → `FileEntry` unit both `buildIndex` and the
  watcher use. Returns `null` on any read/parse failure (logged to stderr, skipped, never
  thrown — §9.4); `fromCache` distinguishes cache hits for stats. `buildIndex`'s loop is now
  three lines over it. Genuine shared logic, not a speculative abstraction (§9.1 rule-of-three N/A).
- Extracted `createWorkspaceFilter(root): Promise<WorkspaceFilter>` in `workspace.ts`: a
  reusable `shouldIndex(relPath)` test mirroring `walkWorkspace`'s exact selection (.dart only,
  never inside `HARD_SKIP_DIRS`, never matched by an applicable `.gitignore`). Shares the
  `IgnoreScope`/`isIgnored`/`HARD_SKIP_DIRS` primitives and a new `appendGitignoreScope` helper
  with the cold walk — the watcher does not reinvent ignore logic. Scopes collected once at
  build; a changed `.gitignore`/`pubspec.yaml` forces a full re-scan (4b), which rebuilds them.
  (Known limit: cross-file `!negation` ordering isn't modeled — extreme edge; a full re-scan resolves it.)
- Confirmed (no code needed): wiring is recomputed per tool call (`computeWiring` is invoked
  inside the `find_state_wiring` handler, §9.5 lazy) — it reads `index.edges` live, so the
  watcher needs **no** explicit wiring invalidation. Domain graphs (widgets/blocs/providers/
  routes/edges) live on `FileEntry` and are replaced atomically by `ProjectIndex.setFile`/
  `removeFile`, so a per-file update keeps every lookup map consistent on its own.
- No cache version bump — reuses the v5 `FileEntry` shape. Left green (build + lint + test + format).

#### 4b — Watcher ✅ **complete (2026-06-13)**
- `src/index/watcher.ts` (Index layer; calls the indexer, imports neither MCP nor tree-sitter
  — §4.1, Working Rule 6). chokidar **5.0.0** (verified against its installed types, Working
  Rule 3: `watch(paths, opts)`, `ignored` is a `(path, stats?) => boolean` matcher, events
  `add`/`change`/`unlink`, `close()` returns a Promise). `startWatcher(root, index, opts)`
  resolves once chokidar fires `ready` (armed), so callers/tests never race setup. Debounce 200 ms (§8).
- Events: `add`/`change` → `indexFile(root, rel, index.packages)` → `index.setFile`; `unlink` →
  `index.removeFile(rel)`. Rename surfaces as unlink+add — both handled by the same paths. A
  per-event `WorkspaceFilter.shouldIndex` (4a) gates upserts to exactly the cold-walk set.
- Mass-change guard: > **50** files in one debounced burst (branch switch / `git pull`) → fall
  back to a full `buildIndex` re-scan folded into the live instance via
  `ProjectIndex.replaceWith` (the server holds that reference — can't swap it). The cache stays
  warm so unchanged files are cheap. A changed `pubspec.yaml` (package map) or `.gitignore`
  (ignore rules) also forces a full re-scan, which rebuilds the workspace filter. `// Decision:`
  for N=50 is in the source (comfortably above a hand-save, far below a branch switch).
- Debounced disk-cache save (2 s, separate from the 200 ms event debounce) keeps
  `.skyatlas/cache.json` fresh for warm restarts; `close()` flushes a pending save. No
  cache version bump — reuses the v5 `FileEntry` shape.
- Wiring needs **no** invalidation: `computeWiring` runs per `find_state_wiring` call (§9.5
  lazy) and reads `index.edges` live; `setFile`/`removeFile` keep every map consistent atomically.
- Robustness (§9.4): per-file read/parse failures return `null` from `indexFile` (logged to
  stderr, skipped); a full-re-scan failure leaves the index intact; watcher errors are logged.
  The watcher and index never die. Wired into `server.ts` after the initial `buildIndex`
  resolves, against the same instance; a watcher failure is logged and swallowed.
  (Also fixed: `server.ts` now runs `main()` only as the CLI entrypoint, so importing it in
  tests has no side effects — previously it spawned a stray server/watcher on the test's cwd.)
- Tests (`watcher.test.ts`): in-process, copy `mini-app` to a temp root, build, watch, mutate on
  disk; await a per-batch callback via a buffering `BatchWaiter` (no sleep-flaky `setTimeout`),
  and a bounded poll-until for the through-the-tool route assertion. Covers change/add/unlink,
  the mass-change full re-scan, a pubspec full re-scan, debounced-cache freshness, the update
  budget, and **a route-file edit changing `get_route_graph` output** (the exit criterion,
  asserted through the real MCP tool over an in-memory transport). Watcher exposes a `usePolling`
  option (legit for network FS) that tests use to make event delivery deterministic.
- **Exit criterion (met):** edit a route file, ask `get_route_graph`, see the change without restart; single-file update < 50 ms.

### Phase 5 — Hardening & team rollout ✅ **code complete (2026-06-13)**
- Structured logging to stderr with a validated `SKYATLAS_LOG=debug|info|warn|error` level (default `info`; an invalid value falls back to `info` rather than disabling the filter). A guard test (`src/shared/logger.test.ts`) scans production `src/` and fails the build on any `console.*`/`process.stdout` — stdout stays the exclusive MCP channel (Working Rule 7).
- Graceful degradation: parse error in one file → logged, skipped, index continues. `get_project_map` surfaces an index-health line naming the broken files; an in-memory MCP test (`src/tools/get-project-map.test.ts`) pins it against a deliberately broken `.dart`. A broken file yields `parseErrors` (localized ERROR node), not an index failure.
- Packaging (publish-ready, not published): `package.json` `"files"` ships only `dist/` + the vendored `.wasm` + `GRAMMAR_VERSION`; `npm pack` = 59 files, ~195 KB packed (no src/fixtures/test leaks). `node dist/server.js <repo>` boots from a clean checkout, resolves the wasm by `import.meta.url` abs path, and writes nothing to stdout pre-handshake. Cold local boot is sub-second; the §11.3 <15 s budget is the one-time `npx -y` download.
- README (the exit criterion): pitch, Node ≥ 20 + grammar version, Claude Code (`claude mcp add … node dist/server.js <repo>`, `-s project`) + Cursor install, `.skyatlas/` gitignore note, the six tools with per-tool "ask Claude X", run-alongside-the-Dart-MCP-server, a paste-in `CLAUDE.md` navigation directive (§12), verify-it-works, and the security/privacy guarantees (§9.7). `LICENSE` (MIT) + `CONTRIBUTING.md` (dogfood ladder) added.
- **Exit criterion (code):** a teammate installs from README alone. The human dogfood ladder (you → 2 teammates → whole team) is the remaining non-code rollout step, captured in `CONTRIBUTING.md`. Every wrong answer becomes a fixture before it becomes a fix.

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
- No network calls at runtime. No telemetry in v1. Cache stays inside the workspace (`.skyatlas/`, gitignored).
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

- Internal git clone + `claude mcp add skyatlas -- node /abs/path/dist/server.js`
  (or a private npm registry if the company has one). No public exposure while dogfooding.
- Enterprise fixtures stay in a **private overlay** (`fixtures/enterprise/`, separate private
  repo or gitignored) — they must never reach the public repo (see §12, legal risk).

### 11.2 Public release (when stable)

1. **npm registry** — package name reserved early; publish with `bin` entry so users run it
   without installing:
   ```bash
   claude mcp add skyatlas -- npx -y skyatlas-mcp
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
