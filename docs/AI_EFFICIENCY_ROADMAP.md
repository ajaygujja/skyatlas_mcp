# skyatlas-mcp — AI Efficiency Roadmap

**Problem this document addresses:** every new chat session re-discovers the repo from zero. The AI
burns 10–20 tool calls and ~20k tokens on orientation before it can make a single edit — and does it
again next session, and the session after that.

**Perspective:** written from the consumer side. What an AI agent actually needs, in what order, at
what cost, and how the server can hand it over in fewer round trips with higher trust.

**Companion doc:** `AI_FIX_SPEC.md` (verified defects + fixes). This document is about **capability
and economics**, not defects.

---

## 0. Verified starting state

| Fact | Evidence |
|---|---|
| Server registers **6 tools, 0 Resources, 0 Prompts** | `src/server.ts:23-28` — only `register*` calls are the six tools; no `registerResource` / `registerPrompt` anywhere |
| MCP SDK supports Resources & Prompts | `@modelcontextprotocol/sdk` `^1.29.0` (`package.json:49`) |
| **No git awareness** | `.git` appears in `src/` only as `.gitignore` parsing (`workspace.ts`, `watcher.ts:123,243`). No history, diff, or branch knowledge. |
| Symbol ids are path-coupled | `src/model/symbol.ts:45` — `` `${relPath}#${qualifiedName}` `` |
| `get_route_graph` has no scope filter | Its only parameter is `router` (`go_router` \| `auto_route` \| `navigator1`). No `package`, no `feature`. |
| `find_symbol` / `get_project_map` **do** have `package` filters | Their input schemas |

---

## 1. The cold-start problem, measured

### What actually happens today

Realistic session opener: *"add a validation rule to the safety form."*

| Step | Call | Approx. cost |
|---|---|---|
| 1 | `get_project_map()` | ~800 tok |
| 2 | `find_symbol("safety form")` → too many hits, refine | ~600 tok |
| 3 | `get_route_graph()` — to find which screen owns it | **~5,000 tok** (returns all 215 routes) |
| 4 | `find_state_wiring(screen=…)` | ~4,000 tok |
| 5–8 | `Read` 3–4 files to see conventions & existing validators | ~8,000 tok |
| 9–12 | `rg` for related patterns the tools can't answer | ~2,000 tok |
| | **Total** | **~20k tokens, 10–15 round trips** |

Then the session ends. Next session repeats all of it.

### Why it costs that much

Three separate causes, each with a different fix:

1. **No zero-call orientation.** The first useful byte requires a tool call. Every session pays a
   round trip just to learn the repo's shape.
2. **No task-scoped bundle.** The AI needs *one coherent slice* (this feature's routes + blocs +
   repos + conventions) but must assemble it from six general-purpose tools, each returning
   repo-wide data it must then discard.
3. **No scoping on the widest tools.** `get_route_graph()` returns all 215 routes when the AI needs
   the 12 belonging to one feature. ~95% of that response is discarded — but it was still paid for.

> **The economic test this server must pass:** a tool call must cost less than the grep sequence it
> replaces. Today `get_route_graph()` at ~5k tokens costs *more* than the 3–4 `rg` calls (~2k) an AI
> would otherwise run. When that inverts, the AI is right to reach for grep — and the server's core
> premise fails.

---

## 2. Fix layer 1 — Resources: orientation with zero tool calls

**The single biggest structural gap.** MCP defines three primitives; this server uses one.

| Primitive | Who invokes | Cold-start value |
|---|---|---|
| **Tools** | The model, one round trip each | What you have today |
| **Resources** | The **client/application** — attachable to context *before* the model's first turn | **Unused. This is the cold-start fix.** |
| **Prompts** | The user, explicitly | Unused. Workflow shortcuts. |

### Proposal: `skyatlas://digest`

A compact, always-current repo brief exposed as a Resource. The client can attach it at session
start; the AI begins already oriented, having spent **zero** tool calls.

Target: **under 800 tokens.** It is an index, not a dump — every line should either orient or point.

```
# arena_360_mobile — Flutter workspace, 10 packages, 4,784 Dart files
Stack: Bloc (state) · go_router (router) · injectable+get_it (DI) · json_serializable (codegen)
Index: fresh, all files parsed clean, updated 2026-08-14T10:31Z

## Packages
apps/arena_360        3,983 files   the app
packages/ui_library     143 files   shared widgets, theme, UIDimensions
packages/services        38 files   ApiClient, UseCase base, Failure
packages/form_engine    100 files   dynamic form runtime
packages/models          16 files   shared entities
... (5 more)

## Features (apps/arena_360/lib/features) — 3,664 files
forms 891 · safety 412 · documents 388 · contract 301 · inventory 274 · procurement 198 ...

## Conventions detected
- Clean arch: data/ · domain/ · presentation/ in 24 of 26 features
- Repos: abstract interface in domain/repositories/, @LazySingleton impl in data/repositories/ (129)
- Blocs: @injectable, one folder per bloc under presentation/blocs/ (312)
- Routes: enum AppRoutes → GoRoute in core/router/app_navigation.dart

## Start here
get_feature_context(name) for any feature above · get_project_map(package) to drill a package
```

**Honest caveat:** MCP client support for auto-attaching resources varies. Claude Code surfaces them;
other clients may require the user to attach explicitly. **Resources should therefore supplement, not
replace, a good first tool call** — keep `get_project_map` excellent regardless.

### Also worth exposing as Resources

- `skyatlas://conventions` — the detected-patterns block on its own, for repos where matching
  existing style matters most.
- `skyatlas://routes` — the route graph, so the AI can consult it without spending a 5k-token call.

### Prompts (low effort, real ergonomics)

Register a few user-invocable prompts that encode the right call sequence:

- `onboard-feature <name>` → runs the feature-context flow and summarizes.
- `trace-screen <ScreenName>` → route → screen → blocs → repos in one guided pass.
- `impact <SymbolName>` → what depends on this.

These cost almost nothing to add and remove the "which tool do I call first" guesswork.

---

## 3. Fix layer 2 — `get_feature_context`: the highest-leverage new tool

**This is the most valuable idea in this document.**

In feature-first Flutter — the convention this server explicitly targets — **the feature is the unit
of work.** Nobody says "I'll work on `find_symbol` results"; they say "I'm working on forms." Yet
there is no tool whose unit is a feature. The AI assembles that view manually, every time.

### Proposed API

```ts
get_feature_context(
  name: string,              // "forms", "safety" — a folder under lib/features/, or a package name
  include?: string[],        // ["routes","blocs","repos","screens","conventions"] — default all
  verbosity?: 'summary' | 'normal' | 'full'   // default 'summary'
)
```

### Proposed output (`summary`, target ~1,200 tokens)

```
# Feature: forms — apps/arena_360/lib/features/forms (891 files)

## Layers
domain/      142 files  (28 entities, 71 usecases, 9 repository interfaces)
data/        203 files  (9 datasources, 9 repository impls, 94 models)
presentation/546 files  (41 blocs/cubits, 63 screens, 389 widgets)

## Routes into this feature (12)
/form-screen                    → FormScreen              app_navigation.dart:1042
/form-widgets                   → FormWidgetsScreen       app_navigation.dart:1152
  /form-history                 → FormHistoryScreen       app_navigation.dart:1200
/custom-form-sequence-overview  → CustomFormSequence...   app_navigation.dart:1135
... (8 more — verbosity="normal" to expand)

## Primary blocs (41 — top 5 by wiring)
FormPlayerBloc      33 deps, read by 13 widgets   presentation/blocs/form_player/form_player_bloc.dart:75
SequenceFormsCubit   2 deps, read by 4            presentation/blocs/sequence_forms/sequence_forms_cubit.dart:17
...

## Data layer
FormRepository → FormRepositoryImpl    domain/repositories/form_repository.dart:110
                                       data/repositories/form_repository_impl.dart:122
  └ FormDatasource                     data/datasources/form_datasource.dart:117  (153 methods)
... (8 more repositories)

## Cross-feature dependencies
→ packages/form_engine (dynamic form runtime)
→ core/common/assignee, core/common/priorities
→ packages/ui_library, packages/services

## Notable
form_player_bloc.dart is 3,827 lines / 90 members — the feature's hot file.
```

### Why this works

| | Today | With `get_feature_context` |
|---|---|---|
| Round trips to orient on a feature | 10–15 | **1** |
| Tokens | ~20,000 | **~1,200** |
| Discarded content | ~95% | ~0% |

Every entry carries a `file:line` or a stable id, so the AI drills straight in with `get_symbol` /
`find_state_wiring` — **no re-search round trip.**

### Implementation notes

- Feature detection: folders under `lib/features/` is the common case, but **do not hardcode it.**
  Derive candidate feature roots from the package map plus the observed directory structure, and
  accept a package name too. Report honestly when the repo has no discernible feature convention
  rather than inventing one.
- All the underlying data already exists in `ProjectIndex` (`routes`, `blocs`, `widgets`, `edges`,
  `symbolsById`, `packages`). This is primarily an **aggregation and presentation** tool, not new
  extraction — which makes it cheap relative to its value.
- The "hot file" callout is genuinely useful signal for an AI about to edit: it flags where the risk
  and the context cost concentrate.

---

## 4. Fix layer 3 — scope filters on the wide tools

Cheapest wins in this document. `get_route_graph()` returning all 215 routes when the AI wants 12 is
pure waste, and it is a one-parameter fix.

| Tool | Has scoping today | Add |
|---|---|---|
| `get_route_graph` | `router`, `verbosity` | `package`, `feature`, `pathPrefix` — **DONE 2026-08-18** |
| `get_widget_tree` | `depth`, `follow` | (adequate) |
| `find_state_wiring` | `screen`/`bloc`/`provider`, `depth` | `verbosity` (see `AI_FIX_SPEC.md` §4) |
| `find_symbol` | `package`, `kind`, `match`, `offset` | (good — use as the model for the others) |
| `get_project_map` | `package` | `depth` (see `AI_FIX_SPEC.md` §5) — **DONE 2026-08-18** |

**Principle: every tool that can return repo-wide data must accept a scope argument.** `find_symbol`
already models this well — bring the rest up to its standard.

### Post-fix notes (measured against the evaluation repo, 2026-08-18)

**Which file a route is attributed to decides whether the filter works.** Measured over 219 resolved
routes: attributing by the file that *declares* the route puts 114 of them (52%) outside any feature,
because 111 are declared in one central table (`lib/core/router/app_navigation.dart`) and the rest in
seven per-module router files. Attributing by the file declaring the *screen* the route renders leaves
13 unattributed and distributes the rest as a caller expects — forms 29, safety 25, documents 25.
`get_route_graph` therefore scopes on the route's owning file (`src/index/feature-scope.ts`,
`routeOwnerFile`), which is the screen's declaration where one resolves and the route's otherwise.
The same rule drives `package=`, so both filters answer the same question about the same file.

**What each filter is worth here, measured.** Whole graph 3,346 tokens.

| filter | routes | cost | note |
|---|---|---|---|
| `feature=forms` | 29 | **565 tokens** | the case scoping exists for |
| `feature=analytics` | 9 | 238 tokens | recorded per run by `benchmark` |
| `pathPrefix=/quality` | 13 | 372 tokens | prefix, not path segment: this app's paths are flat (`/form-screen`, `/form-history`), so a segment match would find one route where a prefix finds fifteen |
| `package=chat_package` | 3 | 141 tokens | 216 of 219 routes sit in one package here — the filter is correct but cuts little in a single-app monorepo |

**Ancestors are kept, and counted apart.** A matched route nested under a shell inherits that shell's
path and guards, so pruning to matches alone would present it as mounted at the root. Ancestors
rendered for context are reported in the response rather than folded into the match count.

**Dynamic tables stay unfiltered.** Their routes are unknown by construction, so whether any match a
filter is unknowable; they are listed whole with that stated (§7.2).

**`feature=` is a layout convention, not extracted data.** A segment below `features/`, `feature/` or
`modules/` is a feature; a workspace with none is told so and pointed at `package=`/`pathPrefix=`
rather than having a feature invented for it. `get_project_map`'s folder listing (`AI_FIX_SPEC.md`
§5) is where a caller reads the valid names.

---

## 5. Fix layer 4 — batch queries: kill the round trips

Latency and token overhead are per-call, not per-result. An AI resolving five symbols pays five
round trips plus five response preambles for what is one logical question.

```ts
get_symbol(names: string[])            // or ids: string[]
find_state_wiring(blocs: string[])
```

Response groups by input, sharing one header and one honesty footer instead of N.

**Why this matters more for AI than for humans:** a human reads one answer at a time. An agent
frequently knows all five things it needs up front — but the current API forces it to serialize,
and each round trip is a full model turn.

---

## 6. Cross-session continuity — the git-shaped gap

**Verified: the server has zero git awareness.** `.git` appears only as `.gitignore` parsing.

This is the direct answer to *"every new chat re-discovers everything."* The AI does not need the
whole repo — it needs **the slice that is in play.** Git already knows what that is.

### Proposal: `get_working_set`

```ts
get_working_set(
  since?: string,     // "HEAD~5" | "main" | "2 days ago" — default: uncommitted + current branch vs default branch
  include?: 'symbols' | 'features' | 'both'
)
```

Output — not a diff, but the **indexed graph slice** the diff touches:

```
# Working set — 14 files changed vs main (branch: feature/form-validation)

## Features touched
forms (11 files) · safety (3 files)

## Symbols changed
M  FormPlayerBloc._onSubmit           .../form_player_bloc.dart:1875
M  FormPlayerBloc._onValidateAll      .../form_player_bloc.dart:1860
A  FormValidationService              .../domain/services/form_validation_service.dart:12

## Blast radius (syntactic)
FormPlayerBloc is read by 13 widgets across 8 files — see find_state_wiring(bloc="FormPlayerBloc")
FormValidationService is new — no dependents yet

## Untracked
.../form_validation_service_test.dart
```

**Why this is the highest-value cross-session feature:** a returning session's real question is
*"where was I?"* — and that is answerable from git plus the index, deterministically, in one call.
It converts a 15-call rediscovery into one.

**Implementation caution:** shell out to `git` narrowly (`git diff --name-only`, `git status
--porcelain`), handle the not-a-git-repo case gracefully, and never fail a request because git is
unavailable — degrade to "git unavailable, working set not computed."

---

## 7. Reliability contract — what makes an AI trust a tool

Efficiency without trust is worthless: an AI that half-believes a response will verify it with greps
anyway, paying twice. Five properties matter, in this order.

### 7.1 Never emit a fact you cannot support

See `AI_FIX_SPEC.md` §2 — the widget tree currently renders BLoC event constructors as layout nodes.
**One silent false positive costs more trust than ten honest "unknown"s.** An AI cannot detect the
lie; it can trivially route around a labeled gap.

### 7.2 Distinguish the three kinds of "nothing"

Today an empty-ish result is ambiguous. These are three different facts and must read differently:

| Meaning | Should say |
|---|---|
| Subject doesn't exist in the index | `No symbol named 'FooBloc'. Did you mean: FooCubit, FormBloc?` |
| Subject exists, genuinely has no connections | `FooBloc found (file:line) — no widget reads or creates it. Possibly dead code.` |
| Subject exists, analysis couldn't resolve it | `FooBloc found — wiring unresolved (created via factory at file:line).` |

The third is the one that must never masquerade as the second. "Not found" and "found nothing"
lead an AI to opposite next actions.

### 7.3 Carry freshness on every response

`get_project_map` reports index health; the other five do not. Every response should carry a compact
state line:

```
index: fresh · 4784 files · 0 parse errors · last update 12s ago
```

or, when it matters:

```
index: REBUILDING (2,140/4,784 files) — results may be incomplete
```

Without this an AI cannot distinguish "no results" from "not indexed yet" — and after a branch
switch the watcher's full re-scan makes that a real window.

### 7.4 Make determinism explicit

The v0.2.0 changelog notes duplicate-name resolution is "biased by caller imports." That heuristic
should be **stated in the response** when it fires:

```
2 classes named 'FormRepository' — showing the one imported by the caller file (features/forms/...).
Other: features/quality/... — pass id= to select explicitly.
```

Same query, same index, same answer — and when a tie was broken by heuristic, say so.

### 7.5 Stable ids that survive the session

Ids are `` `${relPath}#${qualifiedName}` `` (`src/model/symbol.ts:45`). Path-coupled: moving or
renaming a file invalidates every cached id. That is fine within a session but **breaks exactly the
cross-session persistence this roadmap is trying to enable** — an AI that stored ids yesterday finds
them dangling today.

Mitigation (cheap): when an id lookup misses, fall back to resolving the `#qualifiedName` portion by
name and report the relocation explicitly:

```
id '.../old_path.dart#FormPlayerBloc' not found — resolved by name to
.../new_path.dart#FormPlayerBloc (file moved).
```

This makes stale ids self-healing rather than fatal, at almost no cost.

---

## 8. The moat — convention extraction

This is the capability no other tool in this space can offer, and it follows directly from having a
whole-repo structural index.

**The problem it solves:** an AI writing new code in an unfamiliar repo either invents a pattern or
reads several files to infer one. Both are expensive; the first is also wrong. Repo instructions
(`CLAUDE.md` and friends) state *intended* conventions — but drift, and cannot report coverage.
Only the index knows what the code **actually does.**

### Proposal: `get_conventions(scope?)`

```
# Conventions — apps/arena_360 (observed, not prescribed)

## Repository pattern (129 instances, 96% consistent)
  abstract interface class <X>Repository        domain/repositories/<x>_repository.dart
  @LazySingleton(as: <X>Repository)             data/repositories/<x>_repository_impl.dart
  Returns Either<Failure, T>                    124/129
  Exemplar: FormRepository — domain/repositories/form_repository.dart:110
  Deviations (5): AuthRepository returns raw Future — data/repositories/auth_repository_impl.dart:31

## Bloc pattern (312 instances, 94% consistent)
  @injectable · one folder per bloc under presentation/blocs/<name>/
  Event/state as part files
  Exemplar: SequenceFormsCubit — presentation/blocs/sequence_forms/sequence_forms_cubit.dart:17

## Route registration (215 routes, 100% consistent)
  enum AppRoutes entry → GoRoute in core/router/app_navigation.dart
```

### Why this is uniquely valuable to an AI

1. **An exemplar beats a description.** `Exemplar: FormRepository — file:line` lets the AI read one
   canonical instance rather than guessing from prose.
2. **Consistency percentages calibrate confidence.** 96% means "follow this." 60% means "ask."
3. **Deviations are a code-health signal for free.** The 5 repositories that break the pattern are
   exactly what a reviewer wants surfaced.
4. **It is derived from the code, so it cannot go stale** — unlike hand-written convention docs,
   which drift silently.

Start narrow: detect the three or four patterns you already extract (repository, bloc, usecase,
route). Do not attempt general pattern mining.

---

## 9. Priority

| # | Item | Effort | Payoff | Depends on |
|---|---|---|---|---|
| 1 | Scope filters on `get_route_graph` (+ `verbosity` everywhere) — **DONE 2026-08-18** | S | High — fixes the economics | `AI_FIX_SPEC.md` §4 |
| 2 | `get_feature_context` | M | **Highest** — 20k tok → 1.2k, 15 calls → 1 | Existing index only |
| 3 | `skyatlas://digest` Resource | S | High — zero-call orientation | #2's aggregation logic |
| 4 | Freshness line + three-kinds-of-nothing (§7.2, §7.3) | S | High — trust, cheap | — |
| 5 | `get_working_set` (git) | M | High for returning sessions | git shell-out |
| 6 | Batch queries | S | Medium — kills round trips | — |
| 7 | `get_conventions` | M | High, differentiating | — |
| 8 | Prompts (`onboard-feature`, …) | S | Medium ergonomics | #2 |
| 9 | Id self-healing (§7.5) | S | Medium — enables cross-session ids | — |

### Suggested sequencing

**Milestone A — make it cheap.** #1, #4, plus `AI_FIX_SPEC.md` issues 1–3.
*Outcome: every existing tool costs less than the greps it replaces, and never lies.* This must land
first — new features built on the current economics inherit the problem.

**Milestone B — make it one call.** #2, #3, #6.
*Outcome: cold start drops from ~20k tokens / 15 calls to ~1.5k / 1–2 calls.*

**Milestone C — make it persistent.** #5, #9, #8.
*Outcome: a returning session asks "where was I?" and gets a real answer.*

**Milestone D — make it unique.** #7.
*Outcome: the server tells an AI not just what the code is, but how this team writes it.*

---

## 10. The one-sentence version

Today the server answers *"what is in this repo?"* — a question an AI must ask many times, expensively.
The roadmap moves it toward answering *"what do I need to know to do this task, right now?"* — once,
cheaply, in a form the AI can trust without re-verifying.

---

## 11. What is verified vs. proposed

**Verified** (read in source, 2026-08-14): the six-tools/zero-resources/zero-prompts state; SDK
version; absence of git awareness; the id scheme; `get_route_graph`'s missing scope filter;
`find_symbol`'s and `get_project_map`'s existing filters.

**Measured** (observed during evaluation against a 4,784-file repo): the ~20k-token cold-start cost
and per-call response sizes — **estimated from response length, not instrumented.** Instrument before
optimizing (see `AI_FIX_SPEC.md` §4, "Test").

**Proposed** (design, not yet validated): every API shape and sample output in §2, §3, §6, §8. The
file counts in the sample outputs are illustrative, drawn from the evaluation repo's real
`get_project_map` output where available and invented for shape where not — treat them as format
examples, not data.
