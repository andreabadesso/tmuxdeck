export function fuzzyMatch(query: string, target: string): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return { match: true, score: 0, indices: [] };

  const indices: number[] = [];
  let qi = 0;
  let lastMatchIndex = -1;
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      // Consecutive matches score higher
      if (lastMatchIndex === ti - 1) {
        score += 2;
      } else {
        score += 1;
      }
      // Bonus for matching at start or after separator
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '-' || t[ti - 1] === ' ' || t[ti - 1] === ':') {
        score += 3;
      }
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return { match: false, score: 0, indices: [] };

  // Penalize long gaps between matches
  score -= (indices[indices.length - 1] - indices[0] - indices.length + 1) * 0.5;

  return { match: true, score, indices };
}
