/**
 * Response-size probe: what each tool actually costs the model that reads it.
 *
 * The index budgets in `benchmark.ts` cover time and memory; this covers the
 * other half of the contract (TECHNICAL_DESIGN.md §6: a response is a token
 * budget, not just a correct answer). A tool call must cost less than the grep
 * sequence it replaces, and the only way to know is to measure the formatted
 * response against a real repo.
 *
 * Calls are selected from the index rather than hardcoded, so the probe runs
 * against any workspace, and selected deterministically (ties broken by symbol
 * id) so two runs over the same repo are comparable in `benchmarks/history.jsonl`.
 * Each call is the widest realistic one for its tool — the case a session hits
 * when it does not yet know what to narrow to.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProjectIndex } from '../src/index/project-index.js';
import { featureOfFile } from '../src/index/feature-scope.js';
import { createServer } from '../src/server.js';

/**
 * Characters per token used to report an estimate alongside the measured
 * character count. Characters are the recorded metric — they are exact and
 * tokenizer-independent; the estimate exists only to compare against the
 * token budgets the tool descriptions are written for.
 */
const CHARS_PER_TOKEN = 4;

/** Dependency hops that exercise the deepest wiring walk a caller can request. */
const DEEP_WIRING_DEPTH = 3;

export interface ProbeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ResponseMeasurement {
  /** `tool(arg=value, …)`, stable across runs so history entries line up. */
  call: string;
  chars: number;
  lines: number;
  estTokens: number;
  /** Longest single line — a cap on lines cannot bound a response of long lines. */
  maxLineChars: number;
  /** Whether the response ended in an explicit truncation notice. */
  truncated: boolean;
  elapsedMs: number;
}

/**
 * The widest realistic call per tool for this workspace. An empty result means
 * the index holds nothing to query — a probe of an empty repo measures nothing
 * rather than reporting zero cost.
 */
export function probeCalls(index: ProjectIndex): ProbeCall[] {
  const calls: ProbeCall[] = [{ tool: 'get_project_map', args: {} }];

  const bloc = widestBloc(index);
  const screen = busiestScreen(index);

  if (bloc) {
    calls.push(
      { tool: 'find_symbol', args: { query: searchFragment(bloc) } },
      { tool: 'get_symbol', args: { name: bloc } },
      { tool: 'find_state_wiring', args: { bloc } },
      { tool: 'find_state_wiring', args: { bloc, depth: DEEP_WIRING_DEPTH } },
    );
  }
  if (screen) {
    calls.push(
      { tool: 'get_widget_tree', args: { widget: screen, follow: true } },
      { tool: 'find_state_wiring', args: { screen } },
    );
  }
  calls.push({ tool: 'get_route_graph', args: {} });
  const feature = busiestFeature(index);
  if (feature !== undefined) calls.push({ tool: 'get_route_graph', args: { feature } });
  return calls;
}

/**
 * Feature holding the most files, as the scoped call a session makes once it
 * knows what it is working on. Measuring it alongside the whole graph is what
 * shows whether scoping is worth reaching for.
 */
function busiestFeature(index: ProjectIndex): string | undefined {
  const counts = new Map<string, number>();
  for (const path of index.files.keys()) {
    const feature = featureOfFile(path);
    if (feature !== undefined) counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0];
}

/** Measures each call's formatted response over an in-memory MCP round trip. */
export async function measureResponses(
  index: ProjectIndex,
  calls: ProbeCall[],
): Promise<ResponseMeasurement[]> {
  const server = createServer(() => Promise.resolve(index));
  const client = new Client({ name: 'skyatlas-response-probe', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const out: ResponseMeasurement[] = [];
    for (const call of calls) {
      const started = Date.now();
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      const elapsedMs = Date.now() - started;
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      const lines = text.split('\n');
      out.push({
        call: describeCall(call),
        chars: text.length,
        lines: lines.length,
        estTokens: Math.round(text.length / CHARS_PER_TOKEN),
        maxLineChars: lines.reduce((max, line) => Math.max(max, line.length), 0),
        truncated: /… \d+ more/.test(text),
        elapsedMs,
      });
    }
    return out;
  } finally {
    await client.close();
  }
}

function describeCall(call: ProbeCall): string {
  const args = Object.entries(call.args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  return `${call.tool}(${args})`;
}

/**
 * The Bloc/Cubit with the most constructor parameters — the widest dependency
 * expansion `find_state_wiring` can be asked to print for a single subject.
 */
function widestBloc(index: ProjectIndex): string | undefined {
  let pick: { name: string; id: string; params: number } | undefined;
  for (const info of index.blocs.values()) {
    const sym = index.symbolsById.get(info.symbolId);
    if (!sym) continue;
    const params = sym.children
      .filter((child) => child.kind === 'constructor')
      .reduce((max, ctor) => Math.max(max, ctor.parameters?.length ?? 0), 0);
    if (!pick || params > pick.params || (params === pick.params && info.symbolId < pick.id)) {
      pick = { name: sym.name, id: info.symbolId, params };
    }
  }
  return pick?.name;
}

/**
 * The widget that creates the most blocs — the screen whose wiring and build
 * tree are the largest in the repo. State companion classes are excluded: a
 * caller queries the screen by its own name, and both tools cross to the
 * companion themselves.
 */
function busiestScreen(index: ProjectIndex): string | undefined {
  const created = new Map<string, number>();
  for (const edge of index.edges) {
    if (edge.kind !== 'createsBloc') continue;
    created.set(edge.from, (created.get(edge.from) ?? 0) + 1);
  }

  let pick: { name: string; id: string; blocs: number } | undefined;
  for (const widget of index.widgets.values()) {
    if (widget.flavor === 'state') continue;
    const blocs = created.get(widget.symbolId) ?? 0;
    if (blocs === 0) continue;
    if (!pick || blocs > pick.blocs || (blocs === pick.blocs && widget.symbolId < pick.id)) {
      pick = { name: widget.name, id: widget.symbolId, blocs };
    }
  }
  return pick?.name;
}

/** `FormPlayerBloc` → `FormPlayer`: a fragment wide enough to match many symbols. */
function searchFragment(blocName: string): string {
  return blocName.replace(/(Bloc|Cubit)$/, '') || blocName;
}
