/**
 * doctor — parse-coverage health report for a Flutter workspace.
 *
 * Unlike `benchmark` (timing + budgets), doctor answers "did the WHOLE project
 * index cleanly, and if not, exactly which files and why?" — the report you run
 * after pointing the server at a new repo, and the one users send back so their
 * failing files can become fixtures (TECHNICAL_DESIGN.md §9.4 graceful degradation).
 *
 * Two failure tiers are reported separately:
 *   Tier A — file skipped entirely (unreadable / parse threw)  → stats.failures
 *   Tier B — file indexed, grammar hit unknown syntax mid-file → entry.parseErrors
 *
 * Usage:
 *   pnpm doctor /path/to/flutter/repo            # warm (cache as found)
 *   pnpm doctor /path/to/flutter/repo --cold     # delete cache first, full re-parse
 *   pnpm doctor /path/to/flutter/repo --json     # machine-readable report
 *
 * Exit code: 0 if every file indexed, 1 if any Tier-A file was skipped — so it
 * can gate CI.
 */
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildIndex } from '../src/index/indexer.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  if (!root) {
    process.stderr.write('usage: doctor <workspace-root> [--cold] [--json]\n');
    process.exit(1);
  }
  const workspace = resolve(root);
  const asJson = args.includes('--json');

  if (args.includes('--cold')) {
    rmSync(join(workspace, '.flutter-intel'), { recursive: true, force: true });
  }

  const { index, stats } = await buildIndex(workspace);

  // Tier B: indexed-but-imperfect files, gathered from the live index.
  const dirty = [...index.files.values()]
    .filter((f) => f.parseErrors.length > 0)
    .map((f) => ({ file: f.path, errors: f.parseErrors }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const cleanCount = stats.fileCount - dirty.length;
  const coverage = stats.fileCount === 0 ? 100 : (cleanCount / stats.fileCount) * 100;

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          workspace,
          ...stats,
          cleanCount,
          dirtyCount: dirty.length,
          coveragePct: Number(coverage.toFixed(2)),
          symbolCount: index.symbolsById.size,
          tierA_skipped: stats.failures,
          tierB_syntaxErrors: dirty,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(stats.failedCount > 0 ? 1 : 0);
  }

  const out = process.stdout;
  out.write(`\nflutter-intel doctor — ${workspace}\n`);
  out.write(`${'─'.repeat(60)}\n`);
  out.write(`packages       ${String(stats.packageCount)}\n`);
  out.write(`dart files     ${String(stats.fileCount)}\n`);
  out.write(`symbols        ${String(index.symbolsById.size)}\n`);
  out.write(
    `parsed/cached  ${String(stats.parsedCount)} parsed, ${String(stats.cachedCount)} from cache\n`,
  );
  out.write(`index time     ${String(stats.elapsedMs)} ms\n`);
  out.write(
    `coverage       ${coverage.toFixed(1)}% clean ` +
      `(${String(cleanCount)}/${String(stats.fileCount)} files parsed with no syntax errors)\n`,
  );

  // Tier A — hard skips.
  out.write(`\nTier A — skipped entirely (${String(stats.failedCount)}):\n`);
  if (stats.failures.length === 0) {
    out.write(`  none — every file was read and parsed.\n`);
  } else {
    for (const f of stats.failures) out.write(`  ✗ ${f.file}\n      ${f.error}\n`);
  }

  // Tier B — indexed, but grammar choked on something.
  out.write(`\nTier B — indexed with localized syntax errors (${String(dirty.length)}):\n`);
  if (dirty.length === 0) {
    out.write(`  none — grammar understood every file end to end.\n`);
  } else {
    for (const d of dirty) {
      out.write(`  ⚠ ${d.file}\n`);
      for (const e of d.errors.slice(0, 5)) out.write(`      ${e}\n`);
      if (d.errors.length > 5) out.write(`      … +${String(d.errors.length - 5)} more\n`);
    }
    out.write(
      `\n  These are almost always Dart syntax the pinned grammar doesn't yet cover.\n` +
        `  To turn one into a fixture: pnpm dump-tree <file> | grep -n ERROR\n` +
        `  then add the minimal snippet under fixtures/ with a test (see CONTRIBUTING.md).\n`,
    );
  }

  out.write(`${'─'.repeat(60)}\n`);
  out.write(
    stats.failedCount > 0
      ? `RESULT: ${String(stats.failedCount)} file(s) skipped — investigate above.\n`
      : dirty.length > 0
        ? `RESULT: all files indexed; ${String(dirty.length)} have localized syntax errors.\n`
        : `RESULT: clean — whole workspace indexed with zero errors.\n`,
  );

  process.exit(stats.failedCount > 0 ? 1 : 0);
}

void main();
