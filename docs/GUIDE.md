# Using, Verifying & Improving skyatlas_mcp

A complete guide to running this server against a real Flutter project, proving it
actually works, understanding when it doesn't, sharing it with a team, and making it
better over time.

It is written to be read by **both humans and AI assistants**. No prior knowledge of
MCP, Node.js, or backend tooling is assumed — concepts are explained the first time
they appear, and there is a [glossary](#glossary) at the end.

---

## Table of contents

1. [What this server actually is](#1-what-this-server-actually-is)
2. [The mental model: map vs microscope](#2-the-mental-model-map-vs-microscope)
3. [How "MCP servers" differ from normal apps](#3-how-mcp-servers-differ-from-normal-apps)
4. [Quick start — point it at a Flutter project](#4-quick-start--point-it-at-a-flutter-project)
5. [The three health checks (status / coverage / live)](#5-the-three-health-checks)
6. [The `doctor` command — full reference](#6-the-doctor-command--full-reference)
7. [Reading a doctor report](#7-reading-a-doctor-report)
   - [7b. The `benchmark` command (performance)](#7b-the-benchmark-command-performance-not-coverage)
8. [When parsing fails — the improvement loop](#8-when-parsing-fails--the-improvement-loop)
9. [Sharing it with your team](#9-sharing-it-with-your-team)
10. [Getting real-world data to improve](#10-getting-real-world-data-to-improve)
11. [For AI assistants](#11-for-ai-assistants)
12. [Command cheat-sheet](#12-command-cheat-sheet)
13. [Glossary](#glossary)

---

## 1. What this server actually is

`skyatlas_mcp` is a small program that **reads your Dart/Flutter code and answers
questions about its structure** — where things are defined, how routes nest, which Bloc
or Provider wires to which screen, what a widget tree looks like.

It does **not** run your app, change your code, or call the network. It only **reads**
`.dart` files, builds an in-memory map (called the *index*), and keeps that map fresh as
you edit. It exposes six question-answering **tools** over a protocol called **MCP**.

Think of it as a librarian for your codebase: it has read every file and can instantly
tell an AI assistant "the `SettingsScreen` route is defined at `lib/router.dart:42`"
instead of the assistant having to grep and open ten files to find out.

---

## 2. The mental model: map vs microscope

There are two complementary tools in the Flutter MCP world:

| | **skyatlas_mcp** (this) | **Official Dart MCP server** |
|---|---|---|
| Role | The **map** — whole-repo structure | The **microscope** — one symbol in depth |
| Speed | Fast, always-on, syntactic | Slower, semantic (full type resolution) |
| Answers | "Where is it? How does it connect?" | "What is its resolved type? Find all references." |
| Needs | Just the source files | The Dart SDK + analyzer running |

Use this server to **orient and locate** (get a `file:line`), then hand that exact
location to the Dart server or your editor for **resolved semantic truth**. They are
designed to run side by side, not as alternatives.

---

## 3. How "MCP servers" differ from normal apps

If you come from web/backend, your instinct is "it should have an `init` command, a
`/status` endpoint, a `/health` endpoint, a port." **An MCP server has none of those,
and that's correct.** Here's why.

- A normal web service runs continuously and waits for HTTP requests on a port. Anyone
  can hit `/health` to check it.
- An MCP server is **launched on demand by an AI client** (Claude Code, Cursor). It talks
  to that one client over **stdin/stdout** (a pipe), using JSON messages. There is no
  port and no second caller, so there's nothing to expose a `/health` route *to*.

The protocol itself provides the equivalents you're looking for:

| What you'd expect | The MCP equivalent here | How you run it |
|---|---|---|
| `init` (set it up) | register the server with your client | `claude mcp add …` |
| `status` (is it up?) | the client lists connection state | `claude mcp list` → ✓ Connected |
| `health` (is it OK?) | the `get_project_map` "Index health" line | ask the AI: *"Call get_project_map"* |
| coverage / diagnostics | the **`doctor`** command (this repo) | `pnpm doctor <path>` |

So: the AI client *is* the monitor. The pipe being open means the process is alive; a
tool call returning data means it's working. For deeper "did it parse my whole project"
questions, that's what `doctor` is for (section 6).

---

## 4. Quick start — point it at a Flutter project

You only build this server **once**. After that you register it against whichever Flutter
repo you want mapped.

```bash
# 1. Build the server (do this once, inside THIS repo).
cd /abs/path/to/skyatlas_mcp
pnpm install
pnpm build                     # produces dist/server.js

# 2. Register it against YOUR Flutter app.
#    The path at the END is the Flutter project to index — NOT this repo.
claude mcp add skyatlas -- node /abs/path/to/skyatlas_mcp/dist/server.js /abs/path/to/your-flutter-app
```

Then, in an AI chat opened inside your Flutter app, say *"Call get_project_map."* You
should get a map listing packages, folder counts, and the detected stack.

> **Tip:** add `.skyatlas/` to your Flutter app's `.gitignore`. The server writes a
> warm-start cache there; it should not be committed.

### Choosing a scope (where the tools show up)

`claude mcp add` writes the registration to one of three scopes. The default is `local`,
which is the most common reason the tools "connect" but never appear in a session: a
`local` server is private to the **one directory you ran `add` in**. Run the client from
anywhere else and the tools are absent — even though `claude mcp get` still reports
`✓ Connected` (that only proves the process launches, not that *this* session loaded it).

| Scope | Flag | Where tools appear | Stored in | Use when |
|-------|------|--------------------|-----------|----------|
| **user** | `-s user` | every project, every directory | `~/.claude.json` (global) | you want it always on, just for you |
| **project** | `-s project` | anyone who opens this repo | `.mcp.json` in the repo (commit it) | sharing with teammates |
| **local** *(default)* | *(none)* | only the dir you ran `add` in | `~/.claude.json` under that project | quick one-off, single repo |

```bash
# Recommended: available in every directory, private to you.
claude mcp add -s user skyatlas -- node /abs/path/to/skyatlas_mcp/dist/server.js /abs/path/to/your-flutter-app

# Shared with the team (writes .mcp.json in the current repo — commit it).
# The trailing "." indexes the repo you run this in.
claude mcp add -s project skyatlas -- node /abs/path/to/skyatlas_mcp/dist/server.js .

# Default local scope — only works when you launch the client from this exact directory.
claude mcp add skyatlas -- node /abs/path/to/skyatlas_mcp/dist/server.js /abs/path/to/your-flutter-app
```

> **Switching scope?** Remove the old registration first, then re-add — `add` refuses a
> duplicate name (`MCP server skyatlas already exists`):
> ```bash
> claude mcp remove skyatlas
> claude mcp add -s user skyatlas -- node /abs/path/to/skyatlas_mcp/dist/server.js /abs/path/to/your-flutter-app
> ```

> **Restart after adding.** MCP servers load at session **start**. If you added the
> server mid-session the tools won't appear until you restart the client (or it can't see
> the new scope). Run `/mcp` to confirm `skyatlas` is listed with its tools.

---

## 5. The three health checks

There are three independent things you might mean by "is it working?" Check the one you
actually care about.

### a) Is it connected? (status)
```bash
claude mcp list
# → skyatlas … ✓ Connected
```
This proves the client can launch the process and complete the MCP handshake.

### b) Did it parse my whole project? (coverage)
This is the important one, and the reason `doctor` exists:
```bash
pnpm -C /abs/path/to/skyatlas_mcp doctor -- /abs/path/to/your-flutter-app --cold
```
> **Note the `--`.** When you pass flags like `--cold` or `--json`, put a `--` before the
> arguments so `pnpm` forwards them to the script instead of trying to interpret them as its
> own options (otherwise you get `ERROR Unknown option: 'cold'`). A bare path with no flags
> doesn't need it.
See sections 6–7. This is also the only check that runs **without** an AI client — pure
parse numbers straight from the indexer.

### c) Does it stay fresh as I edit? (live)
1. Ask the AI: *"Show me the route graph."* (note the routes)
2. Edit a route file in your app and save.
3. Ask again. The change should appear with **no restart** — a filesystem watcher
   re-indexes changed files incrementally (a single saved file in well under 50 ms).

---

## 6. The `doctor` command — full reference

`doctor` answers one question the AI tools and the benchmark don't fully answer:
**"Did the WHOLE project index cleanly, and if not, exactly which files and why?"**

It runs the real indexer over a workspace and prints a parse-coverage report. It makes
**no network calls** and **does not modify your source** (its only optional write is
deleting the cache folder when you pass `--cold`).

### Running it from inside this repo

```bash
cd /abs/path/to/skyatlas_mcp
pnpm doctor /abs/path/to/your-flutter-app            # warm: reuse cache if present
pnpm doctor /abs/path/to/your-flutter-app --cold     # nuke cache, full fresh re-parse
pnpm doctor /abs/path/to/your-flutter-app --json     # machine-readable (for CI/sharing)
```

### Running it **from your Flutter project's directory** (most common)

You asked specifically about this. `doctor` is a script that lives in *this* repo, so
when your terminal is sitting inside your Flutter app you point `pnpm` at this repo with
`-C` (change-directory) and pass `$(pwd)` (your current folder) as the workspace:

```bash
# You are here:  cd /Users/you/dev/my-flutter-app

# Set this once per shell so the commands below stay short:
export FI=/abs/path/to/skyatlas_mcp

# Human report on the project you're standing in (no flags → no `--` needed):
pnpm -C "$FI" doctor "$(pwd)"

# Full fresh re-parse (recommended the first time / after big changes):
pnpm -C "$FI" doctor -- "$(pwd)" --cold

# Machine-readable, saved to a file you can send to a maintainer:
pnpm -C "$FI" doctor -- "$(pwd)" --json > doctor.json
```

`$(pwd)` expands to your current directory *before* `pnpm` runs, so the report is always
about the Flutter project you're standing in, regardless of where the server lives.

> **Why the `--`?** `pnpm` parses anything starting with `--` (like `--cold`, `--json`) as
> one of *its own* options and errors with `ERROR Unknown option: 'cold'`. Putting `--`
> before the script arguments tells `pnpm` "stop parsing, forward the rest verbatim." A
> command with only a path and no flags doesn't need it.

> **Even shorter (optional):** add a shell alias to your `~/.zshrc` — bake the `--` in so you
> never think about it:
> ```bash
> alias fidoctor='pnpm -C /abs/path/to/skyatlas_mcp doctor --'
> ```
> Then from any Flutter project: `fidoctor "$(pwd)" --cold`.

### Quieting the logs

The server logs startup info to **stderr** as JSON. To see only the report, lower the log
level:
```bash
SKYATLAS_LOG=warn pnpm -C "$FI" doctor -- "$(pwd)" --cold
```

### Exit code (for CI)

`doctor` exits **`1`** if any file was skipped entirely (a *Tier A* failure, see below),
otherwise **`0`**. That means you can gate a pipeline on it:
```bash
pnpm -C "$FI" doctor -- "$(pwd)" --json || echo "parse coverage regressed"
```

---

## 7. Reading a doctor report

A human report looks like this:

```
skyatlas doctor — /Users/you/dev/my-flutter-app
────────────────────────────────────────────────────────────
packages       2
dart files     415
symbols        5210
parsed/cached  401 parsed, 14 from cache
index time     2380 ms
coverage       99.3% clean (412/415 files parsed with no syntax errors)

Tier A — skipped entirely (0):
  none — every file was read and parsed.

Tier B — indexed with localized syntax errors (3):
  ⚠ lib/widgets/fancy.dart
      syntax error at 88:5
  …
```

### The numbers

- **packages** — how many Dart packages (pubspec.yaml roots) were found.
- **dart files** — total `.dart` files indexed.
- **symbols** — classes, functions, enums, etc. extracted across the repo.
- **parsed / from cache** — freshly parsed this run vs. reused from the warm-start cache.
  `--cold` forces everything to be parsed fresh.
- **index time** — wall-clock time to build the whole index.
- **coverage** — percentage of files that parsed with **zero** syntax errors.

### The two failure tiers (this is the key concept)

There are two *different* ways a file can be less than perfect. Don't confuse them.

**Tier A — skipped entirely.** The file could not be read (permissions, encoding) or the
parser threw. The file is **not in the index at all** — the AI can't see it. This is the
serious one. You want **zero**. Each entry shows the path and the reason.

**Tier B — indexed, with localized syntax errors.** The file *was* indexed, but somewhere
inside it the grammar hit Dart syntax it doesn't recognize. The parser marks that one spot
as an error and **keeps going** — the rest of the file is fully usable. This is "graceful
degradation": one weird line doesn't blind the AI to the whole file. Each entry shows the
path and the `line:col` of each error spot.

Tier B is almost always **new Dart syntax the pinned grammar doesn't yet cover**, and it's
your richest source of improvements (next section).

---

## 7b. The `benchmark` command (performance, not coverage)

`doctor` answers *"did it parse correctly?"* `benchmark` answers a different question:
**"how fast and how heavy is indexing?"** Use it only when indexing feels slow, or when you
change the parser/indexer and want to catch a slowdown — for everyday "is it working" checks,
`doctor` is what you want.

```bash
pnpm -C "$FI" benchmark "$(pwd)"                       # warm (reuse cache) — restart speed
pnpm -C "$FI" benchmark -- "$(pwd)" --cold            # cold (delete cache) — honest worst case
pnpm -C "$FI" benchmark -- "$(pwd)" --cold --record   # also log to benchmarks/history.jsonl
```

It prints JSON:

```json
{
  "mode": "cold",
  "fileCount": 415,
  "symbolCount": 5210,
  "elapsedMs": 2380,
  "msPerFile": 5.73,
  "rssMb": 180,
  "budgets": { "coldUnder10sPer1000Files": true, "rssUnder500Mb": true }
}
```

- **elapsedMs / msPerFile** — total index time, and time per file (the size-independent number).
- **rssMb** — peak memory used.
- **budgets** — pass/fail against the two targets: cold index under **10 s per 1000 files**, and
  resident memory under **500 MB**. Both `true` = healthy.
- **`--record`** appends the run to `benchmarks/history.jsonl` (in this repo) so you can compare
  over time. A **>2× jump** between entries is the regression alarm.

> Tiny apps finish in tens of milliseconds, so the budgets always pass — to stress-test, point it
> at a large public repo (e.g. `appflowy-io/appflowy`, `immich-app/immich`) with `--cold`.

---

## 8. When parsing fails — the improvement loop

The parser only fails on syntax it has never seen. Every Tier-B (or Tier-A) file is a
chance to make the grammar smarter. The loop is the same one the existing test fixtures
came from:

```
real file that errors
   │
   ▼
1. Find the exact broken node:
      pnpm -C "$FI" dump-tree -- /abs/path/to/that/file.dart | grep -n ERROR
   (dump-tree prints the parse tree; ERROR nodes are the spots the grammar choked on.)
   │
   ▼
2. Minimize it: copy the SMALLEST snippet that still produces the ERROR.
   │
   ▼
3. Save it as a fixture under  fixtures/<feature>/  in this repo.
   │
   ▼
4. Add a test next to the relevant extractor asserting it now extracts correctly
   (see CONTRIBUTING.md and the *.test.ts files beside each extractor).
   │
   ▼
5. Fix it — usually one of:
      • bump the vendored tree-sitter-dart grammar to a newer commit
        (best, when upstream already added support — see vendor/GRAMMAR_VERSION), or
      • make the extractor tolerant of that node shape.
   │
   ▼
6. Re-run  pnpm test  and  pnpm doctor  — the fixture now guards against regression
   forever.
```

The point of step 3–4: once a real-world failure becomes a committed fixture + test, that
syntax can never silently break again.

---

## 9. Sharing it with your team

Three levels, easiest to most polished.

### a) Per-repo, shared through Git
Inside your Flutter app:
```bash
claude mcp add skyatlas -s project -- node /abs/path/to/skyatlas_mcp/dist/server.js .
```
This writes a `.mcp.json` file into the Flutter repo. Commit it; teammates who pull get the
server auto-registered. **Caveat:** the `node …/dist/server.js` path must also exist on
their machine — so they still need this server built somewhere. That leads to (b).

### b) Publish to npm (the real team-scale answer)
`package.json` is already publish-ready (`bin` + `files` are set). Publish it:
```bash
npm publish                       # public
# or, for an internal org registry / scope:
#   name it "@yourorg/skyatlas_mcp" and: npm publish --access restricted
```
Teammates then need **no clone and no build**:
```bash
claude mcp add skyatlas -- npx -y skyatlas_mcp /abs/path/to/their-flutter-app
```
`npx` downloads and runs it on demand.

### c) Just send the repo
They `git clone`, `pnpm install && pnpm build`, then register as in section 4. Most manual,
fine for one teammate.

> For more than one or two people, **(b) npm** is the right choice.

---

## 10. Getting real-world data to improve

The synthetic fixtures in `fixtures/` only cover syntax we thought of. To genuinely harden
the parser you must feed it **real, varied Dart**. In order of effort:

1. **Run `doctor` against large public Flutter repos — free, today, no users needed.**
   ```bash
   git clone --depth 1 https://github.com/flutter/gallery /tmp/gallery
   pnpm -C "$FI" doctor -- /tmp/gallery --cold
   ```
   Good targets: `flutter/gallery`, `flutter/samples`, `appflowy-io/appflowy`,
   `immich-app/immich`, `localsend/localsend`. Each Tier-B file they surface is a real
   grammar gap → run the loop in section 8.

2. **From real users — let the report do the collecting.** Ask them to run
   `pnpm -C <repo> doctor -- <their-app> --json > doctor.json` and send the JSON. It already
   lists exact files and `line:col`. To actually *fix* a gap you still need the offending
   snippet, so your issue template should ask for the minimal lines (the report tells them
   how to find it with `dump-tree`).

3. **Keep the privacy promise.** This server's selling point is "no network, your code
   never leaves the machine." So the model is **pull, not push**: `doctor` produces a local
   report and the user *chooses* to share it. If you ever want aggregate signal, the only
   acceptable form is **opt-in** telemetry of *which grammar node-types errored* — never
   source text.

4. **Every confirmed gap becomes a permanent regression test** (section 8). That's how the
   project compounds: each new style of Dart anyone throws at it makes it stronger for
   everyone.

---

## 11. For AI assistants

If you are an AI assistant working in a repo that has this server registered:

- Call **`get_project_map` once** at the start of a session to orient — packages, layout,
  detected stack, and an **index-health line**. If that line reports files with syntax
  errors, treat structural answers about *those files* as lower-confidence and verify with
  grep or the Dart server.
- Use **`find_symbol` / `get_symbol`** to locate and inspect declarations; **`get_route_graph`**,
  **`get_widget_tree`**, **`find_state_wiring`** for Flutter-domain questions. Each returns
  compact, `file:line`-referenced markdown in **one call** — prefer them over multi-round
  grep-and-read.
- Results labeled **`(syntactic match)`** are name-based, not type-resolved. Don't present
  them as resolved-type fact. For resolved types / true find-references, hand the `file:line`
  to the official Dart MCP server.
- This server is **read-only**. It never edits code. For semantic truth or runtime
  inspection, defer to the Dart analyzer / a running app.

---

## 12. Command cheat-sheet

Assume `export FI=/abs/path/to/skyatlas_mcp` and that you are standing in your
Flutter project (`cd /your/flutter/app`).

```bash
# ── Build the server (once) ────────────────────────────────
pnpm -C "$FI" install
pnpm -C "$FI" build

# ── Register with an AI client ─────────────────────────────
claude mcp add skyatlas -- node "$FI/dist/server.js" "$(pwd)"     # machine-wide
claude mcp add skyatlas -s project -- node "$FI/dist/server.js" . # this repo, shareable
claude mcp list                                                        # is it connected?

# ── Verify parse coverage (no AI client needed) ────────────
# Flags (--cold/--json) need a `--` so pnpm forwards them to the script.
pnpm -C "$FI" doctor "$(pwd)"                     # warm human report (no flags → no --)
pnpm -C "$FI" doctor -- "$(pwd)" --cold          # full fresh re-parse
pnpm -C "$FI" doctor -- "$(pwd)" --json          # machine-readable (CI / sharing)
SKYATLAS_LOG=warn pnpm -C "$FI" doctor -- "$(pwd)" --cold   # quiet logs

# ── Investigate a failing file ─────────────────────────────
pnpm -C "$FI" dump-tree -- /abs/path/to/file.dart | grep -n ERROR

# ── Performance timing + budgets ───────────────────────────
pnpm -C "$FI" benchmark -- "$(pwd)" --cold

# ── Run the test suite (inside this repo) ──────────────────
pnpm -C "$FI" test
```

---

## Glossary

- **MCP (Model Context Protocol)** — a standard way for AI assistants to call external
  tools. The assistant is the *client*; this program is a *server* it launches.
- **stdio / pipe** — the channel the client and server talk over: messages in on standard
  input, replies out on standard output. No network, no port.
- **stdout / stderr** — two output streams. This server reserves **stdout** for the MCP
  protocol and prints all logs to **stderr**, so logs never corrupt the protocol.
- **Index** — the in-memory map of your code the server builds by reading every `.dart`
  file. Tools answer from the index.
- **Tool** — one callable capability (`get_project_map`, `find_symbol`, …). The AI picks
  which to call.
- **tree-sitter** — the parser technology used to turn Dart source into a syntax tree. The
  Dart grammar is vendored (checked in) and pinned to a specific version.
- **Grammar** — the rules that tell tree-sitter what valid Dart looks like. New language
  features sometimes need a newer grammar.
- **Fixture** — a small sample file used in tests to prove the parser handles a given
  syntax.
- **Warm-start cache** — `.skyatlas/cache.json` inside the indexed repo; lets a
  restart skip re-parsing unchanged files. Safe to delete (`--cold` does).
- **Cold vs warm** — *cold* = ignore the cache and parse everything; *warm* = reuse the
  cache for unchanged files (faster).
- **pnpm `-C <dir>`** — run a pnpm command as if you were inside `<dir>`, even though your
  terminal is somewhere else. Used here to run this repo's scripts from your Flutter folder.
```
