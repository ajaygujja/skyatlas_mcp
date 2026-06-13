import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseFile } from '../parser/parser.js';
import { extractProviders, type ProviderExtraction } from './riverpod-extractor.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/riverpod', import.meta.url));

beforeAll(async () => {
  await initParser();
});

async function extractFixture(name: string): Promise<ProviderExtraction> {
  const { tree } = await parseFile(resolve(FIXTURES, name));
  return extractProviders(tree, `fixtures/riverpod/${name}`);
}

describe('extractProviders', () => {
  // Snapshots are the extraction contract: a diff in review = behavior change (§9.3).
  it.each(readdirSync(FIXTURES).filter((f) => f.endsWith('.dart')))(
    'matches snapshot: %s',
    async (file) => {
      expect(await extractFixture(file)).toMatchSnapshot();
    },
  );

  it('classifies a single-type-arg global provider through the mis-parse', async () => {
    const { providers } = await extractFixture('providers.dart');
    const p = providers.find((x) => x.name === 'counterProvider');
    expect(p).toMatchObject({
      declKind: 'global',
      providerType: 'StateProvider',
      typeArgs: ['int'],
    });
  });

  it('reads the constructor through a .autoDispose chain', async () => {
    const { providers } = await extractFixture('providers.dart');
    expect(providers.find((x) => x.name === 'asyncUserProvider')).toMatchObject({
      providerType: 'FutureProvider',
      typeArgs: ['User'],
    });
  });

  it('reads a clean two-type-arg provider and a .family provider', async () => {
    const { providers } = await extractFixture('providers.dart');
    expect(providers.find((x) => x.name === 'userNotifierProvider')).toMatchObject({
      providerType: 'NotifierProvider',
      typeArgs: ['UserNotifier', 'UserState'],
    });
    // `Provider.family<User, String>` → base ctor name + both type args.
    expect(providers.find((x) => x.name === 'userByIdProvider')).toMatchObject({
      providerType: 'Provider',
      typeArgs: ['User', 'String'],
    });
  });

  it('reads a no-type-arg provider and omits typeArgs', async () => {
    const { providers } = await extractFixture('providers.dart');
    const p = providers.find((x) => x.name === 'loggerProvider');
    expect(p?.providerType).toBe('Provider');
    expect(p?.typeArgs).toBeUndefined();
  });

  it('does not treat a plain final as a provider', async () => {
    const { providers } = await extractFixture('providers.dart');
    expect(providers.map((p) => p.name)).not.toContain('appName');
  });

  it('detects @riverpod function and class providers as generated', async () => {
    const { providers } = await extractFixture('generated_providers.dart');
    expect(providers).toContainEqual({
      symbolId: 'fixtures/riverpod/generated_providers.dart#count',
      name: 'count',
      declKind: 'generated',
      file: 'fixtures/riverpod/generated_providers.dart',
      line: 10,
    });
    expect(providers).toContainEqual({
      symbolId: 'fixtures/riverpod/generated_providers.dart#UserController',
      name: 'UserController',
      declKind: 'generated',
      file: 'fixtures/riverpod/generated_providers.dart',
      line: 14,
    });
    // `@Riverpod(keepAlive: true)` — capitalized, with args — is still ours.
    expect(providers.find((p) => p.name === 'appTitle')?.declKind).toBe('generated');
  });

  it('emits watchesProvider edges for ref.watch/read/listen', async () => {
    const { edges } = await extractFixture('consumer_view.dart');
    const from = 'fixtures/riverpod/consumer_view.dart#HomeView';
    expect(edges).toContainEqual({
      from,
      to: 'counterProvider',
      kind: 'watchesProvider',
      line: 12,
      confidence: 'syntactic',
    });
    expect(edges).toContainEqual({
      from,
      to: 'userProvider',
      kind: 'watchesProvider',
      line: 13,
      confidence: 'syntactic',
    });
    expect(edges).toContainEqual({
      from,
      to: 'asyncUserProvider',
      kind: 'watchesProvider',
      line: 14,
      confidence: 'syntactic',
    });
    // `.notifier` suffix resolves to the base provider.
    expect(edges).toContainEqual({
      from,
      to: 'userNotifierProvider',
      kind: 'watchesProvider',
      line: 16,
      confidence: 'syntactic',
    });
  });

  it('emits no edges for a pure provider-declaration file', async () => {
    const { edges } = await extractFixture('providers.dart');
    expect(edges).toEqual([]);
  });
});
