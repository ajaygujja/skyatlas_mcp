import { describe, expect, it } from 'vitest';
import { nearestNames } from './nearest.js';

/**
 * Suggestions exist so a miss costs one call instead of a search, which only
 * holds if they answer the miss a caller actually makes — a misremembered or
 * misspelled name — and if they stay quiet when nothing in the pool fits.
 */
describe('nearestNames', () => {
  const pool = ['FormPlayerBloc', 'FormPlayerCubit', 'FormScreen', 'SettingsScreen', 'UserBloc'];

  it('suggests a name the query misspells, which a substring match cannot find', () => {
    expect(nearestNames(pool, 'FormPlyaerBloc')).toContain('FormPlayerBloc');
    expect(nearestNames(pool, 'SettignsScreen')).toContain('SettingsScreen');
  });

  it('ranks the closest name first', () => {
    expect(nearestNames(pool, 'FormPlayerCubi')[0]).toBe('FormPlayerCubit');
  });

  it('ignores case, so case alone never excludes a candidate', () => {
    expect(nearestNames(pool, 'userbloc')[0]).toBe('UserBloc');
  });

  it('suggests nothing when no candidate is close enough to act on', () => {
    expect(nearestNames(pool, 'PaymentGateway')).toEqual([]);
  });

  it('breaks equal scores alphabetically, so one index always suggests the same names', () => {
    // Both differ from the query by their first bigram alone, so they score alike.
    expect(nearestNames(['YBloc', 'XBloc'], 'ZBloc')).toEqual(['XBloc', 'YBloc']);
  });

  it('honours the requested count', () => {
    expect(nearestNames(pool, 'FormPlayerBloc', 1)).toEqual(['FormPlayerBloc']);
  });

  it('returns nothing for a query too short to have bigrams', () => {
    expect(nearestNames(pool, 'F')).toEqual([]);
  });
});
