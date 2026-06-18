# Contributing

## Working rules

This project is built to the spec in [`TECHNICAL_DESIGN.md`](TECHNICAL_DESIGN.md). Read it first —
especially §4.1 (layer boundaries), §3.2 (non-goals), and §10 (Working Rules for AI Assistants).
The short version:

- **Layer boundaries are law.** Parser knows nothing of Flutter; extractors know nothing of MCP;
  tools know nothing of tree-sitter. If a tool seems to need tree-sitter, the Index API is missing
  something — extend it.
- **Never invent tree-sitter node names.** Run `pnpm dump-tree` on a real snippet and write queries
  against the observed CST (§7.2).
- **Fixtures first.** New extraction behavior starts as a failing fixture under `fixtures/<topic>/`,
  then the implementation. Every wrong answer becomes a fixture _before_ it becomes a fix.
- **Never print to stdout** — it corrupts the MCP channel. Use the stderr logger
  (`src/shared/logger.ts`). A guard test (`src/shared/logger.test.ts`) enforces this across `src/`.
- **Stay green.** Before every commit: `pnpm build && pnpm lint && pnpm test && pnpm format:check`.

## Local checks

```bash
pnpm build            # tsc → dist/
pnpm lint             # eslint, --max-warnings 0
pnpm test             # vitest run
pnpm format:check     # prettier --check
pnpm dump-tree <file> # inspect the CST of a Dart snippet
pnpm benchmark        # cold/warm index timings
```

Before opening a PR, run all of `pnpm build && pnpm lint && pnpm test && pnpm format:check` and fill
in the pull-request checklist.
