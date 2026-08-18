/**
 * Nearest-name suggestions for a lookup that found nothing.
 *
 * A miss and a match lead a caller to opposite next actions, so a miss has to
 * carry enough to act on: the names it was probably meant to be. Substring
 * matching alone cannot supply them — the common miss is a misremembered or
 * misspelled name (`HomeScren`, `FooBloc` for `FooCubit`), which shares most of
 * its characters with the right one but contains none of it as a run.
 *
 * Similarity is the Dice coefficient over character bigrams: the shared bigram
 * count against the total, which rewards names that agree in most of their
 * length and is indifferent to where they disagree. It is computed on lowercase
 * text, so case alone never separates a candidate from the query.
 */

/** Minimum similarity worth quoting back; below it, suggestions read as noise. */
const MIN_SIMILARITY = 0.45;

/** Suggestions returned unless a caller asks for a different number. */
const DEFAULT_LIMIT = 5;

/**
 * The candidate names closest to `query`, best first, ties broken
 * alphabetically so the same index always yields the same suggestions.
 *
 * `candidates` is the pool the answer had to come from — widget classes for a
 * widget lookup, Bloc classes for a Bloc lookup — because a suggestion outside
 * that pool would miss in exactly the same way as the original query.
 */
export function nearestNames(
  candidates: Iterable<string>,
  query: string,
  limit: number = DEFAULT_LIMIT,
): string[] {
  const target = bigrams(query.toLowerCase());
  if (target.size === 0) return [];

  const scored: { name: string; score: number }[] = [];
  for (const name of candidates) {
    const score = diceCoefficient(target, bigrams(name.toLowerCase()));
    if (score >= MIN_SIMILARITY) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * Character bigrams of `text`, counted — `aa` in `banana` occurs once, and a
 * repeated bigram in one name should only be matched as often as it repeats in
 * the other.
 */
function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const pair = text.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** Shared bigrams as a fraction of both names' bigrams: 1 identical, 0 disjoint. */
function diceCoefficient(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of a.values()) totalA += count;
  for (const [pair, count] of b) {
    totalB += count;
    shared += Math.min(count, a.get(pair) ?? 0);
  }
  return (2 * shared) / (totalA + totalB);
}
