# SkyAtlas MCP — Issues Handoff (for fixing)

This document is a bug report produced by black-box testing the 6 SkyAtlas MCP
tools against a large real Flutter monorepo (~2754 Dart files, Bloc + go_router +
injectable), followed by source scouting and reproduction inside this repo.

**Your job:** fix the issues below. Do not regress the tools that work well.
Reproduction fixtures and a harness already exist in this repo (see §Repro).

---

## TL;DR verdict

5 of 6 tools are solid-to-excellent. One tool (`get_widget_tree`) is effectively
broken on real-world widgets, and two more behaviors (`find_state_wiring screen=`,
`get_route_graph` path/screen resolution) fail on common patterns. Almost all of
it traces to **one root cause: the AST walk is too shallow** — it reads only the
literal top-level expression and does not follow local-var→return, block-body
returns, builder callbacks, conditional/ternary returns, or private `_buildX()`
helper methods.

| Tool | Grade | Status |
|---|---|---|
| `get_symbol` | A+ | Keep. Best tool. Handles 2471-line / 58-member classes cleanly. |
| `get_project_map` | A | Keep. |
| `find_symbol` | A | Keep. |
| `find_state_wiring` `bloc=` / `provider=` | A | Keep. |
| `get_route_graph` | C | Structure good; **paths + some screens unresolved** (B6, B7). |
| `find_state_wiring` `screen=` | C | **False negatives on block-body `create:`** (B5). |
| `get_widget_tree` | D | **Broken on real widgets** (B1, B2, B3, B4). Top priority. |

**The honesty discipline is the suite's biggest asset — preserve it.** Every tool
labels uncertainty ("syntactic", "unresolved const", "mis-parse best-effort",
"dynamic tables can't enumerate") and never fabricates edges. Keep that property
through any fix.

---

## Root causes

- **RC1 — Shallow AST walk.** `extractWidgets` reads only the *first* construction
  found in `build()` and treats any PascalCase `Foo.bar(args)` as a widget. Drives
  **B1, B2, B3, B7**, and is the likely shape of **B5**. Highest leverage.
- **RC2 — Const resolver is string-only.** Route `path:` resolution handles string
  consts but not enum-value field access (`AppRoutes.splash.path`). Drives **B6**.
- **RC3 — Generic parse fragile at value position in a collection literal.** Drives
  **B4** (and the documented assumption in the extractor header is incomplete).

---

## Bugs

### B1 — `get_widget_tree`: builder callbacks not expanded  ⟵ TOP PRIORITY
`BlocBuilder` / `BlocConsumer` / `Builder` / `ListenableBuilder` callback bodies are
dropped. The tree stops at the builder node. Since nearly every screen in a real
Bloc app wraps its body in a builder, this makes the tool unreliable in practice.

- Origin (real app): `FormTableField` (2471-line widget) rendered as **2 nodes**;
  `_FormBodyState` stopped at `BlocBuilder`; `_DropdownSelectField` missed
  `ListenableBuilder → Column`.
- Code: [src/extractors/widget-extractor.ts:119](src/extractors/widget-extractor.ts#L119)
  `scanSequence` does descend into wrappers, but the builder's returned widget is
  often a method call (see B2) or only `[0]` is kept (see B3).

### B2 — `get_widget_tree`: `_buildX()` helper methods not inlined
Widgets composed via private helper methods that return widgets dead-end the tree,
because helper names are lowercase and fail `isConstructorName`.

- Code: [src/extractors/widget-extractor.ts:426](src/extractors/widget-extractor.ts#L426)
  `isConstructorName` rejects `_buildBody` (core starts lowercase `b`).
- There is no mechanism to resolve a `_buildX()` call to that method's own
  `return` tree. Real apps lean on this pattern heavily (FormTableField has ~30).

### B3 — `get_widget_tree`: leading `X.of(context)` local + conditional returns
A build body like:
```dart
final enabled = !ReadOnlyScope.of(context);
if (dropdown) return _DropdownField(...);
return _RadioField(...);
```
renders with root = `ReadOnlyScope.of` (a **bool**, not a widget), and both real
returns dropped.

- Cause 1: `ReadOnlyScope.of(c)` parses as `identifier + selector(.of) + argument_part`
  — **structurally identical to a named-constructor call** `Foo.bar(args)` — so
  `parsePlainInvocation` accepts it.
  [src/extractors/widget-extractor.ts:131](src/extractors/widget-extractor.ts#L131),
  [:176](src/extractors/widget-extractor.ts#L176),
  [:206](src/extractors/widget-extractor.ts#L206).
- Cause 2: only the first node is kept —
  [src/extractors/widget-extractor.ts:74](src/extractors/widget-extractor.ts#L74)
  `scanSequence(buildBody.namedChildren, false)[0]`. The local-var `.of()` is found
  before the `return`s, wins, and the conditional returns are discarded.
- Suggested direction (not implemented): prefer `return`-statement expressions as
  the tree root(s); filter known resolver statics (`.of`/`.maybeOf`/`.read`/`.watch`)
  out of widget detection; consider emitting multiple roots for conditional returns
  (honestly labelled as alternative branches).

### B4 — `get_widget_tree`: `BlocProvider` inside `MultiBlocProvider(providers: [...])`
Generics mis-parse and `..add(Event())` / block-body `create:` constructs get
listed as **phantom provider nodes**.

- Origin (real app): `FormScreen` showed `FormPlayerLoadConfigEvent` (an event)
  listed under `providers:`.
- CST: `BlocProvider<SomeBloc>(...)` at value position inside a `list_literal`
  parses as nested `relational_expression` + `record_literal`, even with a **single**
  type arg. This contradicts the header note at
  [src/extractors/widget-extractor.ts:16](src/extractors/widget-extractor.ts#L16)
  which claims single-arg generics parse cleanly — the real trigger is value
  position in a collection, not arg count. Update that assumption.
- The recovery path then segments the `record_literal` and surfaces the create
  closure's identifiers (`SomeBloc`, `LoadEvent`) as children.

### B5 — `find_state_wiring screen=`: block-body `create:` not traced (false negative)
`screen=` reports "No Bloc or provider found" when the provider uses a block-body
`create:`; it works when `create:` is an arrow.

- Confirmed behaviorally on the real app:
  - WORKS: `create: (context) => sl<ConstructionFormsBloc>()` (ProgressScreen) → bloc found.
  - FAILS: `create: (context) { final bloc = sl<FormPlayerBloc>(); ...; return bloc; }`
    (FormScreen) → "no bloc found", even though `bloc=FormPlayerBloc` correctly lists
    that same screen's children as consumers. The two directions disagree.
- **Not yet reproduced in this repo / source not read.** Likely lives in the
  `createsBloc` edge detection (`find-state-wiring.ts` / `bloc-extractor.ts`): it
  matches `sl<Type>()` / `=> Type()` arrow forms but does not follow a local-var
  assignment to its `return`. Same shape as RC1.
- Needs a fixture (see §Still-needed).

### B6 — `get_route_graph`: enum-backed path consts never resolved
Every route in the real app displayed as `AppRoutes.x.path (unresolved const)` —
**0 of 94 paths resolved**. This kills "what screen is at `/login`".

- Cause: `AppRoutes` is a Dart **enum** with a `path` field
  (`enum AppRoutes { ...; const AppRoutes(this.path); final String path; }`), so the
  route path is `AppRoutes.splash.path` — an enum-value field access. The resolver
  only handles plain string consts.
- Code: [src/model/flutter.ts:142](src/model/flutter.ts#L142) documents `pathExpr`
  being "resolved against the indexed string consts at display time". Extend the
  resolver (likely `string-const-extractor.ts` + the route display in
  `get-route-graph.ts`) to resolve `EnumName.value.field` against indexed enum
  declarations + their constructor args.
- **Not yet reproduced in this repo.** Existing fixture
  `fixtures/routes/const_paths_guarded.dart` may be a good place to add the enum case.

### B7 — `get_route_graph`: block-body / builder route builders lose the screen
A few routes show no screen, and a `ShellRoute` showed `→ BlocProvider` (the wrapper)
instead of the real screen.

- Origin (real app): routes at `:810`, `:978`, `:1050` showed no screen; ShellRoute
  at `:366` showed `→ BlocProvider`.
- Same RC1 family: the builder returns a block body / a wrapper widget, and the
  resolver only reads a single syntactically-visible widget
  ([src/model/flutter.ts:149](src/model/flutter.ts#L149) honesty note). Lower
  priority than B1–B6; honest absence is acceptable, but unwrapping one level
  (e.g. `BlocProvider(child: RealScreen())`) would help.

---

## Minor / polish

- `find_symbol` with empty query returns a **raw Zod JSON validation error**. Catch
  it and return a friendly one-liner (min length 1).
- `find_symbol` constructor signatures drop the class name
  (`factory fromJson(...)` should read `factory PackageModel.fromJson(...)`).
- High-frequency queries (`build` = 1349 matches, `fromJson` = 463) truncate at ~48
  with a "narrow with kind=/package=" hint but no offset/pagination. Acceptable, but
  an offset/cursor would help agents page through.

---

## Repro (already in this repo)

A fixture and a harness were added that reproduce **B1–B4 deterministically against
the real `extractWidgets`** (B5–B7 still need fixtures — see below).

- Fixture: `fixtures/basic/widget_tree_repro.dart` — 1 control + 4 failing patterns,
  each mirroring a real arena_360 widget.
- Harness: `scripts/repro-widget-tree.ts` — runs the real extractor + a faithful copy
  of `get_widget_tree.ts`'s renderer.

Run:
```sh
pnpm tsx scripts/repro-widget-tree.ts
```

Current (buggy) output — this is what a correct fix must change:
```
# ControlCard (stateless) — :8           ← CONTROL: correct, full tree
  Material — :13
    child: Padding — :14
      padding: EdgeInsets — :15
      child: Column — :16
        children: Text — :18
        children: Text — :19

# ConditionalReturnField (stateless) — :30   ← B3: root is a bool; returns dropped
  ReadOnlyScope.of — :37

# BuilderHelperField (stateless) — :48       ← B1/B2: dead-ends at Builder
  BlocProvider<SomeCubit> — :53
    create: SomeCubit — :54  [builder]
    child: Builder — :55

# ListenableField (stateless) — :74          ← B1: root is a resolver static; subtree dropped
  Scope.of — :79

# MultiProviderScreen (stateless) — :98      ← B4: phantom providers (SomeBloc, LoadEvent)
  MultiBlocProvider — :103
    providers: BlocProvider<SomeBloc> — :105  [generic recovered from mis-parse — slots best-effort]
    providers: SomeBloc — :107  [builder]
    providers: LoadEvent — :108  [builder]
    child: Body — :113
```

### Expected output after fix (target)
```
# ConditionalReturnField   → _DropdownField (and/or _RadioField branch), NOT ReadOnlyScope.of
# BuilderHelperField       → BlocProvider → Builder → Column → Text, Text  (inline _buildBody)
# ListenableField          → ListenableBuilder → Column → Text, Text       (NOT Scope.of)
# MultiProviderScreen      → MultiBlocProvider → providers: [BlocProvider<SomeBloc>], child: Body
#                            (no SomeBloc/LoadEvent phantom provider nodes)
```

CST evidence (run `pnpm tsx scripts/dump-tree.ts -` with the snippet on stdin):
- `ReadOnlyScope.of(c)` → `identifier + selector(.of) + selector(argument_part)`
  (same shape as a named constructor → that's why it's mistaken for a widget).
- `[BlocProvider<SomeBloc>(...)]` → `relational_expression(< >) + record_literal`
  (single type arg still mis-parses at value position in a list).

---

## Still-needed fixtures (B5–B7, not yet built)

- **B5**: a screen with a block-body `create:` returning a local var, plus a sibling
  screen with arrow `create:`. Extend `fixtures/wiring/` (see existing
  `settings_screen.dart` / `counter_screen.dart`) and assert `screen=` finds the bloc
  in both.
- **B6**: an `enum AppRoutes { ...; const AppRoutes(this.path); final String path; }`
  plus a `GoRoute(path: AppRoutes.splash.path, ...)`. Extend
  `fixtures/routes/const_paths_guarded.dart`; assert the path resolves to the literal.
- **B7**: a `GoRoute`/`ShellRoute` whose `builder:` returns `BlocProvider(child: RealScreen())`
  or a block body; assert the real screen is reported (or that absence is honestly labelled).

---

## Priority order for fixing
1. **B1 + B2 + B3** (one RC1 fix in `widget-extractor.ts` likely addresses all three):
   return-driven root selection, resolver-static filtering, helper-method inlining,
   builder-callback descent.
2. **B5** (RC1 in wiring's `createsBloc` detection).
3. **B6** (RC2 enum-value const resolution).
4. **B4** (RC3 generic parse at collection value position).
5. **B7** (RC1 route builder unwrap — lowest, honest absence is tolerable).

Keep `get_symbol`, `get_project_map`, `find_symbol`, and `find_state_wiring bloc=`
untouched, and preserve the honesty labelling everywhere.

---

# Round 2 — synthetic stress fixtures (patterns the real repo lacks)

The real repo is Bloc + go_router only. To exercise the rest of the claimed
surface, synthetic fixtures were added under `fixtures/stress/` and run through the
pure extractors via a new harness:

```sh
pnpm tsx scripts/repro-extract.ts <file.dart> [routes|providers|blocs|widgets|symbols|consts|all]
```

Fixtures: `go_router_hard.dart`, `widgets_hard.dart`, `riverpod_app.dart`,
`auto_route_app.dart` (+ `auto_route_app.gr.dart`), `bloc_hard.dart`,
`symbols_hard.dart`. Widget-tree fixtures also extended in
`fixtures/basic/widget_tree_repro.dart` (`MappedChildrenField`, `EarlyReturnField`).

## What WORKS well (validated, don't regress)
- **auto_route**: hand-written `AutoRoute` table (nested children, `fullPath` join,
  `guards: [AuthGuard]`, path params) AND `*.gr.dart` PageInfo resolution
  (`LoginRoute → LoginScreen`). The merge claim holds.
- **Riverpod**: global providers (type + typeArgs), `@riverpod` generated form,
  and `watchesProvider` edges from `ref.watch/read/listen` — including from a
  `ConsumerWidget`. Good.
- **Bloc internals**: `on<Event>` handlers (inline closure honestly has no
  `methodName`), `emitSites`, `eventType`/`stateType`, Cubit flavor. Excellent.
- **go_router**: string-literal path + name resolve; nested relative-path join
  (`/dashboard` + `settings` → `/dashboard/settings`); per-route `redirect:` →
  `guards`; path params; collection-`for` → honest dynamic note; `pageBuilder` +
  `MaterialPage(child: X)` resolves through to `X`.
- **Symbols**: extension types, generic bounds (`T extends Comparable<T>`), record
  return types, enums (values + constructor + extra fields/getters), typedefs.

## New bugs

### W1 — `get_widget_tree`: ternary return keeps only the first branch
`return dark ? const DarkScreen() : const LightScreen();` → `buildTree = DarkScreen`
only; `LightScreen` dropped with no marker. (`widgets_hard.dart#TernaryRoot`)

### W2 — `get_widget_tree`: Dart-3 switch-expression return keeps only the first case
`return switch (status) { loading => LoadingView(), error => ErrorView(), ok => OkView() }`
→ `buildTree = LoadingView` only; other cases dropped. (`widgets_hard.dart#SwitchReturn`)
W1/W2/B3 are one family: multiple result expressions collapse to the first found.

### W3 — nested generic type args are mangled (REAL parsing bug, systemic)
- Widget: `ValueListenableBuilder<List<int>>` → `typeArgs: ["List", "<int>"]`
  → renders as `ValueListenableBuilder<List, <int>>`.
- Riverpod: `StateProvider<List<int>>` → `typeArgs: ["List"]` (the `<int>` dropped).
Affects `Map<String, dynamic>`, `AsyncValue<List<X>>`, `BlocBuilder<Foo<T>, Bar>`,
etc. Root: type-arg parsing splits on the inner `<`/`>` instead of treating a
nested `type_arguments` node as one arg. Likely `parseTypeArgs`
([src/extractors/widget-extractor.ts:412](src/extractors/widget-extractor.ts#L412))
and the equivalent in the riverpod extractor. High value — nested generics are
everywhere.

### W4 — `get_widget_tree`: collection-`if` child shown as unconditional static child
`children: [Header(), if (showBanner) Banner(), ...footerWidgets, Footer()]` →
tree shows `Header, Banner, Footer` with `Banner` as a plain static child (no
"conditional" marker) and the spread silently dropped. Mild honesty gap — the
`if` child should be marked conditional (or omitted), to match the documented
"conditionals not unrolled" contract. (`widgets_hard.dart#CollectionIfChildren`)

### N2 — `get_widget_tree`: `.map((x) => Widget())` unrolled once, mis-tagged `[builder]`
`items.map((i) => Expanded(child: Text(i))).toList()` as `children:` →
one `Expanded` emitted as a static child, tagged `[builder]`. It is neither a
single static child (it's a dynamic collection) nor a Flutter builder slot. Root:
`inBuilder` flips on any `function_expression`
([src/extractors/widget-extractor.ts:142](src/extractors/widget-extractor.ts#L142)),
so `.map`/`.where`/`.expand` closures are treated like `builder:` callbacks. Either
drop these or label them "dynamic (mapped)". (`fixtures/basic/widget_tree_repro.dart#MappedChildrenField`)

### R1 — `get_route_graph`: top-level `GoRouter(redirect:)` not captured
The global auth redirect on the `GoRouter` itself is dropped (per-route `redirect:`
IS captured as a guard). This is usually the single most important guard. Surface
it (e.g. a router-level "global redirect: authGuard" line). (`go_router_hard.dart`)

### R2 — `get_route_graph`: ShellRoute wrapper shown as `screenWidget`
`ShellRoute(builder: (c, s, child) => ScaffoldShell(child: child))` →
`screenWidget: "ScaffoldShell"`. That is the shell *wrapper*, not a destination
screen. Mirrors the real-app `(shell — no path) → BlocProvider`. Consider labelling
shell wrappers distinctly from `→ screen`. (`go_router_hard.dart`)

### AR1 — `get_route_graph`: auto_route `RedirectRoute` dropped entirely
`RedirectRoute(path: '*', redirectTo: '/login')` in the hand-written table is not
extracted — the table had 3 entries, only 2 routes came out. Wildcard/redirect
routes vanish. (`auto_route_app.dart`)

### S1 — `get_symbol` / `find_symbol`: operator overloads dropped
`class Box` with `bool operator <(...)` and `T operator [](int i)` → neither appears
in the class's members (only ctor, field, and the plain `copy` method). Operator
declarations are not extracted as symbols. (`symbols_hard.dart#Box`)

### S2 — Symbols: `mixin class` mis-kinded as `class`
`mixin class Loggable {}` is reported as `kind: "class"` — the mixin capability is
lost (a plain `mixin` is correctly `kind: "mixin"`). Minor. (`symbols_hard.dart#Loggable`)

## Minor (round 2)
- Riverpod `.family` / `.autoDispose` modifiers are stripped from `providerType`
  (`FutureProvider.family<Item, String>` → `"FutureProvider"`). `.family` matters
  (the provider takes an argument); consider preserving the modifier.
- Riverpod edge `from` for a `ref.read` inside another provider's body is the file
  path, not the enclosing provider. Coarse but honest.

## B6 fix feasibility note (enum-backed route paths)
The symbol extractor captures enum **values** (`low`, `high`) as fields and the
enum **constructor**, but NOT each value's constructor arguments (`low(0)` → the
`0` is not recorded). To resolve `AppRoutes.splash.path` (B6) the extractor must
additionally capture each enum value's constructor args and map field name → arg,
and for `.name` (N1) map the value to its own identifier string. Both are needed
for the route graph to show real paths/names instead of `(unresolved const)`.

## Updated priority
1. **W3** (nested generic type args) — small, systemic, high value; affects widgets + riverpod.
2. **B1/B2/B3 + W1/W2** (one RC1 fix: return-driven, multi-branch, helper inlining, builder descent).
3. **N1 + B6** (enum `.name`/`.path` resolution — needs enum-value-arg capture in the symbol extractor).
4. **B5** (block-body `create:` in wiring).
5. **S1** (operator symbols), **R1** (global redirect), **AR1** (RedirectRoute), **B4** (collection-position generic).
6. **N2/W4** (dynamic-collection honesty), **R2** (shell wrapper label), **N3/N4/N5/S2** (polish).

---

# Implementation Plan (execution handoff)

> **Audience:** an engineer (or a Sonnet-class agent) implementing the fixes above
> in a fresh session, with only this document for context. The analysis was done
> by an Opus session; this plan encodes the decisions so execution does not need
> to re-derive them. Read **§Ground rules** first, then work the tasks **in the
> order in §Task order**. Each task is self-contained: file, location, current
> behavior, exact change, CST shape to confirm, fixture, and the assertion that
> proves it.

## Ground rules for the executor

1. **Working Rule 2 — never guess a CST shape.** Before touching any parsing
   code, dump the real tree:
   ```sh
   echo 'SNIPPET' | pnpm tsx scripts/dump-tree.ts -
   ```
   The node names quoted in this plan were observed against tree-sitter-dart
   @ a9bdfa3 (see `vendor/GRAMMAR_VERSION`). If your dump disagrees, trust the
   dump and note the divergence in the code comment — the comment drives the
   logic in this codebase, so a wrong comment becomes a wrong fix.
2. **Two reproduction harnesses already exist — use them as the feedback loop.**
   - `pnpm tsx scripts/repro-widget-tree.ts` — runs the real `extractWidgets`
     plus a faithful copy of the `get_widget_tree` renderer over
     `fixtures/basic/widget_tree_repro.dart`. This is the loop for B1–B4, W1–W4, N2.
   - `pnpm tsx scripts/repro-extract.ts <file.dart> [routes|providers|blocs|widgets|symbols|consts|all]`
     — runs a single pure extractor over a fixture. This is the loop for B5, B6,
     R1, R2, AR1, S1, S2.
   Run the relevant harness **before** the change (capture buggy output) and
   **after** (confirm target output). Also run `pnpm test` — there are
   `*.test.ts` + `__snapshots__` next to every extractor; update snapshots only
   when the new output is genuinely correct (`pnpm test -u`), never to silence a
   regression.
3. **Preserve the honesty discipline (TL;DR + §5.1).** Never fabricate an edge,
   a screen, or a path. When a construct can't be resolved, emit it verbatim with
   a label (`(unresolved const)`, `recoveredFromMisparse`, `dynamic (mapped)`,
   `alternative branch`). A correct "I can't see this" beats a confident wrong
   answer. Do not regress `get_symbol`, `get_project_map`, `find_symbol`, or
   `find_state_wiring bloc=`.
4. **One concern per commit**, named by bug id (e.g. `fix(widget-tree): W3 nested generic type args`).
   Land tasks in §Task order; each builds confidence for the next.
5. **Add a fixture for every bug that lacks one** (B5, B6, B7, R1, AR1 — see
   §Still-needed fixtures). A fix without a fixture+assertion is not done.

## Shared building blocks (build these first, reuse across tasks)

- **`RESOLVER_STATICS`** — a shared `Set<string>` of method names that return
  values, not widgets/blocs: `of`, `maybeOf`, `read`, `watch`, `select`. Used by
  the widget extractor (B3, B1) to reject `Foo.of(context)` masquerading as a
  named-constructor widget, and already implicitly relevant to the bloc extractor.
  Put it in a small shared module (e.g. `src/extractors/dart-idioms.ts`) and import
  from both, so the two never drift.
- **`isConstructorName` stays as-is** (it already accepts leading `_`, [widget-extractor.ts:426](src/extractors/widget-extractor.ts#L426)),
  but B2 needs a separate predicate `isBuildHelperName` = `/^_?build[A-Z_]/` or
  lowercase-leading `_buildX`, used only to trigger helper-method inlining.

---

## Task order

Ordered by leverage and by how much each de-risks the next. Tasks within a group
share a root cause and should land together.

1. **W3** — nested generic type args (smallest, systemic, unblocks clean output everywhere)
2. **B1 + B2 + B3 + W1 + W2** — the RC1 widget-tree rewrite (the core of the work)
3. **W4 + N2** — dynamic-collection honesty (rides on the same code paths)
4. **B6 + N1** — enum-value-arg capture + enum const resolution
5. **B5** — block-body `create:` in wiring
6. **B4** — collection-position generic mis-parse (hardest CST; do after the easy wins)
7. **R1, R2, AR1, B7** — route-graph polish
8. **S1, S2, + minor polish** (empty-query Zod catch, ctor class-name, pagination)

---

### Task 1 — W3: nested generic type args mangled
**Files:** [src/extractors/widget-extractor.ts:412](src/extractors/widget-extractor.ts#L412) (`parseTypeArgs`); the equivalent type-arg reader in `src/extractors/riverpod-extractor.ts`.
**Now:** `parseTypeArgs` does `ta.namedChildren.map((c) => c.text)`. For
`ValueListenableBuilder<List<int>>` the `type_arguments` node contains a child
that itself is/contains a nested `type_arguments`, and the flat `.map` splits it
into `["List", "<int>"]`. Riverpod's reader drops the `<int>` entirely.
**CST to confirm:**
```sh
echo 'final x = ValueListenableBuilder<List<int>>(); final y = Map<String, dynamic>();' | pnpm tsx scripts/dump-tree.ts -
```
Expect each *top-level* type argument to be a single `type`/`type_identifier`
node whose own subtree holds the nested `type_arguments`. Reconstruct each
top-level arg from its **full node text** (`c.text` of the arg node), not by
flattening grandchildren. The fix is: iterate only the *direct* type-argument
children of the `type_arguments` node and take each one's verbatim text as one arg
— so `List<int>` stays one string `"List<int>"`.
**Target:** `ValueListenableBuilder<List<int>>` → `typeArgs: ["List<int>"]` →
renders `ValueListenableBuilder<List<int>>`. `Map<String, dynamic>` →
`["String"... ]`? No — `Map` has two args: `["String", "dynamic"]`. The rule:
split on the **top-level commas only**; never on inner `<`/`>`.
**Fixture/loop:** `fixtures/stress/widgets_hard.dart` already has the cases; run
`pnpm tsx scripts/repro-extract.ts fixtures/stress/widgets_hard.dart widgets` and
`... riverpod_app.dart` before/after. Add a unit assertion in
`widget-extractor.test.ts` and `riverpod-extractor.test.ts`.

### Task 2 — B1/B2/B3/W1/W2: return-driven, multi-branch widget tree
This is one rewrite of how a build body's **root(s)** are chosen, plus two
descent rules. It is the heart of the work. Do it as four sub-changes against
[src/extractors/widget-extractor.ts](src/extractors/widget-extractor.ts), verifying each with `repro-widget-tree.ts`.

**2a — Root selection is return-driven (fixes B3, W1, W2).**
- **Now:** [widget-extractor.ts:74](src/extractors/widget-extractor.ts#L74) takes
  `scanSequence(buildBody.namedChildren, false)[0]` — the *first* widget-shaped
  node anywhere in the body. A leading `final x = Foo.of(context)` wins over the
  real `return`.
- **Change:** locate the `return_statement` node(s) in the build body and use
  **their expressions** as the tree root(s). Ignore non-return statements for root
  selection (locals, asserts). `build()` always ends in a return.
- **Multi-branch:** a body may contain several returns (`if (x) return A; return B;`).
  A single return may be a ternary (`return c ? A : B;`, W1) or a Dart-3
  switch-expression (`return switch (s) { a => X(), b => Y() };`, W2). Collect
  **all** result expressions: for a ternary, both branches; for a switch
  expression, every case body; for multiple `return`s, each. Emit them as
  **multiple roots**, each labelled as an alternative branch (add an optional
  `branch?: true` / `branchLabel?` field on `WidgetNode` in
  [src/model/flutter.ts](src/model/flutter.ts), and render it honestly, e.g.
  `[branch]`). This is the honest representation — do not silently keep only one.
- **CST to confirm:** dump `return c ? const A() : const B();` and
  `return switch (s) { x => A(), y => B() };` — identify the conditional/ternary
  node type and the `switch_expression`/`switch_expression_case` node names.
- **Target (from doc §Expected):** `ConditionalReturnField` →
  `_DropdownField` (+ `_RadioField` branch), **not** `ReadOnlyScope.of`.
  `TernaryRoot` → both `DarkScreen` and `LightScreen`. `SwitchReturn` → all cases.

**2b — Filter resolver statics (fixes B3 cause 1, part of B1).**
- **Now:** `ReadOnlyScope.of(context)` parses as
  `identifier + selector(.of) + selector(argument_part)` — structurally identical
  to a named constructor `Foo.bar(args)` — so `parsePlainInvocation`
  ([:176](src/extractors/widget-extractor.ts#L176)) accepts it as a widget.
- **Change:** in `parsePlainInvocation`, when the named-constructor selector's
  identifier is in `RESOLVER_STATICS` (`of`/`maybeOf`/`read`/`watch`/`select`),
  reject the node (return `{ next }` with no node). It's a value, not a widget.

**2c — Inline `_buildX()` helper methods (fixes B2).**
- **Now:** helper calls like `_buildBody()` dead-end: lowercase-after-underscore
  fails `isConstructorName` ([:426](src/extractors/widget-extractor.ts#L426)), and
  there is no resolution from a helper call to that method's own return tree.
- **Change:** when scanning encounters a call whose name matches
  `isBuildHelperName` (see §Shared building blocks), look up the method of that
  name **in the same class body**, find its `return`(s), and recurse Task-2a root
  selection into it — inlining the helper's tree at the call site. Guard against
  infinite recursion (a `Set` of method names already being expanded). Pass the
  class body down into `scanSequence` (or capture it in a closure) so the lookup
  is available. `FormTableField` has ~30 such helpers — expect deep trees.
- **Target:** `BuilderHelperField` → `BlocProvider → Builder → Column → Text, Text`
  (the `_buildBody` content inlined), not a dead-end at `Builder`.

**2d — Descend builder callbacks reliably (fixes B1).**
- **Now:** [:142](src/extractors/widget-extractor.ts#L142) flips `inBuilder` on any
  `function_expression` and descends, but the builder's returned widget is often a
  helper call (now handled by 2c) or only `[0]` survives the old root logic.
- **Change:** once 2a/2c are in, a builder slot's closure body is scanned with the
  same return-driven logic, so `BlocBuilder(builder: (c,s) => Column(...))` yields
  the `Column` subtree. Confirm `ListenableField` →
  `ListenableBuilder → Column → Text, Text` (doc target), **not** `Scope.of`.
  Keep the `isBuilderCallback` marker on the first construction in the closure.
**Loop for all of Task 2:** `pnpm tsx scripts/repro-widget-tree.ts` — the doc's
"Expected output after fix (target)" block is the acceptance criterion. Also
exercise `MappedChildrenField`, `EarlyReturnField` in the same fixture.

### Task 3 — W4 + N2: dynamic-collection honesty
**File:** [src/extractors/widget-extractor.ts](src/extractors/widget-extractor.ts) (`scanSequence` / `slotsFromArgs`).
- **W4:** a collection-`if` child (`if (showBanner) Banner()`) currently renders as
  an unconditional static child, and a spread (`...footerWidgets`) is silently
  dropped. Mark the `if` child conditional (reuse the `branch`/conditional marker
  from Task 2a) **or** omit it, to match the documented "conditionals not unrolled"
  contract. For the spread, emit an honest marker node (e.g. `… spread (dynamic)`)
  rather than dropping it.
- **N2:** `.map((i) => Widget()).toList()` is currently unrolled once and mis-tagged
  `[builder]`, because [:142](src/extractors/widget-extractor.ts#L142) flips
  `inBuilder` on *any* `function_expression`. A `.map`/`.where`/`.expand` closure is
  not a Flutter `builder:` slot. **Change:** only treat a closure as a builder when
  it is the value of a builder-named slot (`builder`, `itemBuilder`, etc.), not for
  arbitrary method-call closures. For `.map` etc., either drop the unrolled child
  or label it `dynamic (mapped)`. Do not present a dynamic collection as a single
  static child.
**Loop:** `repro-widget-tree.ts` over `CollectionIfChildren`, `MappedChildrenField`.

### Task 4 — B6 + N1: enum-value-arg capture and resolution
Two layers.
**4a — Capture enum-value constructor args (symbol extractor).**
- **File:** [src/extractors/symbol-extractor.ts:177](src/extractors/symbol-extractor.ts#L177)
  (`enum_constant` case). **Now:** only the value's identifier is captured as a
  `field`; `splash('/splash')` loses the `'/splash'`, and `low(0)` loses `0`
  (see doc §B6 fix feasibility note).
- **CST to confirm:**
  ```sh
  echo "enum AppRoutes { splash('/splash'), home('/home'); const AppRoutes(this.path); final String path; }" | pnpm tsx scripts/dump-tree.ts -
  ```
  Identify how the constructor args hang off `enum_constant` (likely an
  `arguments`/`argument_part` child). Also confirm the enum constructor signature
  exposes the parameter name (`this.path`) so field-name→arg-position can be mapped.
- **Change:** for each `enum_constant`, capture its positional arg list; map them by
  position to the enum constructor's field names (`this.path` → index 0). Record on
  the value's symbol (e.g. `enumArgs: { path: "/splash", name: "splash" }`).
  Expose enough for the route resolver to look up `AppRoutes.splash.path`.
**4b — Resolve `EnumName.value.field` in the route graph.**
- **Files:** [src/extractors/string-const-extractor.ts](src/extractors/string-const-extractor.ts)
  (or a new sibling) + [src/tools/get-route-graph.ts:157](src/tools/get-route-graph.ts#L157),[:201](src/tools/get-route-graph.ts#L201).
- **Now:** the consts map only holds `static const` string fields; the resolver
  does `consts.get(pathExpr) ?? consts.get(lastSegment(pathExpr))` and falls back to
  `(unresolved const)`. `AppRoutes.splash.path` never resolves → 0/94 paths.
- **Change:** extend the indexed map to include enum-value field lookups built from
  4a, keyed `AppRoutes.splash.path` → `/splash` (and `AppRoutes.splash.name` →
  `splash` for N1). Keep the verbatim `(unresolved const)` fallback for anything
  still unresolved — honesty preserved.
**Fixture (new):** extend `fixtures/routes/const_paths_guarded.dart` with the enum
+ a `GoRoute(path: AppRoutes.splash.path)`. Assert via
`repro-extract.ts ... routes` (or a route-graph test) that the path resolves to
`/splash`, not `(unresolved const)`.

### Task 5 — B5: block-body `create:` not traced
**File:** [src/extractors/bloc-extractor.ts:210](src/extractors/bloc-extractor.ts#L210) (`blocProviderCreates`) + [:232](src/extractors/bloc-extractor.ts#L232) (`firstConstructorCasedName`).
- **Now:** for `create: (c) => sl<XBloc>()` the value is a `function_expression`;
  scope is set to `function_expression_body` and the first constructor-cased name
  resolves `XBloc`. For a **block body**
  `create: (c) { final b = sl<XBloc>(); return b; }`, the body node type differs
  (confirm: likely `function_body` with a `block`, not `function_expression_body`),
  so the `scope` narrowing at [:218-221](src/extractors/bloc-extractor.ts#L218)
  misses, falls back to the whole `value`, and either grabs a closure-param type
  (`BuildContext`) or finds nothing → "no bloc found".
- **CST to confirm:**
  ```sh
  echo 'final w = BlocProvider(create: (BuildContext c) { final b = sl<XBloc>(); return b; });' | pnpm tsx scripts/dump-tree.ts -
  ```
- **Change:** handle both function-body shapes. Narrow `scope` to the body block in
  both the arrow and block-body cases, and **skip the formal-parameter list** so a
  typed param (`BuildContext c`) is never mistaken for the bloc. Then
  `firstConstructorCasedName` over the body resolves `sl<XBloc>()` →`XBloc`
  regardless of arrow vs block. (Following the local-var→return is not strictly
  required if the body scan already finds `sl<XBloc>()`; confirm with the dump.)
- **Invariant to add (addresses the doc's "two directions disagree"):** a fixture
  asserting that `screen=` finds the bloc **and** `bloc=` lists that screen, for
  both arrow and block-body `create:`.
**Fixture (new):** per doc §Still-needed B5 — extend `fixtures/wiring/` with a
block-body-`create:` screen beside the existing arrow one.

### Task 6 — B4: generic mis-parse at collection value position
**Hardest CST; do after the wins above.** File:
[src/extractors/widget-extractor.ts:16](src/extractors/widget-extractor.ts#L16) (header note — **fix the stale claim**: the trigger is *value position in a collection literal*, not arg count ≥ 2; a single-type-arg `BlocProvider<X>(...)` inside a list still mis-parses), and the `recoverGeneric` path ([:235](src/extractors/widget-extractor.ts#L235)).
- **Now:** inside `MultiBlocProvider(providers: [ BlocProvider<X>(create: ...) ])`,
  the `< >` parse as a `relational_expression` and the real args spill into a
  `record_literal`; recovery then surfaces closure-body identifiers (`SomeBloc`,
  `LoadEvent`) as **phantom provider child nodes**.
- **CST to confirm (the doc already captured this — re-verify):**
  ```sh
  echo 'final w = MultiBlocProvider(providers: [ BlocProvider<SomeBloc>(create: (c) => SomeBloc()..add(LoadEvent())) ], child: Body());' | pnpm tsx scripts/dump-tree.ts -
  ```
  Expect `relational_expression(< >) + record_literal` at the list value position.
- **Change:** recognize the mis-parse when it occurs as a **list/collection
  element** (not only as a following named-arg sibling). Recover the provider as a
  single node `BlocProvider<SomeBloc>` with `recoveredFromMisparse: true`, take its
  args from the `record_literal`, and **do not** emit the create-closure's interior
  identifiers (`SomeBloc`, `LoadEvent`) as provider children — they live in
  event-handler/create closures, which are runtime, not layout. Reuse the
  `isEventHandlerSlot` / create-closure exclusion logic.
- **Target (doc §Expected):** `MultiProviderScreen` → `MultiBlocProvider →
  providers: [BlocProvider<SomeBloc>], child: Body` with **no** `SomeBloc`/`LoadEvent`
  phantom nodes.
**Loop:** `repro-widget-tree.ts` over `MultiProviderScreen`.

### Task 7 — Route-graph polish (R1, R2, AR1, B7)
**File:** [src/extractors/route-extractor.ts](src/extractors/route-extractor.ts) + [src/tools/get-route-graph.ts](src/tools/get-route-graph.ts).
- **R1 — global `GoRouter(redirect:)` dropped.** Per-route `redirect:` is captured
  as a guard; the top-level one on the `GoRouter(...)` itself is not — yet it's the
  single most important guard. Capture it and surface a router-level line
  (e.g. `global redirect: authGuard`). Fixture: `fixtures/stress/go_router_hard.dart`.
- **R2 — ShellRoute wrapper shown as `screenWidget`.**
  `ShellRoute(builder: (c,s,child) => ScaffoldShell(child: child))` reports
  `screenWidget: "ScaffoldShell"` — that's a wrapper, not a destination. Label
  shell wrappers distinctly (e.g. `shell wrapper: ScaffoldShell`), not `→ screen`.
- **AR1 — auto_route `RedirectRoute` dropped.** `RedirectRoute(path: '*',
  redirectTo: '/login')` vanishes (table of 3 → 2 routes). Extract it; show
  `* → /login (redirect)`. Fixture: `fixtures/stress/auto_route_app.dart`.
- **B7 — block-body / wrapper route builders lose the screen.** Lowest priority;
  honest absence is acceptable. Optionally unwrap one level
  (`BlocProvider(child: RealScreen())` → report `RealScreen`). If not unwrapping,
  keep the honest "no screen" rather than reporting the wrapper.
**Loop:** `repro-extract.ts <fixture> routes`.

### Task 8 — Symbol + minor polish (S1, S2, and the §Minor list)
- **S1 — operator overloads dropped.** [src/extractors/symbol-extractor.ts](src/extractors/symbol-extractor.ts)
  `declaration`/`method_signature` handling ([:142](src/extractors/symbol-extractor.ts#L142),[:154](src/extractors/symbol-extractor.ts#L154))
  does not recognize `operator <` / `operator []`. Confirm the CST
  (`echo 'class Box { bool operator <(Box o) => true; }' | pnpm tsx scripts/dump-tree.ts -`)
  — likely an `operator_signature` node — and emit it as a `method` symbol named
  `operator <`. Fixture: `fixtures/stress/symbols_hard.dart#Box`.
- **S2 — `mixin class` mis-kinded.** `mixin class Loggable {}` reports `kind: "class"`.
  Detect the `mixin` modifier on `class_definition` and report `kind: "mixin"` (or a
  distinct `mixinClass`). Fixture: `symbols_hard.dart#Loggable`.
- **`find_symbol` empty query → raw Zod error.** Catch the Zod failure (min length 1)
  and return a friendly one-liner instead of JSON.
- **Constructor signatures drop the class name.** `factory fromJson(...)` should read
  `factory PackageModel.fromJson(...)` — prepend the enclosing class name in the
  signature renderer.
- **Pagination.** High-frequency `find_symbol` queries truncate ~48 with a "narrow
  with kind=/package=" hint but no cursor. Add an `offset`/cursor param so agents
  can page. Lowest priority; current behavior is acceptable, just limited.

## Definition of done
- Every task's target output reproduced by its harness; the
  `repro-widget-tree.ts` "Expected output after fix" block matches exactly.
- New fixtures added for B5, B6, R1, AR1 (and B7 if unwrapped), each with an
  assertion.
- `pnpm test` green; snapshots updated only where output is genuinely correct.
- No regression in `get_symbol`, `get_project_map`, `find_symbol`,
  `find_state_wiring bloc=`.
- Honesty labels intact everywhere; no fabricated edges/screens/paths.
