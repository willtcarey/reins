/**
 * Fuzzy match: checks if all characters in `query` appear in `text` in order
 * (case-insensitive). Returns a score where lower is better (tighter match),
 * or null if no match.
 *
 * Score = total distance spanned by the match minus the query length,
 * plus a penalty for each gap between consecutive matched characters.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  let qi = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  let gaps = 0;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatchIndex === -1) firstMatchIndex = ti;
      if (prevMatchIndex !== -1 && ti - prevMatchIndex > 1) {
        gaps += ti - prevMatchIndex - 1;
      }
      prevMatchIndex = ti;
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return null;

  // Score: span of the match + gaps penalty. Lower is better.
  const span = lastMatchIndex - firstMatchIndex + 1;
  return span - q.length + gaps;
}
