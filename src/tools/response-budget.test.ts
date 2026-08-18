import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import type { ProjectIndex } from '../index/project-index.js';
import { resolveRoutes, type RouteView } from '../index/route-view.js';
import { computeWiring } from '../index/wiring.js';
import { createServer } from '../server.js';

/**
 * Response size is part of the tool contract (TECHNICAL_DESIGN.md §6): a call
 * that costs more than the grep sequence it replaces is a call an agent is right
 * to avoid. These tests pin the two properties that keep it that way:
 *
 * 1. **Budgets.** A `summary` stays inside a few hundred tokens and `normal`
 *    inside a few thousand, so neither regrows silently as features land.
 * 2. **Preservation.** The compaction that buys those budgets — aggregating call
 *    sites, anchoring locations on declarations already named — must not drop a
 *    location. Every `file:line` the index resolves is asserted recoverable from
 *    the rendered response, which is the property truncation would break.
 *
 * Fixtures are copied under a nested directory so path compaction is exercised:
 * flat fixture paths are one segment long and would hide it.
 */

const ROUTE_FIXTURES = fileURLToPath(new URL('../../fixtures/routes', import.meta.url));
const WIRING_FIXTURES = fileURLToPath(new URL('../../fixtures/wiring', import.meta.url));

/** Characters per token, matching `scripts/response-probe.ts`. */
const CHARS_PER_TOKEN = 4;

const SUMMARY_TOKEN_BUDGET = 500;
const NORMAL_TOKEN_BUDGET = 2_000;

function estTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

/**
 * Every location a response states, with compacted forms expanded back to
 * `file:line`. Mirrors the two conventions the tools document:
 *
 * - `path/to/file.dart:12,48` — an aggregated group of call sites in one file.
 * - `Name:12` — a line in the file of the declaration `Name`, which the response
 *   named in full earlier; the map of names to files is built while reading.
 * - `:12` — a line in the last file named above, used where each line carries a
 *   single location.
 */
function locationsIn(text: string): Set<string> {
  const found = new Set<string>();
  const fileOfName = new Map<string, string>();
  let lastFile: string | undefined;

  for (const line of text.split('\n')) {
    // Bind declaration names to the files they were named in full in. A response
    // names a declaration in three places, each of which an anchor can refer to:
    //   `→ CounterCubit (cubit) — counter_cubit.dart:5`      block header
    //   `screen 'CounterScreen' — counter_screen.dart:8`     subject title
    //   `repo _r: CounterRepository — repositories.dart:3`   dependency line
    //   `repo r: FormRepository → FormRepositoryImpl impl.dart:9 — iface.dart:3`
    for (const pattern of [
      /(?:[→←] |')([A-Za-z_$][\w$]*)'?[^—]*— ([\w./-]+\.dart):\d+/,
      /: ([A-Za-z_$][\w$]*)(?: \([^)]*\))? — ([\w./-]+\.dart):\d+/,
      / → ([A-Za-z_$][\w$]*) ([\w./-]+\.dart):\d+/,
    ]) {
      const declared = pattern.exec(line);
      if (declared?.[1] && declared[2]) fileOfName.set(declared[1], declared[2]);
    }

    for (const match of line.matchAll(/(?:([\w./-]+\.dart)|([A-Za-z_$][\w$]*))?:(\d+(?:,\d+)*)/g)) {
      const [, path, name, lines] = match;
      const file = path ?? (name !== undefined ? fileOfName.get(name) : lastFile) ?? lastFile;
      if (path) lastFile = path;
      if (!file || !lines) continue;
      for (const one of lines.split(',')) found.add(`${file}:${one}`);
    }
  }
  return found;
}

async function connect(index: ProjectIndex, client: Client): Promise<void> {
  const server = createServer(() => Promise.resolve(index));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
}

/** Copies a fixture dir under `lib/<name>/` so rendered paths carry real depth. */
async function nestedFixtureRoot(prefix: string, fixtures: string, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const nested = join(root, 'lib', name);
  await mkdir(join(root, 'lib'), { recursive: true });
  await cp(fixtures, nested, { recursive: true });
  return root;
}

describe('get_route_graph response budget', () => {
  const client = new Client({ name: 'route-budget-test', version: '0.0.0' });
  let root: string;
  let index: ProjectIndex;

  async function callGraph(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'get_route_graph', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await nestedFixtureRoot('skyatlas-route-budget-', ROUTE_FIXTURES, 'nav');
    index = (await buildIndex(root)).index;
    await connect(index, client);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('stays inside the token budget at each verbosity', async () => {
    expect(estTokens(await callGraph({ verbosity: 'summary' }))).toBeLessThan(SUMMARY_TOKEN_BUDGET);
    expect(estTokens(await callGraph())).toBeLessThan(NORMAL_TOKEN_BUDGET);
  });

  it('reports every route location, compaction included', async () => {
    const text = await callGraph();
    const reported = locationsIn(text);
    const expected = flatten(resolveRoutes(index).go).map(
      (view) => `${view.route.file}:${String(view.route.line)}`,
    );
    expect(expected.length).toBeGreaterThan(10); // the fixture is worth asserting over
    for (const location of expected) expect(reported).toContain(location);
  });

  it('names the declaring files and top-level paths in a summary', async () => {
    const text = await callGraph({ verbosity: 'summary' });
    expect(text).toContain('# Route graph (summary):');
    expect(text).toContain('Declared in');
    expect(text).toContain('Top-level paths');
    expect(text).toContain('lib/nav/go_router_app.dart');
    // Shape only — no per-route rendering at this verbosity.
    expect(text).not.toContain('→ HomeScreen');
  });
});

describe('find_state_wiring response budget', () => {
  const client = new Client({ name: 'wiring-budget-test', version: '0.0.0' });
  let root: string;
  let index: ProjectIndex;

  async function callWiring(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'find_state_wiring', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await nestedFixtureRoot('skyatlas-wiring-budget-', WIRING_FIXTURES, 'state');
    index = (await buildIndex(root)).index;
    await connect(index, client);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('stays inside the token budget at each verbosity', async () => {
    const summary = await callWiring({ screen: 'CounterScreen', verbosity: 'summary' });
    expect(estTokens(summary)).toBeLessThan(SUMMARY_TOKEN_BUDGET);
    expect(estTokens(await callWiring({ screen: 'CounterScreen' }))).toBeLessThan(
      NORMAL_TOKEN_BUDGET,
    );
    expect(estTokens(await callWiring({ bloc: 'ConstructionFormsBloc', depth: 4 }))).toBeLessThan(
      NORMAL_TOKEN_BUDGET,
    );
  });

  it('reports every wiring location, aggregation and anchors included', async () => {
    const text = await callWiring({ screen: 'RepeatReadScreen' });
    const reported = locationsIn(text);
    const wiring = computeWiring(index, { kind: 'screen', name: 'RepeatReadScreen' });

    const expected = new Set<string>();
    for (const group of wiring.targets) {
      if (group.target.decl) {
        expected.add(`${group.target.decl.file}:${String(group.target.decl.line)}`);
      }
      for (const ref of group.via) {
        expected.add(`${ref.callSite.file}:${String(ref.callSite.line)}`);
      }
      for (const repo of group.repos) {
        expected.add(`${repo.decl.file}:${String(repo.decl.line)}`);
        expected.add(`${repo.via.file}:${String(repo.via.line)}`);
      }
    }
    expect(expected.size).toBeGreaterThan(3);
    for (const location of expected) expect(reported).toContain(location);
  });
});

/** Every route in a forest, parents before children. */
function flatten(views: RouteView[]): RouteView[] {
  return views.flatMap((view) => [view, ...flatten(view.children)]);
}
