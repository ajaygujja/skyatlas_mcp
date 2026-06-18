import { beforeAll, describe, expect, it } from 'vitest';
import { initParser, parseText } from '../parser/parser.js';
import { extractStringConsts } from './string-const-extractor.js';

beforeAll(async () => {
  await initParser();
});

describe('extractStringConsts', () => {
  it('captures class string consts under both qualified and bare keys', () => {
    const consts = extractStringConsts(
      parseText(`class RoutePaths {
        static const String home = '/home';
        static const detail = '/detail';
      }`),
    );
    expect(consts['RoutePaths.home']).toBe('/home');
    expect(consts['RoutePaths.detail']).toBe('/detail');
    expect(consts['home']).toBe('/home');
  });

  it('captures top-level string consts by bare name', () => {
    const consts = extractStringConsts(parseText(`const homePath = '/home';`));
    expect(consts['homePath']).toBe('/home');
  });

  it('resolves enum-value ctor args under qualified keys (B6/N1)', () => {
    const consts = extractStringConsts(
      parseText(`enum AppRoutes {
        splash('/splash'),
        home('/home');
        const AppRoutes(this.path);
        final String path;
      }`),
    );
    // B6: positional arg mapped to ctor param name `path`.
    expect(consts['AppRoutes.splash.path']).toBe('/splash');
    expect(consts['AppRoutes.home.path']).toBe('/home');
    // N1: the value's own identifier resolves `.name`.
    expect(consts['AppRoutes.splash.name']).toBe('splash');
    // No bare fallback for enum fields — `path`/`name` collide across enums.
    expect(consts['path']).toBeUndefined();
    expect(consts['name']).toBeUndefined();
  });

  it('skips non-string enum args (string-only map)', () => {
    const consts = extractStringConsts(
      parseText(`enum Level {
        low(0),
        high(10);
        const Level(this.weight);
        final int weight;
      }`),
    );
    expect(consts['Level.low.weight']).toBeUndefined();
    // .name still resolves — it is always a string identifier.
    expect(consts['Level.low.name']).toBe('low');
  });

  it('ignores non-string initializers', () => {
    const consts = extractStringConsts(
      parseText(`class K { static const count = 3; static const flag = true; }`),
    );
    expect(consts['K.count']).toBeUndefined();
    expect(consts['K.flag']).toBeUndefined();
  });
});
