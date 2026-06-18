# Security Policy

## Reporting a vulnerability

Please report security issues privately — **do not** open a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/ajaygujja/skyatlas_mcp/security/advisories/new),
or email **ajaygujja5@gmail.com** with details and, if possible, a minimal reproduction.

Expect an acknowledgement within a few days. Once a fix is available, a patched release is
published and the advisory is disclosed.

## Scope and threat model

skyatlas-mcp is designed to minimize attack surface:

- **Read-only.** It never writes to your source. Its only write is the warm-start cache under
  `.skyatlas/` inside the indexed repo.
- **Local-only.** No network calls at runtime — no telemetry, no remote calls, no code upload. The
  parser is local WASM and everything stays in-process.
- **Workspace-scoped.** It reads only `.dart` files under the workspace root passed as `argv[2]`.

In-scope reports include anything that breaks the above guarantees — e.g. a path that escapes the
workspace root, an unexpected write outside `.skyatlas/`, any outbound network call, or stdout
writes that corrupt the MCP channel.

## Supported versions

The latest published release receives security fixes.
