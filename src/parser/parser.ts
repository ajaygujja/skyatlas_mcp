/**
 * Parser layer: web-tree-sitter initialization and Dart parsing.
 *
 * Knows nothing about Flutter or symbols (TECHNICAL_DESIGN.md §4.1).
 * Grammar wasm is vendored and pinned — see vendor/GRAMMAR_VERSION.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Parser, Language, type Tree } from 'web-tree-sitter';

const WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../vendor/tree-sitter-dart.wasm',
);

let dartParser: Parser | null = null;

/**
 * Initialize the wasm runtime and load the Dart grammar. Idempotent;
 * subsequent calls reuse the same parser instance.
 */
export async function initParser(): Promise<void> {
  if (dartParser) return;
  await Parser.init();
  const language = await Language.load(WASM_PATH);
  const parser = new Parser();
  parser.setLanguage(language);
  dartParser = parser;
}

function getParser(): Parser {
  if (!dartParser) {
    throw new Error('Parser not initialized — call initParser() first');
  }
  return dartParser;
}

/** Parse Dart source text into a CST. */
export function parseText(text: string): Tree {
  const tree = getParser().parse(text);
  // Decision: parse() is typed nullable only for cancellation/timeout options
  // we never pass; a null here means the parser itself is broken.
  if (!tree) throw new Error('tree-sitter returned null tree');
  return tree;
}

/** Read a file from disk and parse it. */
export async function parseFile(path: string): Promise<{ tree: Tree; text: string }> {
  const text = await readFile(path, 'utf8');
  return { tree: parseText(text), text };
}

/** The loaded Dart grammar, for compiling queries. */
export function getLanguage(): Language {
  const language = getParser().language;
  if (!language) throw new Error('Parser has no language set');
  return language;
}
