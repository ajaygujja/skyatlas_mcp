import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex } from './indexer.js';
import { walkWorkspace, packageForFile, isGeneratedFile } from './workspace.js';

const MINI_APP = fileURLToPath(new URL('../../fixtures/mini-app', import.meta.url));

// Each test gets a disposable copy: buildIndex writes .skyatlas/cache.json,
// and tests mutate files — the checked-in fixture must stay pristine.
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skyatlas-test-'));
  await cp(MINI_APP, root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('walkWorkspace', () => {
  it('finds dart files, skips .gitignore matches, maps packages', async () => {
    const { dartFiles, packages } = await walkWorkspace(root);
    expect(dartFiles).toEqual([
      'lib/blocs/user_bloc.dart',
      'lib/main.dart',
      'lib/models/user_model.g.dart',
      'packages/shared_ui/lib/button.dart',
    ]);
    expect(packages).toEqual([
      { name: 'mini_app', path: '' },
      { name: 'shared_ui', path: 'packages/shared_ui' },
    ]);
  });

  it('honors gitignore patterns added at runtime', async () => {
    await writeFile(join(root, 'lib/scratch.tmp.dart'), 'class Tmp {}');
    const { dartFiles } = await walkWorkspace(root);
    expect(dartFiles).not.toContain('lib/scratch.tmp.dart');
  });
});

describe('packageForFile / isGeneratedFile', () => {
  const packages = [
    { name: 'mini_app', path: '' },
    { name: 'shared_ui', path: 'packages/shared_ui' },
  ];

  it('assigns the deepest containing package', () => {
    expect(packageForFile('lib/main.dart', packages)).toBe('mini_app');
    expect(packageForFile('packages/shared_ui/lib/button.dart', packages)).toBe('shared_ui');
  });

  it('flags generated suffixes only', () => {
    expect(isGeneratedFile('lib/models/user_model.g.dart')).toBe(true);
    expect(isGeneratedFile('lib/models/user_model.freezed.dart')).toBe(true);
    expect(isGeneratedFile('lib/router.gr.dart')).toBe(true);
    expect(isGeneratedFile('lib/grid.dart')).toBe(false);
  });
});

describe('buildIndex', () => {
  it('indexes the mini app with packages, lookup maps, and imports', async () => {
    const { index, stats } = await buildIndex(root);
    expect(stats.fileCount).toBe(4);
    expect(stats.parsedCount).toBe(4);
    expect(stats.cachedCount).toBe(0);
    expect(stats.packageCount).toBe(2);

    const bloc = index.findByName('UserBloc')[0];
    expect(bloc?.kind).toBe('class');
    expect(bloc?.extendsType).toEqual({ name: 'Bloc', typeArgs: ['UserEvent', 'int'] });
    expect(index.files.get('lib/main.dart')?.package).toBe('mini_app');
    expect(index.files.get('packages/shared_ui/lib/button.dart')?.package).toBe('shared_ui');
    expect(index.files.get('lib/main.dart')?.imports.map((i) => i.uri)).toEqual([
      'package:flutter/material.dart',
      'package:mini_app/blocs/user_bloc.dart',
      'package:shared_ui/button.dart',
    ]);
    expect(index.files.get('lib/main.dart')?.imports[2]?.prefix).toBe('ui');
    expect(index.symbolsById.get('lib/main.dart#HomeScreen')?.name).toBe('HomeScreen');
  });

  it('marks generated files and excludes them from default find results', async () => {
    const { index } = await buildIndex(root);
    expect(index.files.get('lib/models/user_model.g.dart')?.generated).toBe(true);
    expect(index.findByName('userToJson')).toEqual([]);
    expect(index.findByName('userToJson', { includeGenerated: true })).toHaveLength(1);
  });

  it('warm start serves unchanged files from cache, re-parses edits', async () => {
    await buildIndex(root);
    const warm = await buildIndex(root);
    expect(warm.stats.cachedCount).toBe(4);
    expect(warm.stats.parsedCount).toBe(0);

    const mainPath = join(root, 'lib/main.dart');
    await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\nclass Added {}\n');
    const third = await buildIndex(root);
    expect(third.stats.cachedCount).toBe(3);
    expect(third.stats.parsedCount).toBe(1);
    expect(third.index.findByName('Added')).toHaveLength(1);
  });

  it('ranks exact name hits above prefix and substring hits', async () => {
    const { index } = await buildIndex(root);
    const results = index.findByName('user', { kind: 'class' });
    const names = results.map((s) => s.name);
    expect(names).toContain('UserBloc');
    expect(names).toContain('UserEvent');
    const exact = index.findByName('UserBloc');
    expect(exact[0]?.name).toBe('UserBloc');
  });
});
