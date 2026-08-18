# skyatlas-mcp — Verified Issue & Fix Specification

**Audience:** an AI coding agent (or human) implementing these fixes with no prior context.
**Source of findings:** live evaluation of skyatlas-mcp v0.2.0 against a real 4,784-file Flutter
monorepo (`arena-pro-mobile`: 66,757 symbols, 10 packages, Bloc + go_router + injectable).
**Date of evaluation:** 2026-08-14.

---

## 0. How to use this document

Every issue below follows the same structure:

| Section | Meaning |
|---|---|
| **Status** | `VERIFIED` = root cause read in source. `MEASURED` = observed behavior, cause inferred. |
| **Reproduce** | Exact steps to see the defect yourself. **Do this first.** |
| **Root cause** | The actual code, quoted, with `file:line`. |
| **Layer constraint** | Which architectural layer may hold the fix. **Violating this will break the build's design rules.** |
| **Fix** | Concrete change. |
| **Test** | How to pin it using the repo's existing test machinery. |
| **Do NOT** | Anti-patterns that look correct but are wrong here. |

### Ground rules for the implementer

1. **Verify before you code.** Every claim here includes a `file:line`. Open it. If the code has
   moved since 2026-08-14, re-locate it before editing — do not pattern-match on line numbers alone.
2. **Never invent tree-sitter node names.** This repo has a tool for this:
   `pnpm dump-tree <file.dart>` (`scripts/dump-tree.ts`). It prints the real CST. The project's own
   design doc makes this a hard rule. If you need to know what a Dart construct parses to, dump it.
3. **Respect the layer boundaries.** The architecture is strict (see §1). A fix placed one layer too
   low cannot work, because the data it needs does not exist at that layer.
4. **Preserve the honesty discipline.** This codebase never guesses. Syntactic matches are labeled
   `(syntactic)`, unresolvable things are labeled `unknown`. Do not "improve" a fix by inferring.
5. **Do not run `dart format` or reformat unrelated files.** Scope every diff to the fix.

---

## 1. Architecture you must understand before editing

Four layers. **Each depends only on the layer below it.** This is enforced by convention and is
load-bearing for these fixes.

```
MCP Layer        src/tools/       — tool definitions, arg validation, output formatting.
                                    HAS access to ProjectIndex (cross-file knowledge).
Index Layer      src/index/       — symbol store, lookup maps, watcher, disk cache, wiring.
                                    HAS access to ProjectIndex.
Extraction Layer src/extractors/  — pure CST → data functions. ONE FILE AT A TIME.
                                    NO access to ProjectIndex. NO cross-file knowledge.
Parser Layer     src/parser/      — web-tree-sitter init/parse. Knows nothing of Flutter.
```

**Verified:** `src/extractors/widget-extractor.ts` imports only:

```ts
import type { Node, Tree } from 'web-tree-sitter';
import type { WidgetFlavor, WidgetInfo, WidgetNode } from '../model/flutter.js';
import { parseTypeArgList, RESOLVER_STATICS } from './dart-idioms.js';
```

No index import. **This is intentional and must be preserved.** Extractors run per-file during
indexing and incremental re-index; giving them index access would create a circular dependency and
break the watcher's single-file re-index path.

**Consequence:** any fix requiring "is class X a Widget?" — which is cross-file knowledge — **must**
live in `src/tools/` or `src/index/`, never in `src/extractors/`.

### Key data structures (verified)

`src/model/flutter.ts:47`:

```ts
export interface WidgetNode {
  widget: string;           // Constructor name as written: "Scaffold", "ListView.builder"
  typeArgs?: string[];
  line: number;
  namedSlots: Record<string, WidgetNode[]>;
  isBuilderCallback?: boolean;
  recoveredFromMisparse?: boolean;
  branch?: true;
  dynamic?: 'mapped' | 'spread';
}
```

`src/index/project-index.ts:60-80`:

```ts
readonly files       = new Map<string, FileEntry>();
readonly symbolsById = new Map<string, Symbol>();
readonly byName      = new Map<string, string[]>();   // name → symbolIds
readonly byKind      = new Map<SymbolKind, string[]>();
readonly widgets     = new Map<string, WidgetInfo>();
readonly blocs       = new Map<string, BlocInfo>();
readonly routes: RouteInfo[] = [];
stringConsts(): Map<string, string>                   // line 217
```

---

## 2. ISSUE-1 — Widget tree renders non-widget constructors as layout nodes

**Severity: HIGH.** This is the only issue that makes the server *emit false information*.
**Status: FIXED (2026-08-14).** Both layers implemented — see "Post-fix notes" below for two spec
inaccuracies caught during implementation and one additional bug the spec's sketch would have missed
entirely. Two follow-up defects in the Layer B implementation itself were found and fixed the same
day — see "Follow-up fixes" below.

### Reproduce

Against any Flutter repo containing a `BlocListener` whose `listener:` callback dispatches an event:

```
get_widget_tree(widget="FormRejectedVersionDetailsScreen", follow=true)
```

Observed output (real, from the evaluation):

```
body: BlocListener<FormRejectedVersionCubit, FormRejectedVersionState> — :82
  listener: FormPlayerLoadConfigForRejectedVersionEvent — :91  [builder]
    rejectedFields: ...version — :95  [spread (dynamic)]
    rejectedFields: ...version — :96  [spread (dynamic)]
```

The corresponding Dart source:

```dart
body: BlocListener<FormRejectedVersionCubit, FormRejectedVersionState>(
  listener: (context, state) {
    // ...
    context.read<FormPlayerBloc>().add(
      FormPlayerLoadConfigForRejectedVersionEvent(   // <-- rendered as a widget node
        formId: formId,
        rejectedFields: {
          ...?version?.standardFields,               // <-- rendered as child widgets
          ...?version?.customFields,
        },
      ),
    );
  },
  child: ...,
)
```

`FormPlayerLoadConfigForRejectedVersionEvent` is a **BLoC event class**, not a widget. Confirmed by
the server's own tool:

```
get_symbol(name="FormPlayerLoadConfigForRejectedVersionEvent")
→ class FormPlayerLoadConfigForRejectedVersionEvent extends FormPlayerEvent
```

### Root cause

`src/extractors/widget-extractor.ts:577-585`:

```ts
/**
 * Event-handler slots (`onPressed`, `onTap`, `onChanged`, …) hold callbacks that
 * fire at runtime, not part of the static layout tree — and they often construct
 * non-widgets (Bloc events, etc.). Builder slots (`builder`, `itemBuilder`) do
 * NOT match this and are kept. Convention: handlers are `on` + CapitalizedVerb.
 */
function isEventHandlerSlot(label: string): boolean {
  return /^on[A-Z]/.test(label);
}
```

Call sites: `widget-extractor.ts:550` and `widget-extractor.ts:609`.

The author already identified this exact failure mode ("they often construct non-widgets (Bloc
events, etc.)"). The defect is that the guard is a **naming-convention heuristic** — `/^on[A-Z]/` —
and `listener:` does not start with `on`. Neither do several other real callback slots.

### Why it matters (AI-specific)

An AI consuming MCP output treats a structured tool response as higher-confidence than raw grep
output — that is the entire value proposition of this server. A silent false positive is therefore
strictly worse than no answer: the AI has no signal that the node is fabricated, and will reason
downstream as though a screen renders an event class. **The honesty discipline this codebase applies
everywhere else (`(syntactic)`, `unknown`) is violated here silently.**

### Layer constraint

There are two candidate fixes and they belong at **different layers**:

- **Layer A (`src/extractors/`)** can only widen the slot denylist, because the extractor cannot know
  what `FormPlayerLoadConfigForRejectedVersionEvent` is — that class lives in a different file.
- **Layer B (`src/tools/get-widget-tree.ts`)** *can* do a real type check, because it holds
  `ProjectIndex`. **Verified:** `get-widget-tree.ts:13,23,84,87,223` all use `index`.

Do both. Layer A is cheap and catches the common case; Layer B is the correctness backstop.

### Fix — Layer A (extractor, cheap, catches most)

Replace the naming heuristic with an explicit non-layout slot set plus the existing convention:

```ts
/**
 * Slots whose values are callbacks or factories, not static layout. Their bodies
 * construct non-widgets (Bloc events, repositories) and must not be scanned as
 * tree nodes. Builder slots (`builder`, `itemBuilder`, …) are deliberately NOT
 * here — their closures do return widgets.
 */
const NON_LAYOUT_SLOTS = new Set([
  'listener',      // BlocListener / BlocConsumer
  'listenWhen',
  'buildWhen',
  'create',        // BlocProvider / Provider factory
  'update',        // ProxyProvider
  'redirect',      // go_router
  'validator',
  'onGenerateRoute',
  'onUnknownRoute',
]);

function isNonLayoutSlot(label: string): boolean {
  // Convention: event handlers are `on` + CapitalizedVerb (onPressed, onTap, …).
  return NON_LAYOUT_SLOTS.has(label) || /^on[A-Z]/.test(label);
}
```

Then update both call sites (`:550`, `:609`). Note `:609` currently special-cases `'create'`
separately (`label !== 'create'`) — fold that into the set and delete the redundant check.

**Scalability note:** a denylist does not close the class of bug — it only shrinks it. That is why
Layer B is required.

### Fix — Layer B (tool, correct, closes the class)

In `src/tools/get-widget-tree.ts`, filter nodes during rendering. The rule must be
**conservative**, because most real widgets (`Scaffold`, `Column`, `Padding`) are Flutter SDK classes
that are **not in the index at all**:

> Drop a node **only if** its constructor name resolves in the index to a class that is known **not**
> to be a Widget. If the name is absent from the index, or its supertype chain is unresolvable, or it
> resolves to a widget — **keep it**.

Sketch (adapt to the file's existing helpers — `resolveWidgets` at `:84` and `followTarget` at `:223`
already do index lookups you can mirror):

```ts
/**
 * True when the index positively knows this constructor names a non-widget class.
 * Unknown names (Flutter SDK, external packages) return false — we never drop
 * what we cannot verify.
 */
function isKnownNonWidget(index: ProjectIndex, node: WidgetNode): boolean {
  // Named constructors: "ListView.builder" → base type "ListView".
  const base = node.widget.split('.')[0];
  if (!base) return false;
  if (index.widgets.has(base)) return false;      // positively a widget

  const ids = index.byName.get(base);
  if (!ids || ids.length !== 1) return false;     // absent or ambiguous → keep

  const sym = index.symbolsById.get(ids[0]);
  if (!sym || sym.kind !== 'class') return false;

  // A class that is indexed, is not a known widget, and whose declared supertype
  // is also not a known widget → positively non-layout.
  const superName = sym.extendsType?.split('<')[0];
  if (!superName) return false;                   // no supertype info → keep
  return !index.widgets.has(superName);
}
```

**Important:** verify `Symbol`'s field name for the supertype before coding — read
`src/model/symbol.ts`. The evaluation confirmed the model carries `extendsType`, but confirm the
exact spelling and whether it is pre-stripped of type arguments.

When a node is dropped, **do not silently delete it.** Emit an honesty marker consistent with the
rest of the codebase, e.g. append to the slot line:

```
listener: (callback — non-layout, not expanded)
```

This preserves the "never lie, never hide" contract.

### Test

The repo drives extraction through Vitest snapshots over `fixtures/` (each extractor has a matching
`src/extractors/__snapshots__/*.test.ts.snap`).

1. Add `fixtures/widgets/bloc_listener_event.dart` containing a `BlocListener` whose `listener:`
   dispatches an event constructor with a spread argument — mirror the repro above.
2. Snapshot-test the extractor: assert the `listener` slot produces **no** nodes.
3. Add a tool-level test for Layer B in `src/tools/` covering: (a) indexed non-widget → dropped,
   (b) unknown/SDK name → kept, (c) indexed widget → kept, (d) ambiguous duplicate name → kept.

Case (b) is the regression guard that matters most — an over-eager filter would silently delete
`Scaffold` and every other SDK widget.

### Do NOT

- **Do NOT** import `ProjectIndex` into `src/extractors/`. It breaks layer purity and the watcher's
  per-file re-index path.
- **Do NOT** filter by name suffix (`endsWith('Event')`). Naming conventions are not guarantees; this
  is exactly the regex-heuristic failure the project was built to escape.
- **Do NOT** drop nodes whose type cannot be resolved. Unknown ≠ non-widget.

### Post-fix notes (verified against actual code, 2026-08-14)

The spec's Layer B sketch had two inaccuracies that would have shipped a broken filter had they
been copied verbatim, plus a third bug the sketch didn't anticipate at all:

1. **`Symbol.extendsType` is a `TypeRef` object (`{ name, typeArgs }`), not a pre-formatted string.**
   `src/model/symbol.ts:61`. The sketch's `sym.extendsType?.split('<')[0]` does not compile against
   `TypeRef` and would throw at runtime against a plain string too. Correct access is
   `sym.extendsType?.name` — already split, never needed stripping.
2. **`ProjectIndex.widgets` is keyed by `symbolId`, not by class name.** `src/index/project-index.ts`
   + confirmed via `get-widget-tree.ts`'s existing `followTarget` (`index.widgets.get(sym.id)`). The
   sketch's `index.widgets.has(base)` treats `base` (a name) as a map key and would never match.
   Fixed implementation resolves by iterating `index.widgets.values()` and comparing `.name` (mirrors
   the file's own pre-existing `resolveWidgets` helper).
3. **`ProjectIndex.byName` also carries the constructor symbol under the same name as its class**
   (e.g. `LoadDataEvent` the class and `LoadDataEvent` the default constructor are two separate
   entries in `byName.get('LoadDataEvent')`). The sketch's ambiguity check (`ids.length !== 1` →
   ambiguous → keep) would see ≥2 ids for nearly every class with a plain constructor and treat it as
   ambiguous every time — silently disabling the drop path for the common case while still reporting
   the fix as active. Fixed implementation filters candidate ids to `CONTAINER_KINDS` (class / mixin /
   enum / extension / extensionType — same set `src/index/resolve.ts`'s `resolveClass` already uses)
   before counting, so a single class with an implicit constructor resolves unambiguously and a
   *true* same-name-class collision (two files each declaring `class Foo`) still falls back to keep.

**Lesson for the next fix that reads a `Symbol` field or an index map for the first time:** confirm
the field's runtime shape and the map's key with a real build (`buildIndex` against a small fixture
and inspect it directly), not just the type declaration — (3) above is a *behavioral* trap that
`tsc`/ESLint cannot catch, since `ids.length !== 1` type-checks fine no matter which ids end up in
the list.

**Test fixtures added:** `fixtures/widgets/bloc_listener_event.dart` (Layer A regression — the exact
repro from this section) and `fixtures/widget-tree/nonwidget_slot.dart` +
`fixtures/widget-tree/nonwidget_slot_dup.dart` (Layer B's four cases: indexed non-widget dropped,
unknown/SDK name kept, indexed widget kept, ambiguous duplicate name kept).

**Cache note:** `CACHE_VERSION` bumped 8 → 9 (`src/index/cache.ts`). The fix changes `namedSlots`
content for files already sitting in a v8 disk cache without changing those files' content hash, so
an un-bumped cache would keep serving the pre-fix (incorrect) tree until each file was next edited.

### Follow-up fixes (2026-08-14)

Two defects in the Layer B filter itself, found by re-reading `isKnownNonWidget` and
`widget-extractor.ts`'s `flavorFor` (`src/extractors/widget-extractor.ts:102-107`) side by side.

**1. The non-widget filter only checked one supertype hop; widget registration also only goes one
hop, so the two facts compound into a false positive.**

`flavorFor` registers a class in `index.widgets` only when its *declared* superclass name is a known
Flutter base (`FLAVOR_BY_SUPERCLASS`, or a name ending in `Widget`). It never looks past that one
name. So given:

```dart
class BaseCard extends StatelessWidget {}   // direct match → registered as a widget
class FancyCard extends BaseCard {}         // superclass is "BaseCard", not a known base → NOT registered
class SpecialCard extends FancyCard {}      // same — NOT registered, despite being a real widget
```

the pre-fix `isKnownNonWidget` (`src/tools/get-widget-tree.ts`, prior version) read `SpecialCard`'s
declared supertype (`FancyCard`), found it absent from `index.widgets`, and concluded `SpecialCard`
was non-layout — dropping a real widget from the tree with a false `(non-widget, not expanded)`
marker. The defect was structural, not a typo: the filter and the registration it depends on share
the same one-hop blind spot, so no single-hop fix at the filter site could close it.

**Fix:** `isKnownNonWidget` now walks the declared supertype chain — resolving each ancestor's own
declared supertype in turn — until it either reaches a name the index positively knows is a widget
(keep the node) or fully resolves the chain inside the index without ever finding one (conclude
non-widget). The walk is bounded (`MAX_SUPERTYPE_CHAIN_DEPTH = 20`) and cycle-guarded with a visited
set; any ancestor that is unresolvable (external/SDK base, or an ambiguous same-name declaration) or a
detected cycle stops the walk and keeps the node, preserving the "unknown is never non-widget" rule
the original filter established. Test: `fixtures/widget-tree/supertype_chain.dart` — a 3-level chain
(`StatelessWidget → BaseCard → FancyCard → SpecialCard`) with a `ChainHostScreen` build tree, asserting
the `SpecialCard` leaf is kept.

**2. `isWidgetName` re-scanned all of `index.widgets.values()` on every rendered tree node.**

For a widget tree with N nodes and a project with W indexed widgets, the filter cost O(N × W) per
`get_widget_tree` call. Fixed by building a `Set<string>` of widget names once per call (`RenderContext.widgetNames`,
constructed in `formatWidget`) and looking up in O(1) inside `isKnownNonWidget`.

No cached data shape changed by either fix — both operate purely at request time inside
`get-widget-tree.ts` — so `CACHE_VERSION` stayed at 9.

---

## 3. ISSUE-2 — `get_route_graph` and `find_state_wiring` disagree about the same route

**Severity: HIGH.** Two tools, one index, contradictory answers.
**Status: FIXED (2026-08-18).** Resolution is shared, and the cross-tool invariant is under test. The
fix is wider than the sketch below: three further divergence classes were found during
implementation, and the proposed resolver signature could not express one of them — see "Post-fix
notes".

### Reproduce

```
get_route_graph()
→ - /form-screen → FormScreen — apps/arena_360/lib/core/router/app_navigation.dart:1042

find_state_wiring(screen="FormScreen")
→ Reachable via route: (no path) — apps/arena_360/lib/core/router/app_navigation.dart:1042
```

Same route, same `file:line`, two different answers. Source at that line:

```dart
GoRoute(
  path: AppRoutes.formScreen.path,   // enum constant, not a string literal
  name: AppRoutes.formScreen.name,
  ...
)
```

with `apps/arena_360/lib/core/router/app_routes.dart:44`:

```dart
enum AppRoutes {
  formScreen('/form-screen'),
  ...
}
```

### Root cause

`src/model/flutter.ts:159-173` — `RouteInfo` stores the path in **one of three mutually exclusive
fields**:

```ts
/** Path as written (go_router), or auto_route's explicit `path:`. Absent for shells / derived paths. */
path?: string;
/**
 * Verbatim path reference when `path:` is not a string literal but a const
 * (`path: RoutePaths.home` → "RoutePaths.home"). The value is resolved against
 * [indexed string consts]; ... Never both `path` and `pathExpr`.
 */
pathExpr?: string;
/** Computed from nesting: parent fullPath joined with own path. Absent when a path is. */
fullPath?: string;
```

Const resolution requires `index.stringConsts()` (cross-file) and therefore lives at the **tool**
layer, in `src/tools/get-route-graph.ts:63` and the resolution helpers at `:243-298`.

`src/index/wiring.ts:218` does not participate:

```ts
label: r.fullPath ?? r.path ?? '(no path)',
```

It never inspects `pathExpr` and never calls the resolver. For `FormScreen`, `path` and `fullPath`
are both `undefined` (the path was written as a const, so it landed in `pathExpr`), so the fallback
`'(no path)'` fires.

### Why it matters

The contradiction forces the consumer to open the file to adjudicate — which is precisely the work
this server exists to eliminate. It also erodes trust in *every* answer: once two tools disagree, an
AI must treat both as unreliable.

### Layer constraint

Resolution needs `stringConsts()`, i.e. cross-file data. It therefore **cannot** move into
`src/extractors/`. It must live in `src/index/` (accessible to both `wiring.ts` and the tools) or be
imported by both tools from a shared module.

`src/index/` is the better home: `wiring.ts` already lives there, and `src/index/resolve.ts` (77
lines) establishes the precedent of shared resolution helpers at that layer.

### Fix

1. Create `src/index/route-path.ts` exporting a single resolver:

   ```ts
   /**
    * Display label for a route: computed full path, literal path, or a const
    * reference resolved against indexed string consts. Returns the raw
    * expression labelled "(unresolved const)" when resolution fails, and a
    * shell/path-less marker when the route genuinely has no path.
    */
   export function routePathLabel(route: RouteInfo, consts: Map<string, string>): string;
   ```

2. Move the resolution logic out of `src/tools/get-route-graph.ts:243-298` into it. Keep the existing
   semantics **exactly** — including `isShell` handling and the `"(unresolved const)"` label. This is
   a pure extraction; behavior of `get_route_graph` must not change.

3. Call it from `get-route-graph.ts` (passing `index.stringConsts()`).

4. Call it from `wiring.ts:218`. `routesForScreen` (`wiring.ts:212`) will need the consts map — thread
   `index` in, which it already receives at `:212`.

### Test

- **Regression guard:** snapshot `get_route_graph` output against `fixtures/routes/` **before** the
  extraction and assert byte-identical output after. The refactor must be behavior-preserving.
- **New coverage:** add a fixture route whose `path:` is a const reference *and* whose screen widget
  is queryable, then assert `find_state_wiring(screen=…)` reports the resolved path, not `(no path)`.
  `fixtures/wiring/` already contains a router file — extend it rather than creating a parallel one.
- **Cross-tool invariant test:** for every route in a fixture repo, assert the label produced by
  `get_route_graph` equals the label `find_state_wiring` reports for the same route. This is the test
  that would have caught the bug and will prevent its return.

### Do NOT

- **Do NOT** duplicate the resolution logic into `wiring.ts`. Two copies will drift; that drift is
  the bug you are fixing.
- **Do NOT** change `RouteInfo`'s three-field shape. `path` / `pathExpr` / `fullPath` mutual
  exclusivity is documented and relied on by the auto_route merge path.

### Post-fix notes (verified against actual code, 2026-08-18)

The const path is one of **four** ways the two tools disagreed, all with the same root cause — path
and screen resolution happening at the consumer rather than once. All four are fixed by
`src/index/route-view.ts`, which both tools now read.

**1. Const path.** As specified. `pathExpr` set, `path` and `fullPath` empty, wiring falls back to
`(no path)`.

**2. Relative child under a const parent — the proposed signature cannot express this.**
`routePathLabel(route, consts)` takes one route and has no parent context, so for
`path: RoutePaths.edit` (`'edit'`) nested under `path: RoutePaths.detail` (`'/detail'`) the best it
can return is `edit`. The correct `/detail/edit` needs the parent's *resolved* path, which exists
only after that parent's const is resolved — the extractor cannot precompute it into `fullPath`. The
shipped resolver therefore walks the forest top-down and carries the resolved parent path into each
child, rather than labelling routes one at a time.

**3. Routes mounted by `...Owner.routes()` were invisible to wiring.** Static route tables live in
`index.routeTables`, not `index.routes`. Splicing them in was `get_route_graph`-local, so
`find_state_wiring(screen=…)` reported **zero routes** for a screen the graph placed at a path.

**4. Every auto_route screen was wrong.** A hand-written entry's `screenWidget` is the generated page
class (`HomeRoute`), not the screen. `find_state_wiring` matched `screenWidget === name`, so a query
for `HomeScreen` matched only the `*.gr.dart` entry — which carries no path — and missed the
hand-written entry that has one. Routes are now registered under both the resolved screen and the
page class.

**Scope correction.** The spec calls step 2 "a pure extraction; behavior of `get_route_graph` must
not change". That holds for `get_route_graph` and is enforced by a whole-output snapshot, but items
2–4 are behavior *changes* to `find_state_wiring`, and the required cross-tool invariant test cannot
pass without them. Extracting only `routePathLabel` would have left three of the four contradictions
live.

**No cache bump.** Resolution is display-time over data the extractor already produces, so no indexed
shape changed and `CACHE_VERSION` stays at 9.

**Verification on the evaluation repo** (5,054 files, 70,501 symbols): 209 routes carry a screen; for
all 209 the path `find_state_wiring` reports equals the path `get_route_graph` renders, with zero
`(no path)` results. The original repro, `find_state_wiring(screen="FormScreen")`, now returns
`/form-screen`.

---

## 4. ISSUE-3 — Output budget: caps exist but use the wrong unit

**Severity: HIGH (practical).** This is the difference between the tool being cheaper than grep and
more expensive than grep.
**Status: MEASURED (behavior), VERIFIED (cap mechanism).**

> **Correction to an earlier informal claim:** output caps *do* exist. Do not implement them from
> scratch. `src/tools/find-state-wiring.ts:29` defines `MAX_LINES = 250` and applies it via
> `capLines(...)` at `:139`, `:188`, `:233`. `src/tools/get-project-map.ts:93` uses
> `capLines(folderLines, 25, 'use package= to narrow')`. The mechanism is sound; the **unit and
> defaults** are the problem.

### Measured cost on a real repo

| Call | Approx. response size |
|---|---|
| `get_route_graph()` (215 routes) | ~5,000 tokens |
| `find_state_wiring(screen="FormScreen")` (8 blocs) | ~4,500 tokens |
| `find_state_wiring(bloc="FormPlayerBloc")` | ~4,000 tokens |

Sizes are estimated from response length in the evaluation session, not instrumented. **Before
tuning anything, instrument it** — see "Test" below.

### Why the line cap does not bind

`MAX_LINES = 250` caps *lines*, but the lines are long and highly redundant. Two amplifiers:

1. **Repetition across blocs.** `find_state_wiring(screen="FormScreen")` expands the full dependency
   list of *each* of 8 blocs. `FormPlayerBloc` alone has 33 constructor dependencies, each printed as
   a full line with two absolute paths:

   ```
   usecase _getConstructionFormUseCase: GetConstructionFormUseCase — apps/arena_360/lib/features/forms/domain/usecases/get_construction_form_usecase.dart:8 (via apps/arena_360/lib/features/forms/presentation/blocs/form_player/form_player_bloc.dart:130, syntactic)
   ```

   That single line is ~60 tokens. 250 such lines is ~15,000 tokens — the cap is far above any useful
   budget.

2. **No aggregation of repeated edges.** `find_state_wiring(bloc="FormPlayerBloc")` emitted ~30
   separate `readsBloc` lines differing only in line number:

   ```
   readsBloc · .../forms_screen.dart:541 (syntactic)
   readsBloc · .../forms_screen.dart:717 (syntactic)
   readsBloc · .../forms_screen.dart:880 (syntactic)
   ...
   ```

   These carry one fact and should collapse to one line.

3. **Per-line honesty labels.** `(syntactic)` repeats on every line. The response already states the
   caveat in its footer. Stating it once per response, and marking only exceptions, removes hundreds
   of redundant tokens without losing the guarantee.

### Fix

Three independent changes, in increasing order of effort:

**(a) Aggregate repeated edges.** Group edges by `(kind, sourceFile)` and emit one line with a line
list:

```
readsBloc · apps/.../forms_screen.dart:541,717,880,908,949,961,1167,1205,1222  (9 sites)
```

**(b) De-duplicate dependency expansion.** Within one response, print a bloc's dependency list at
most once. On repeat, reference it:

```
→ FormPlayerBloc (bloc) — .../form_player_bloc.dart:75  [33 deps — see above]
```

**(c) Add a `verbosity` parameter** to `find_state_wiring`, `get_route_graph`, and `get_widget_tree`:

| Value | Behavior |
|---|---|
| `summary` | Shape + counts + stable ids. No dependency expansion. |
| `normal` (default) | Current output, with (a) and (b) applied. |
| `full` | Everything, current behavior. |

`summary` for the `FormScreen` case would be roughly:

```
# State wiring: screen 'FormScreen' — .../forms_screen.dart:56
Reachable via route: /form-screen — .../app_navigation.dart:1042
Wires 8 blocs:
  FormPlayerBloc (bloc, 33 deps)                 [id: .../form_player_bloc.dart#FormPlayerBloc]
  FormAssignPermissionCubit (cubit, 3 deps)      [id: .../form_assign_permission_cubit.dart#FormAssignPermissionCubit]
  ...
Re-run with verbosity="normal" or bloc=<name> to expand.
```

~200 tokens instead of ~4,500, and every entry carries a **stable id** the caller can drill into with
`get_symbol` or `find_state_wiring` — no re-search round-trip.

**Recommended default:** keep `normal` as the default so existing users see no regression, but make
`summary` the documented first call in each tool's description (the descriptions already steer usage
well — e.g. `get_project_map` says "Call this FIRST in a session").

### Test

1. **Instrument first.** Extend `scripts/benchmark.ts` (57 lines, already records to
   `benchmarks/history.jsonl` under `--record`) to capture **response character/token size** per tool
   call against a fixture repo, not just indexing time. Without this you are tuning blind.
2. Add budget assertions: e.g. `summary` output for any tool must be < 500 tokens; `normal` < 2,000.
   Fail the test if exceeded — this prevents silent regrowth.
3. Assert (a) and (b) preserve information: every `file:line` present in `full` output must be
   recoverable from `normal` output.

### Do NOT

- **Do NOT** simply lower `MAX_LINES`. Truncation loses information silently; aggregation does not.
  Truncation also hits the *end* of the response, which is arbitrary — the dropped content is not the
  least important content.
- **Do NOT** remove the `(syntactic)` guarantee. Move it to the header; do not delete it.
- **Do NOT** drop `file:line` references to save tokens. They are the highest-value tokens in the
  response — they are what makes the answer actionable.

### Post-fix notes (instrumented against the evaluation repo, 2026-08-18)

**Instrumented first, as this section demanded.** `scripts/response-probe.ts` drives all six tools
over an in-memory MCP transport and records characters, lines, longest line and latency per call;
`benchmark.ts` writes them to `benchmarks/history.jsonl`. Calls are derived from the index (widest
bloc by constructor arity, widget creating the most blocs) so the probe runs against any workspace and
two runs over one repo compare. Characters are the recorded unit — exact and tokenizer-independent;
tokens are reported as `chars / 4`.

**Measured, before any change** (5,054 files / 70,501 symbols). The estimates in this section were
close for wiring and 33% low for the route graph:

| Call | est. tokens | measured | lines |
|---|---|---|---|
| `get_route_graph()` | ~5,000 | **6,674** | 224 |
| `find_state_wiring(screen="FormScreen")` | ~4,500 | 4,366 | 83 |
| `find_state_wiring(bloc="FormPlayerBloc")` | ~4,000 | 3,573 | 100 |

The core claim holds: **no line cap ever fired.** The widest response was 224 lines against a cap of
250, at 119–210 characters per line.

**Three corrections to the diagnosis.**

1. **The dominant cost is repeated file paths, which this section does not mention.** 52% of the route
   graph's characters were `.dart` paths — 219 references to **8 distinct files**, and only 8 file
   transitions in render order. Wiring responses were 65–68% path characters, of which the `(via …)`
   clause alone was 21–35%: a bloc's dependency list repeats the bloc's own path once per dependency.
   Factoring that out is aggregation, not truncation, so it is the fix this section's "Do NOT" rules
   ask for, and it is worth more than (a), (b) and (c) combined.
2. **Fix (b) — "de-duplicate dependency expansion" — is a no-op on real data.**
   `find_state_wiring(screen="FormScreen")` expands 8 *distinct* blocs; no bloc appears twice in one
   response, so there is nothing to reference back to. Only 4 dependency *types* recur, under
   different members of different blocs, and collapsing those would drop facts. The real
   repeated-expansion problem is in a tool this section does not cover: `get_widget_tree(follow=true)`
   was **65% duplicate lines**, because a widget reached down several branches (a `BlocConsumer` with
   two builders, six times over) had its whole subtree inlined again each time.
3. **The `(syntactic)` label carries no information at all.** `EdgeConfidence` is
   `'exact' | 'syntactic'` and **nothing in the codebase emits `'exact'`** — all 3,363 edges in the
   evaluation repo are syntactic. The footer already states the guarantee, so the label moved there;
   a non-syntactic confidence is still labelled inline, which keeps the guarantee exact rather than
   merely stated.

**What shipped**, in order of measured value: character-unit budgets alongside the line caps
(`capChars`, `capBody`); location compaction (`FileScope`) in two forms — unlabelled `:120` where a
block's lines carry one location each, and labelled `UserBloc:120` where a line carries two, because
a bare reference on a line that also names another file is ambiguous, and an anchor that names its own
referent needs no reading rule; call-site aggregation; expand-once for followed widgets; `verbosity`.

**Measured after** (same repo, same calls):

| Call | before | after | change |
|---|---|---|---|
| `get_route_graph()` | 6,674 | **3,346** | −50% |
| `find_state_wiring(bloc=…, depth=3)` | 5,328 | **3,591** | −33% |
| `find_state_wiring(screen="FormScreen")` | 4,366 | **3,068** | −30% |
| `find_symbol(query="FormPlayer")` | 3,776 | **2,358** | −38% |
| `find_state_wiring(bloc="FormPlayerBloc")` | 3,573 | **2,173** | −39% |
| `get_widget_tree(widget="FormScreen", follow=true)` | 3,168 | **1,859** | −41% |
| All eight probed calls | 30,015 | **19,525** | −35% |

`verbosity="summary"` on the same repo: route graph 358 tokens, screen wiring 417, bloc wiring 520.

**Two deviations from this section, both deliberate.**

- **`normal < 2,000 tokens` is not attainable on this repo and is not asserted there.** 215 routes at
  one line each is ~11,000 characters of irreducible fact, and a screen wiring 8 blocs across 53
  dependencies is ~2,700 tokens of it. Compaction cannot go below the facts; only scoping can, and
  scope filters on `get_route_graph` are `AI_EFFICIENCY_ROADMAP.md` item #1, not this issue. The
  budget assertions therefore run against fixtures (`summary` < 500, `normal` < 2,000 tokens), and
  real-repo sizes are recorded per run in `benchmarks/history.jsonl`, where §9.3's 2× rule applies.
- **`verbosity` was not added to `get_widget_tree`.** `depth=` is already that control, and the tool
  measures 1,859 tokens after expand-once; a second knob for the same purpose is dead weight. Its
  description now points at `depth=` instead.

**Also fixed, found while instrumenting** (both are the O(N × M) shape as the ISSUE-1 follow-up):

- `find_state_wiring(depth≥2)` spent **213 ms** resolving implementors by scanning all 70,501 symbols
  once per dependency. An implementors-by-interface map, built at most once per walk and only when an
  interface is reached, brings it to **10 ms**. Derived on demand rather than stored on the index,
  matching `ProjectIndex.stringConsts()` — an aggregate kept across edits can disagree with the files
  it came from.
- `find_symbol` printed constructor signatures up to **1,086 characters** long (33 injected
  parameters). It now shows the first four with an explicit `… +N more`; `get_symbol` stays the tool
  for a full declaration.

**No cache bump.** Every change is request-time formatting or a derived lookup; no indexed shape
changed, so `CACHE_VERSION` stays at 9.

**Verification.** `pnpm build`, `pnpm lint`, `pnpm test` (190 tests, 17 files) clean; `pnpm doctor`
on the evaluation repo reports 100% clean coverage with zero Tier-A skips; `pnpm benchmark` records
both budgets true (`rssUnder500Mb` measured 458 MB warm in this run — the flag reported false at
649 MB during the earlier evaluation, so treat the recorded number, not the flag, as the baseline).
New tests: `src/tools/response-budget.test.ts` asserts the per-verbosity budgets and that every
`file:line` the index resolves is recoverable from the compacted response, plus aggregation and
expand-once cases in the two tools' own suites.

---

## 5. ISSUE-4 — `get_project_map` folder depth is hardcoded to 2

**Severity: MEDIUM.** **Status: VERIFIED.**

### Reproduce

```
get_project_map()
→ ## arena_360 — apps/arena_360
   - lib: 5 file(s)
   - lib/app: 23 file(s)
   - lib/core: 297 file(s)
   - lib/features: 3664 file(s)     <-- 76% of the repo, one line, zero structure
   - lib/gen: 394 file(s)
```

### Root cause

`src/tools/get-project-map.ts:116`:

```ts
const folder = rel.split('/').slice(0, -1).slice(0, 2).join('/') || '(root)';
```

`.slice(0, 2)` hardcodes two path segments. `capLines(folderLines, 25, 'use package= to narrow')` at
`:93` then caps the list at 25 entries.

### Why it matters

For a feature-first Flutter repo — the dominant convention, and the one this server targets —
everything meaningful lives under `lib/features/<feature>/`. Depth 2 collapses the entire app into a
single uninformative line, defeating the tool's stated purpose ("Call this FIRST in a session, before
grepping or opening files, to orient in the codebase").

### Fix

Add an optional `depth` parameter (default 2, so existing behavior is unchanged; max ~4 to bound
output):

```ts
const folder = rel.split('/').slice(0, -1).slice(0, depth).join('/') || '(root)';
```

Raise the `capLines` limit proportionally when `depth > 2`, or the cap will swallow the extra detail
you just enabled.

**Better default (consider):** auto-deepen when a single folder holds a disproportionate share of the
package's files (e.g. > 40%). This makes the *first* call informative without the caller knowing to
ask — which matters, because the caller does not yet know the repo's shape. That is the whole point
of the tool.

### Test

Use `fixtures/mini-app/` (already contains a root package plus a nested `packages/shared_ui`).
Add a deep nested feature folder and assert: `depth=2` output is unchanged from today's snapshot;
`depth=3` reveals the nested folders; the cap message appears when the limit is hit.

### Post-fix notes (measured against the evaluation repo, 2026-08-18)

**The "better default" is the fix; the parameter alone is not.** Measured per package on the
evaluation repo (5,054 files), rows / characters / share held by the largest folder:

| package | depth 2 | depth 3 | depth 4 |
|---|---|---|---|
| `arena_360` (4,584 files) | 7 rows, 166 ch, **83% `lib/features`** | 71 rows, 2,352 ch, 17% | 236 rows, 10,239 ch, 5% |
| `ui_library` (145) | 2 rows, 39 ch, 99% | 9 rows, 237 ch, 79% | 21 rows, 741 ch, 56% |
| `models` (19) | 8 rows, 202 ch, 21% | 8 rows (no further split) | 8 rows |

A parameter defaulting to 2 leaves the *first* call — the one this tool exists for — describing 83%
of the repo as one line, and a caller who does not yet know the repo cannot know to raise it. A
fixed deeper default is wrong for the flat packages. Per-package deepening fits both, and the data
bounds it: dominance collapses 83% → 17% in one step, and a package with no deeper structure
saturates, so deepening it costs nothing. The rule is dominance > 40%, depth ≤ 4, and stop when the
deeper grouping does not split the package further; the choice depends only on indexed paths, so it
is deterministic and snapshot-testable. Each package heading states the depth it rendered at, which
is also how `depth=` becomes discoverable.

**Deviation from this section.** "default 2, so existing behavior is unchanged" does not hold — the
default output changes, deliberately, because unchanged behavior is the defect. `depth=2` reproduces
the old rows, and the tests assert both that and the auto-chosen depth.

**Also fixed, found while measuring.**

- **A codegen tree mirrors the tree it is generated from.** 24 of `arena_360`'s 71 depth-3 rows were
  `lib/gen/*` restating feature names already listed above them, and every generated file in the repo
  sits under that one folder. Generated files are now one row per package, consistent with §7.4;
  their count still appears, and a test asserts the rows account for every file the header counts.
- **A package with no Dart files rendered a heading and nothing else** — a blank the caller has to
  interpret. It now says so (§7.2).
- **The listing was line-capped only** (`capLines(…, 25)`), the unit ISSUE-3 established does not
  bind. It now uses `capBody`, applied per package so one large package cannot consume the budget of
  the packages rendered after it.

**Measured cost.** Whole map 424 → **1,407 tokens**, and it now names 28 features with their sizes
instead of one row covering them. `depth=2` renders 524. The extra tokens replace the second call a
caller had to make to learn the same thing.

**No cache bump.** Depth selection is request-time grouping over indexed paths; no indexed shape
changed, so `CACHE_VERSION` stays at 9.

**Verification.** `npm run build`, `npm run lint`, `npm test` (215 tests, 18 files) clean; doctor on
the evaluation repo reports 100% clean coverage with zero Tier-A skips; benchmark recorded with both
budgets true. RSS measured 452, 460, 537 and 650 MB across four runs of identical code — the flag
tracks that noise, not this change; the recorded numbers are the baseline to compare.

---

## 6. ISSUE-5 — Route builder patterns that lose the screen widget

**Severity: MEDIUM (narrow).** **Status: MEASURED.**

### Scope — measure before you fix

**3 of 215 routes** (98.6% resolution) lost their screen widget in the evaluation. The repo contains
160 block-body builders and resolves 157 of them. **This is a narrow gap, not a systemic failure.**
Do not over-engineer it.

### The two failing patterns

**Pattern A — local-variable indirection:**

```dart
builder: (context, state) {
  final map = state.extra as Map<String, dynamic>?;
  final issueId = map?[ArgumentConstants.issueId] as String? ?? '';
  final screen = RejectedWorklogDetailsScreen(issueId: issueId);  // assigned, not returned directly
  return screen;                                                   // returns an identifier
},
```

**Pattern B — named constructor / static factory:**

```dart
builder: (context, state) {
  return AuditLogsScreen.route(extra: state.extra);   // static method, not a constructor call
},
```

### Fix

In `src/extractors/route-extractor.ts` (673 lines — the largest extractor), where the builder body is
scanned for the screen constructor:

- **Pattern A:** when the returned expression is a bare identifier, resolve it *within the same
  function body* to its local `final <name> = <ConstructorCall>(...)` declaration. This is
  single-file, single-scope — legal at the extractor layer, no index needed.
- **Pattern B:** accept `Type.method(...)` as a screen reference when the receiver is a
  capitalized identifier. Record the widget as `AuditLogsScreen` — but **only if** you can label it
  honestly. Prefer emitting `AuditLogsScreen (via .route factory)` over silently claiming it is a
  direct construction, since a static factory may return a different widget.

**Verify the CST shape first:** run `pnpm dump-tree` on a file containing each pattern before writing
any matcher. Do not guess node type names.

### Test

Add `fixtures/routes/builder_indirection.dart` with both patterns plus a control (direct
`=> const Screen()`), and snapshot the extractor output. Then run `pnpm doctor <real-repo>` before
and after to confirm no regression in overall parse coverage.

### Do NOT

- **Do NOT** follow identifiers across function boundaries or files at the extractor layer. Local
  scope only. Anything wider belongs at the index layer.
- **Do NOT** report a static-factory result as a plain constructor. Label it.

---

## 7. ISSUE-6 — Cosmetic: record return types keep raw source whitespace

**Severity: LOW.** **Status: MEASURED.**

### Reproduce

```
get_symbol(name="FormPlayerBloc")
→ - method ({
    Map<String, CustomFieldPayload> standardFields,
    Map<String, CustomFieldPayload> customFields,
  }) _buildStandardFieldsAndCustomFields(...) — :2739
```

A Dart record return type spanning multiple source lines is emitted verbatim, breaking the
one-member-per-line format that makes the output scannable.

### Fix

Normalize whitespace in verbatim type text before rendering: collapse runs of whitespace (including
newlines) to a single space. Do this **at the render layer** (`src/tools/format.ts` or the member
formatter in `src/tools/get-symbol.ts`), **not** in the extractor — the model's contract is that type
fields hold *verbatim source text*, and the design doc's "honesty rule" depends on that. Presentation
normalization is a display concern.

### Test

Add a fixture with a multi-line record return type; assert one output line per member.

---

## 8. ISSUE-7 — `SERVER_VERSION` is stale

**Severity: TRIVIAL.** **Status: VERIFIED.**

`src/server.ts` hardcodes `SERVER_VERSION = '0.1.0'` while `package.json` is at `0.2.0`. Only affects
the version reported to the MCP client during handshake.

**Fix:** read the version from `package.json` at build time, or add a release-checklist assertion that
the two match. A test asserting `SERVER_VERSION === pkg.version` is the durable fix — the constant
will drift again otherwise.

---

## 9. Missing capabilities (new features, not defects)

Ranked by how often the gap forced a fallback to `rg` during the evaluation.

### 9.1 `find_references` — highest value

**Gap:** `find_symbol` is declarations-only by design ("Find Dart declarations by name"). There is no
way to ask "who calls / reads / constructs X". This is the single most common code-navigation
question, and it currently falls back to grep — directly undercutting the server's premise.

**Design notes:**
- The index already stores an `Edge[]` graph with `constructsWidget`, `readsBloc`, `createsBloc`,
  `watchesProvider`, `extends`/`implements`/`mixesIn`, `imports` — a substantial reference graph
  already exists.
- Method/function call sites are **not** currently extracted. That is the new work: a call-site
  extractor producing `calls` edges.
- Honesty: these are name matches, not resolved calls. Label them `(syntactic)` like everything else,
  and be explicit that overload/same-name collisions are not disambiguated.
- Output budget: a hot symbol will have hundreds of references. Design this tool with `summary` mode
  and per-file aggregation **from day one** (see ISSUE-3) rather than retrofitting.

### Post-fix notes (measured against the evaluation repo, 2026-08-19)

**The existing `Edge[]` graph could not have carried this.** Measured on the evaluation repo, the
whole graph is **3,363 edges of exactly two kinds** — `readsBloc` 2,789 and `createsBloc` 574.
`EdgeKind` declares eight; `constructsWidget`, `extends`, `implements`, `mixesIn` and `imports` are
**emitted by nothing** (`indexer.ts` merges only the bloc and provider extractors' edges). Data
already indexed elsewhere — supertypes on `Symbol`, constructor calls inside `WidgetInfo.buildTree`,
param/field type names — yields 84,625 reference-like records, but with structural blind spots rather
than merely fewer: a widget constructed in a helper method is invisible because only `build()` trees
are walked, and type mentions in method bodies, static accesses and enum accesses are absent
entirely. `FormRepository` resolves to 74 such records against 149 real sites; `UIDimensions` to
4,553 against 6,719. A new extractor was necessary.

**"Hundreds of references" understates it by an order of magnitude.** Site counts per name, measured:

| name | sites | files | full listing |
|---|---|---|---|
| `UIDimensions` | 6,719 | 820 | **41,869 tokens** |
| `AppStrings` | 5,592 | 799 | — |
| `PagingEntity` | 302 | 235 | 7,628 tokens |
| `FormRepository` | 149 | 74 | 2,145 tokens |
| `FormPlayerBloc` | 45 | 11 | 373 tokens |

The distribution is long-tailed: over 9,280 referenced names the median is 4 sites and the 90th
percentile 14, while 7 names exceed 1,000. So `summary` is not a mode a caller opts into — a caller
asking about `UIDimensions` cannot know it has 6,719 sites. When the listing would exceed the
character budget the tool renders shape instead (569 tokens for that name), which is the same
"choose the informative default" conclusion `get_project_map`'s depth reached in ISSUE-4. Shape is
rendered, not truncated: a cut-off listing describes the files it happened to reach.

**The extractor cannot filter to names the workspace declares.** It runs per file with no index
(§1), so it records every name used, including `Widget` and `String`: 281,476 sites, of which the
external names are ~2,000 of 17,347 but carry a large share of the volume. Filtering at index time
against the live name set was rejected — a class added later would leave earlier files' sites
dropped in the cache, which under-reports silently.

**Storage shape decided by measurement.** Sites are stored per file, keyed by name
(`FileEntry.references`, mirroring `stringConsts`): 19.6 MB of cache against 23 MB for a flat list
carrying `${file}#${Class}` per record, and a name lookup costs one map read per file — 0.05–0.4 ms
for any name on this repo — instead of a 281k scan. Nothing is aggregated onto `ProjectIndex`: with
`removeFile`'s indexOf-and-splice pattern, a flat aggregate would cost ~5 ms per file save in the
watcher, and an aggregate kept across edits can disagree with the files it came from.

**Kinds are read off syntax, and one of them was missed by the design.** `@LazySingleton(as: X)`
parses as `annotation > identifier` with `arguments` as a sibling — not the `selector > argument_part`
a call has — so an annotation needed its own kind rather than falling through as a plain mention;
`find_references(name="LazySingleton", kind=["annotation"])` now answers "every DI registration in
the repo" (279 sites) in 590 tokens. Cascade calls (`..write()`) parse through `cascade_selector`,
a third call shape the two obvious ones do not cover.

**A typedef declares its own name in a type position.** `typedef Handler = …` is the one declaration
whose name is a `type_identifier`, so excluding declaration names only in the identifier branch left
64 declarations referencing themselves on the evaluation repo (0.06% of sites) — found by
cross-checking every recorded site against `Symbol.nameRange`, which is now a test.

**Calls are attributed by name only, and the honest limit is large.** Of 27,563 call sites on names
the repo declares, **16,958 sit on a name declared more than once** (`copyWith` 3,670, `read` 1,847,
`add` 1,345). Receivers: 10,738 name a type, 16,824 are lowercase, and of those only 4,070 match a
field or constructor-param type on the enclosing class. The receiver is therefore recorded verbatim
and the response states that it is not resolved, rather than implying a resolved call graph.

**Cost, measured cold on 5,054 files / 70,501 symbols.** Index time **10.2 s → 13.4 s** (the walk
rides the tree the indexer already parsed, so the added cost is the scan; the budget is 50.5 s for
this repo). Cache **52 MB → 81 MB**. RSS measured 490 MB on the cold run and 585 MB warm, inside the
441–650 MB band this repo already fluctuated across on unchanged code — the recorded numbers are the
baseline, not the flag. Doctor: 100% clean, zero Tier-A skips. Probe: the two `find_references` calls
recorded per run measure 547 and 652 tokens; the widest response in the suite is still
`find_state_wiring(bloc=…, depth=3)` at 3,604.

**Cache bumped 9 → 10.** A v9 entry carries no `references`, so a name's site count would have been
short by every file the cache still served — silently, and only for the files nobody had edited.

### 9.2 `get_di_graph` — highest differentiation

**Gap:** the server detects `injectable` in 1,359 files and `get_it` in 2 (via
`src/index/stack-detect.ts`), then exposes nothing queryable. The annotation data is already
extracted (`@injectable`, `@LazySingleton(as: X)` appear in `find_symbol` output today).

**Why it matters:** the official Dart MCP server does not map DI. This is a genuine moat, and in
clean-architecture Flutter repos "what implementation is bound to this interface, and in what scope?"
is a constant question. The `@LazySingleton(as: FeatureRepository)` → `FeatureRepositoryImpl` binding
is exactly the kind of whole-repo structural fact this server exists to answer.

**Suggested shape:** `get_di_graph(type?)` → registrations, scope (`@injectable` /
`@LazySingleton` / `@Singleton`), the `as:` binding target, and the module (`@module`) if any.

### 9.3 Lower priority

- **`get_file_outline(path)`** — "what is in this file" currently requires a full `Read`. Cheap to
  build on existing symbol data.
- **Bloc event → handler map** — `FormPlayerBloc` has 90 members; pairing `on<FooEvent>(_onFoo)`
  requires reading the file. The `on<Event>` sites are already extracted by `bloc-extractor.ts`.
- **`get_bloc_graph`** — cross-bloc coordination edges (which bloc dispatches into which).

---

## 10. Recommended order of work

| # | Item | Why this order | Risk |
|---|---|---|---|
| 1 | ISSUE-1 (widget filter) — **FIXED 2026-08-14** | Only issue emitting false data. Correctness before everything. | Low — additive filter, guarded by keep-on-unknown rule |
| 2 | ISSUE-2 (route/wiring resolver) — **FIXED 2026-08-18** | Pure refactor with a byte-identical regression guard available. | Low |
| 3 | ISSUE-3 (output budget) — **FIXED 2026-08-18** | Largest practical gain; unblocks real use on large repos. | Medium — needs instrumentation first |
| 4 | ISSUE-4 (folder depth) | One-line change plus a param. | Low |
| 5 | 9.1 `find_references` — **DONE 2026-08-19** | Biggest capability gap. Build after ISSUE-3 so it ships with budgeting built in. | High — new extractor |
| 6 | 9.2 `get_di_graph` | Differentiator; data already extracted. | Medium |
| 7 | ISSUE-5, 6, 7 | Narrow / cosmetic / trivial. | Low |

**Rationale for 1–2 first:** both are small, both are correctness, and both have clean regression
guards. Shipping them first means every later change is measured against a trustworthy baseline.

**Rationale for 3 before 5:** adding `find_references` to a server that already over-emits would
compound the budget problem. Fix the economics, then add the feature that will stress them hardest.

---

## 11. Verification checklist before opening a PR

- [ ] `pnpm lint` clean (ESLint runs `typescript-eslint` **strictTypeChecked**; `no-console` is an
      **error** except `console.error` — stdout is reserved for the MCP protocol).
- [ ] `pnpm test` green, including updated snapshots (review every snapshot diff — an unexpected
      snapshot change is a behavior change).
- [ ] `pnpm build` clean under `tsconfig.build.json` (`strict`, `noUncheckedIndexedAccess`,
      `exactOptionalPropertyTypes`, `noImplicitOverride`).
- [ ] `pnpm doctor <large-real-repo> --cold` shows **no** new Tier-A skips (`--json` exits 1 on any).
- [ ] `pnpm benchmark <large-real-repo> --cold` within budget (cold < 10s / 1000 files, RSS < 500MB).
      The RSS budget does **not** hold on the evaluation repo: 5,054 files / 70,501 symbols measures
      649MB warm, so `rssUnder500Mb` reports false there independently of any change under review.
      Compare against a baseline run on `main` rather than treating the flag as a gate.
- [ ] `CACHE_VERSION` in `src/index/cache.ts` bumped **if** any indexed data shape changed. Currently
      9. Forgetting this serves stale cached data shaped for the old schema.
- [ ] `CHANGELOG.md` updated.
- [ ] No `dart format` / mass reformat in the diff.

---

## 12. Confidence and provenance

| Claim | How established |
|---|---|
| ISSUE-1 root cause | Read `widget-extractor.ts:577-585`, call sites `:550`, `:609`; extractor import list confirms no index access |
| ISSUE-1 false positive is real | `get_symbol` confirms the class `extends FormPlayerEvent`; Dart source read at the cited lines |
| ISSUE-2 root cause | Read `wiring.ts:218`, `flutter.ts:159-173`, `get-route-graph.ts:63,243-298` |
| ISSUE-2 divergence classes 2–4 | Resolved every fixture route and printed its raw `RouteInfo`, then cross-checked both tools over the evaluation repo — 209 routed screens, 0 mismatches after the fix |
| ISSUE-3 cap mechanism | Read `find-state-wiring.ts:29,139,188,233`; `get-project-map.ts:93` |
| ISSUE-3 token sizes | **Instrumented** 2026-08-18 via `scripts/response-probe.ts`; recorded in `benchmarks/history.jsonl`. See §4 post-fix notes for measured values and three corrections to the diagnosis. |
| ISSUE-4 root cause | Read `get-project-map.ts:116` |
| ISSUE-5 scope (3/215) | Counted from `get_route_graph` output; failing patterns read in the target repo's source |
| ISSUE-6, 7 | Observed in tool output / read in `server.ts` |
| Missing capabilities | Confirmed absent from `src/server.ts` tool registration (exactly six tools registered) |

**Not verified — check before relying on it:**
- The exact field name and normalization of the supertype on `Symbol` (`extendsType`) — read
  `src/model/symbol.ts` before writing the ISSUE-1 Layer B filter.
- Whether `route-extractor.ts`'s builder scan has a single entry point or several — read before
  implementing ISSUE-5.
- Internals of `widget-extractor.ts` and `route-extractor.ts` beyond the cited functions were not
  read line-by-line.
