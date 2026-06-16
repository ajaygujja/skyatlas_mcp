import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildIndex } from '../index/indexer.js';
import { createServer } from '../server.js';

const WIRING_FIXTURES = fileURLToPath(new URL('../../fixtures/wiring', import.meta.url));

// In-process MCP test of the formatted find_state_wiring contract (§9.3).
// Resolution is cross-file (screen, bloc and repo live in separate files), so we
// index the whole fixture dir via buildIndex and drive the real server over an
// in-memory transport — mirroring get-route-graph.test.ts.
describe('find_state_wiring (formatted response)', () => {
  const client = new Client({ name: 'wiring-test', version: '0.0.0' });
  let root: string;

  async function callWiring(args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name: 'find_state_wiring', arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? '';
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'skyatlas-wiring-'));
    await cp(WIRING_FIXTURES, root, { recursive: true });
    const { index } = await buildIndex(root);
    const server = createServer(() => Promise.resolve(index));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves screen → cubit → repository across files, with route reachability', async () => {
    const text = await callWiring({ screen: 'CounterScreen' });
    expect(text).toContain("# State wiring: screen 'CounterScreen' — counter_screen.dart:8");
    expect(text).toContain('stateless screen');
    // Cross-referenced from the go_router route that builds it.
    expect(text).toContain('Reachable via route: /counter (counter) — router.dart:8');
    // The cubit, resolved by name-match to its cross-file declaration.
    expect(text).toContain('→ CounterCubit (cubit) — counter_cubit.dart:5');
    // Both the create and the read edges, grouped under the one target.
    expect(text).toContain('createsBloc · counter_screen.dart:13 (syntactic)');
    expect(text).toContain('readsBloc · counter_screen.dart:15 (syntactic)');
    // The repository the cubit takes in its constructor field — the chain's leaf.
    expect(text).toContain(
      'repo _repo: CounterRepository — repositories.dart:3 (via counter_cubit.dart:8, syntactic)',
    );
    expect(text).toContain('Connections are syntactic name-matches, not type-resolved.');
  });

  it('reaches a stateful screen via its State<Screen> companion', async () => {
    const text = await callWiring({ screen: 'ProfileScreen' });
    // The read happens in _ProfileScreenState; wiring still attributes it to the screen.
    expect(text).toContain('→ ProfileBloc (bloc) — profile_bloc.dart:9');
    expect(text).toContain('readsBloc · profile_screen.dart:19 (syntactic)');
    expect(text).toContain(
      'repo _repo: ProfileRepository — repositories.dart:7 (via profile_bloc.dart:12, syntactic)',
    );
  });

  it('resolves screen → provider for a Riverpod consumer', async () => {
    const text = await callWiring({ screen: 'SettingsScreen' });
    expect(text).toContain("# State wiring: screen 'SettingsScreen' — settings_screen.dart:7");
    expect(text).toContain('→ settingsProvider (provider) — providers.dart:3');
    expect(text).toContain('watchesProvider · settings_screen.dart:12 (syntactic)');
  });

  it('reports an unresolved bloc target honestly, never invents it', async () => {
    const text = await callWiring({ screen: 'ExternalScreen' });
    expect(text).toContain('→ ExternalBloc (unresolved — no matching declaration in the index)');
    expect(text).toContain('readsBloc · external_screen.dart:11 (syntactic)');
  });

  it('explains absence and points at the detected stack (§6 rule 5)', async () => {
    const text = await callWiring({ screen: 'OrphanScreen' });
    expect(text).toContain("No Bloc or provider found wiring to 'OrphanScreen'");
    expect(text).toContain('Detected state mgmt in this repo:');
    expect(text).toContain('Bloc');
    expect(text).toContain('Riverpod');
  });

  it('reverses the view for a bloc filter: sources in, repositories out', async () => {
    const text = await callWiring({ bloc: 'CounterCubit' });
    expect(text).toContain("# State wiring: cubit 'CounterCubit' — counter_cubit.dart:5");
    expect(text).toContain('Wired from 1 source(s):');
    expect(text).toContain('← CounterScreen — counter_screen.dart:8');
    expect(text).toContain('createsBloc · counter_screen.dart:13 (syntactic)');
    expect(text).toContain('Repositories (constructor/field deps, syntactic):');
    expect(text).toContain(
      '- _repo: CounterRepository — repositories.dart:3 (via counter_cubit.dart:8)',
    );
  });

  it('flags a State<Screen> companion source on the bloc reverse view', async () => {
    const text = await callWiring({ bloc: 'ProfileBloc' });
    expect(text).toContain(
      '← _ProfileScreenState (State of ProfileScreen) — profile_screen.dart:16',
    );
  });

  it('reverses the view for a provider filter: watching screens in', async () => {
    const text = await callWiring({ provider: 'settingsProvider' });
    expect(text).toContain(
      "# State wiring: provider 'settingsProvider' (StateProvider) — providers.dart:3",
    );
    expect(text).toContain('Wired from 1 source(s):');
    expect(text).toContain('← SettingsScreen — settings_screen.dart:7');
    expect(text).toContain('watchesProvider · settings_screen.dart:12 (syntactic)');
  });

  it('requires exactly one filter', async () => {
    const none = await callWiring({});
    expect(none).toContain('exactly one of screen=, bloc=, or provider=');
    const two = await callWiring({ screen: 'CounterScreen', bloc: 'CounterCubit' });
    expect(two).toContain('exactly one of screen=, bloc=, or provider=');
  });

  it('explains a name that resolves to nothing', async () => {
    const text = await callWiring({ bloc: 'NoSuchBloc' });
    expect(text).toContain("No Bloc/Cubit named 'NoSuchBloc' in the index");
    expect(text).toContain('find_symbol');
  });
});
