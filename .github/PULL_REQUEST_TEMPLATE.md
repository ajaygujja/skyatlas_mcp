<!-- See CONTRIBUTING.md before opening. Layer boundaries are law; fixtures come first. -->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

Closes #

## Checklist

- [ ] New/changed extraction behavior started as a **failing fixture** under `fixtures/<topic>/`, then the fix.
- [ ] No tree-sitter node names invented — queries written against `pnpm dump-tree` output.
- [ ] No `stdout` writes (uses the stderr logger).
- [ ] Layer boundaries respected (parser ⊥ Flutter, extractors ⊥ MCP, tools ⊥ tree-sitter).
- [ ] Green locally: `pnpm build && pnpm lint && pnpm test && pnpm format:check`.
- [ ] Docs updated if behavior or tool surface changed.
