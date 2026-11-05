/** A text an item is matched on, and what a term found in it adds to the item's score. */
export interface SearchField { text: string; weight: number }

/**
 * The items that match `terms` (lowercase substrings of their fields), most relevant first: those that
 * match every term, else, for a query of several terms, those that match the most of them.
 */
export function rankByTerms<T>(items: readonly T[], terms: readonly string[], fields: (item: T) => SearchField[]): T[] {
  const strict = score(items, terms, fields, { requireAllTerms: true });
  if (strict.length > 0 || terms.length === 1) return strict.map(s => s.item);

  // A long natural-language query often mixes terms that belong to different items. Merge the partial
  // matches rather than return nothing, but when some items match several terms, drop those matching only
  // one, so that a broad term like "list" does not pull in everything.
  const partial = score(items, terms, fields, { requireAllTerms: false });
  const most = Math.max(0, ...partial.map(s => s.matchedTerms));
  const least = most > 1 ? 2 : 1;
  return partial.filter(s => s.matchedTerms >= least).map(s => s.item);
}

interface Scored<T> { item: T; score: number; matchedTerms: number }

function score<T>(items: readonly T[], terms: readonly string[], fields: (item: T) => SearchField[], opts: { requireAllTerms: boolean }): Scored<T>[] {
  return items.flatMap((item): Scored<T>[] => {
    const lowered = fields(item).map(field => ({ text: field.text.toLowerCase(), weight: field.weight }));
    let total = 0;
    let matchedTerms = 0;
    for (const term of terms) {
      const found = lowered.filter(field => field.text.includes(term));
      if (found.length === 0) {
        if (opts.requireAllTerms) return [];
        continue;
      }
      matchedTerms += 1;
      total += found.reduce((sum, field) => sum + field.weight, 0);
    }
    return matchedTerms > 0 ? [{ item, score: total, matchedTerms }] : [];
  }).toSorted((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score);
}
