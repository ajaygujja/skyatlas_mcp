# flutter-intel-mcp

**A Flutter-aware repo map for Claude and Cursor — it complements the official Dart MCP server.**

The official Dart MCP server is a _microscope_ (resolve one symbol, get its docs, fix an error,
drive a running app). This is the _map_: it parses your whole Dart workspace with a real
tree-sitter grammar, builds a nested symbol model plus Flutter-domain graphs (routes, widget
trees, Bloc/Riverpod wiring), keeps it fresh as you edit, and answers repo-structure questions
in **one tool call** instead of ten rounds of grep-and-read.

It is **read-only**, runs **entirely on your machine**, and makes **no network calls** at runtime
(see [Security & privacy](#security--privacy)). Your code never leaves the box.

---

## Requirements

- **Node ≥ 20** (LTS). The parser is WASM (`web-tree-sitter`), so there is **no native build** —
  it installs first-try on macOS, Linux, Windows, and ARM.
- **Dart syntax** is parsed through a vendored, pinned `tree-sitter-dart` grammar. It supports
  Dart 3.x through dot shorthands, records, patterns, class modifiers, extension types, and
  digit separators. The exact pinned grammar commit and build provenance are recorded in
  [`vendor/GRAMMAR_VERSION`](vendor/GRAMMAR_VERSION). New Dart syntax the grammar doesn't yet
  know produces a localized parse error in that one spot — the rest of the file still indexes
  (graceful degradation; see the index-health line in `get_project_map`).

---

## Install

### 1. Build from a clone

```bash
git clone <repo-url> flutter-code-intel
cd flutter-code-intel
pnpm install
pnpm build          # emits dist/ ; the WASM grammar is already vendored under vendor/
```

`pnpm build` is the only step — the grammar `.wasm` is checked into `vendor/` and resolved by an
absolute path at runtime, so `node dist/server.js` works from any cwd.

### 2. Register with Claude Code

The workspace root to index is **`argv[2]`** — pass the absolute path to the Flutter repo you
want mapped (not the path to this server).

```bash
# Available in every project on this machine:
claude mcp add flutter-intel -- node /abs/path/to/flutter-code-intel/dist/server.js /abs/path/to/your-flutter-repo

# Or scoped to the current repo only (writes .mcp.json in the repo, shareable with teammates):
claude mcp add flutter-intel -s project -- node /abs/path/to/flutter-code-intel/dist/server.js .
```

### 3. Register with Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "flutter-intel": {
      "command": "node",
      "args": ["/abs/path/to/flutter-code-intel/dist/server.js", "/abs/path/to/your-flutter-repo"]
    }
  }
}
```

### 4. Gitignore the cache in the _target_ repo

The server writes a warm-start cache to `.flutter-intel/cache.json` **inside the repo it indexes**.
Add this to that repo's `.gitignore`:

```gitignore
.flutter-intel/
```

---

## The six tools

Each answers a repo-structure question in compact, `file:line`-referenced markdown.

| Tool                | What it answers                                                                                                                       | Ask Claude…                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `get_project_map`   | Packages, folder layout, symbol counts, detected stack (state mgmt / router / codegen), index health. **The "read this first" tool.** | _"Give me a map of this Flutter project."_                           |
| `find_symbol`       | Symbols matching a query — qualified name, kind, signature, `file:line`, annotations.                                                 | _"Find every class ending in Repository."_                           |
| `get_symbol`        | One symbol in depth — declaration header, type params, extends/implements, members, edges in/out.                                     | _"Show me the UserBloc class in detail."_                            |
| `get_route_graph`   | The route tree with computed full paths, the screen widget per route, and guards.                                                     | _"What's the route structure of this app?"_                          |
| `get_widget_tree`   | The static `build()` tree of a widget, builder callbacks marked, Bloc/Provider wiring noted inline.                                   | _"What does SettingsScreen's widget tree look like?"_                |
| `find_state_wiring` | Connections: screen ↔ Bloc/Provider ↔ (syntactically visible) repositories, each edge with `file:line` and a confidence label.        | _"Which Bloc serves the SettingsScreen, and what repo does it use?"_ |

Responses distinguish certainty: name-based matches are labeled `(syntactic match)`, never
presented as resolved-type fact.

---

## Run it alongside the official Dart MCP server

The two are designed to be used **together**, not as alternatives:

- **This server is the map** — whole-repo structure: where things are, how routes nest, which
  Bloc wires to which screen, what the widget tree looks like. Fast, syntactic, always-on.
- **The official Dart MCP server is the microscope** — per-symbol semantic truth from the Dart
  analyzer: resolved types, real find-references, error analysis and fixes, plus runtime
  interaction with a _running_ app (hot reload, live widget tree).

Typical loop: use `get_project_map` / `find_state_wiring` here to orient and locate, then hand
the exact `file:line` to the Dart server (or your editor) for resolved semantics. Register both:

```bash
claude mcp add dart -- dart mcp-server          # the microscope (Dart SDK ≥ 3.9)
claude mcp add flutter-intel -- node /abs/path/to/flutter-code-intel/dist/server.js /abs/path/to/your-flutter-repo
```

---

## Make Claude actually use the tools

Tool descriptions alone usually suffice, but to be sure the assistant reaches for the map
instead of grepping, paste this into the **target repo's `CLAUDE.md`**:

```markdown
## Repo navigation

This repo has a `flutter-intel` MCP server providing a structural map.
For any question about repo structure — routes, widget trees, which Bloc/Provider
serves a screen, where a symbol is defined, project layout — call the flutter-intel
tools FIRST, before grepping or opening files:

- `get_project_map` to orient (call it once at the start of a session)
- `find_symbol` / `get_symbol` to locate and inspect declarations
- `get_route_graph`, `get_widget_tree`, `find_state_wiring` for Flutter-domain questions

These answer in one call with file:line references. Fall back to grep only when the
tools return nothing. Use the official Dart MCP server for resolved types / find-references.
```

---

## Verify it works

```bash
# 1. The server is connected:
claude mcp list
#    → flutter-intel ... ✓ Connected

# 2. A tool returns real data (from a Claude chat in the target repo):
#    "Call get_project_map."
#    → a map listing your packages, folder counts, and detected stack.

# 3. Live freshness (no restart needed):
#    - Ask: "Show me the route graph."  (note the routes)
#    - Edit a route file in the repo and save.
#    - Ask again: "Show me the route graph."  → the change appears.
```

The index builds in the background on startup (the MCP handshake returns immediately; tool calls
await readiness) and a filesystem watcher re-indexes changed files incrementally — a single saved
file re-indexes in well under 50 ms, with no restart.

---

## Security & privacy

- **Read-only.** The server never writes to your source. Its only write is the warm-start cache
  under `.flutter-intel/` in the indexed repo.
- **Workspace-scoped.** It reads only `.dart` files under the workspace root passed as `argv[2]`.
- **No network at runtime.** No telemetry, no remote calls, no code upload. The parser is local
  WASM; everything stays in-process. _Your code never leaves the machine._

---

## Troubleshooting

- **Not connected / exits immediately** — confirm `pnpm build` ran (`dist/server.js` must exist)
  and that `argv[2]` is the absolute path to a real directory. Startup logs go to **stderr**
  (stdout is reserved for the MCP protocol).
- **Logging.** Set `FLUTTER_INTEL_LOG=debug|info|warn|error` (default `info`) to control verbosity.
  All logs are structured JSON on stderr.
- **A file shows a syntax error in the health line** — that's a parse error localized to one file
  (often new Dart syntax the pinned grammar doesn't yet cover); the rest of the repo still indexes.

---

## License

MIT.
