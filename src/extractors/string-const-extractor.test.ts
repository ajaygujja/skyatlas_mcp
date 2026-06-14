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

  it('ignores non-string initializers', () => {
    const consts = extractStringConsts(
      parseText(`class K { static const count = 3; static const flag = true; }`),
    );
    expect(consts['K.count']).toBeUndefined();
    expect(consts['K.flag']).toBeUndefined();
  });
});
