/**
 * Multi-extractor repro harness. Runs every pure extractor over a fixture file
 * and dumps the raw extraction as JSON. Tests the parse/extract layer on patterns
 * a single repo may not contain. NOT a fix — diagnosis only.
 *
 *   pnpm tsx scripts/repro-extract.ts path/to/file.dart [which]
 *   which = routes | providers | blocs | widgets | consts | all (default all)
 */
import { readFileSync } from 'node:fs';
import { initParser, parseText } from '../src/parser/parser.js';
import { extractRoutes } from '../src/extractors/route-extractor.js';
import { extractProviders } from '../src/extractors/riverpod-extractor.js';
import { extractBlocs } from '../src/extractors/bloc-extractor.js';
import { extractWidgets } from '../src/extractors/widget-extractor.js';
import { extractStringConsts } from '../src/extractors/string-const-extractor.js';
import { extractSymbols } from '../src/extractors/symbol-extractor.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  const which = process.argv[3] ?? 'all';
  if (!target) {
    process.stderr.write('usage: repro-extract.ts <file.dart> [routes|providers|blocs|widgets|consts|all]\n');
    process.exit(1);
  }
  const source = readFileSync(target, 'utf8');
  await initParser();
  const tree = parseText(source);
  const rel = target;
  const out: Record<string, unknown> = {};
  if (which === 'routes' || which === 'all') out.routes = extractRoutes(tree, rel);
  if (which === 'providers' || which === 'all') out.providers = extractProviders(tree, rel);
  if (which === 'blocs' || which === 'all') out.blocs = extractBlocs(tree, rel);
  if (which === 'widgets' || which === 'all') out.widgets = extractWidgets(tree, rel);
  if (which === 'symbols' || which === 'all') out.symbols = extractSymbols(tree, rel);
  if (which === 'consts' || which === 'all') {
    const sc = extractStringConsts(tree);
    out.consts = Object.fromEntries(sc instanceof Map ? sc : Object.entries(sc as object));
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

void main();
