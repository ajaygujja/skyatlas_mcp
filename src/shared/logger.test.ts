import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * stdout is the MCP JSON-RPC channel; a single stray write corrupts the
 * protocol (TECHNICAL_DESIGN.md §9.4, Working Rule 7). This guard fails the
 * build the moment any source file reaches for stdout or console outside the
 * one sanctioned path (the stderr logger). Comments/strings are stripped so a
 * doc-comment mentioning `console.log` (as logger.ts does) doesn't trip it.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__snapshots__') continue;
      out.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      // Production source only: tests never run in the server process and are
      // excluded from dist (tsconfig.build.json), so a token in a test is harmless.
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments and string/template literals — code only. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const FORBIDDEN = [/\bconsole\s*\./, /\bprocess\s*\.\s*stdout\b/];

describe('stdout cleanliness (Working Rule 7)', () => {
  it('no source file writes to stdout or uses console.*; stderr logger is the only output path', async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      // The logger module legitimately owns process.stderr; only stdout/console are banned.
      const code = stripCommentsAndStrings(await readFile(file, 'utf8'));
      if (FORBIDDEN.some((re) => re.test(code))) {
        offenders.push(file.slice(SRC_ROOT.length));
      }
    }
    expect(offenders).toEqual([]);
  });
});
