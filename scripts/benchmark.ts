/**
 * Index benchmark (TECHNICAL_DESIGN.md §8 Phase 2, §9.5): cold and warm
 * timings against a real workspace, checked against the budgets
 * (cold < 10 s / 1000 files, RSS < 500 MB).
 *
 * Usage:
 *   pnpm benchmark /path/to/flutter/repo            # warm run (cache as found)
 *   pnpm benchmark /path/to/flutter/repo --cold     # delete cache first
 *   pnpm benchmark /path/to/flutter/repo --record   # append to benchmarks/history.jsonl
 *
 * History lives in benchmarks/history.jsonl — §9.5 says keep it; a >2×
 * regression between entries is the alarm threshold (§9.3).
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildIndex } from '../src/index/indexer.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  if (!root) {
    process.stderr.write('usage: benchmark <workspace-root> [--cold] [--record]\n');
    process.exit(1);
  }
  const workspace = resolve(root);

  if (args.includes('--cold')) {
    rmSync(join(workspace, '.skyatlas'), { recursive: true, force: true });
  }

  const { index, stats } = await buildIndex(workspace);
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const result = {
    date: new Date().toISOString(),
    workspace,
    mode: args.includes('--cold') ? 'cold' : 'warm',
    ...stats,
    symbolCount: index.symbolsById.size,
    rssMb,
    msPerFile: stats.fileCount > 0 ? +(stats.elapsedMs / stats.fileCount).toFixed(2) : 0,
    budgets: {
      coldUnder10sPer1000Files: stats.elapsedMs < 10_000 * Math.max(1, stats.fileCount / 1000),
      rssUnder500Mb: rssMb < 500,
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (args.includes('--record')) {
    mkdirSync('benchmarks', { recursive: true });
    appendFileSync('benchmarks/history.jsonl', `${JSON.stringify(result)}\n`);
    process.stderr.write('recorded to benchmarks/history.jsonl\n');
  }
}

void main();
