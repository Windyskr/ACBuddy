export interface Bm25Hit {
  id: string;
  score: number;
  /** 查询词里有多少（按 IDF 加权）在这条记录里出现，0–1。分数没有上限，判断「都不相关」要靠它 */
  coverage: number;
}

const k1 = 1.2;
const b = 0.75;
// 算覆盖度时按至少这么多条记录算 IDF。记录很少时，出现过的词 IDF 接近 0、没出现的词很高，比例就失真了
const COVERAGE_MIN_DOCS = 100;
const idfOf = (docCount: number, df: number) => Math.log(1 + (docCount - df + 0.5) / (df + 0.5));

/** Okapi BM25。记忆最多几百条，每次检索现建索引也只要几毫秒 */
export function bm25Search(docs: { id: string; tokens: string[] }[], queryTokens: string[]): Bm25Hit[] {
  const terms = [...new Set(queryTokens)];
  if (!docs.length || !terms.length) return [];
  const avgLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const frequencies = docs.map((doc) => {
    const counts = new Map<string, number>();
    for (const token of doc.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map(terms.map((term) => [term, frequencies.reduce((sum, counts) => sum + (counts.has(term) ? 1 : 0), 0)]));
  const coverageIdf = (term: string) => idfOf(Math.max(docs.length, COVERAGE_MIN_DOCS), documentFrequency.get(term)!);
  const totalWeight = terms.reduce((sum, term) => sum + coverageIdf(term), 0);
  const hits: Bm25Hit[] = [];
  docs.forEach((doc, index) => {
    const counts = frequencies[index]!;
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      matched += coverageIdf(term);
      score += idfOf(docs.length, documentFrequency.get(term)!) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.tokens.length / avgLength));
    }
    if (score > 0) hits.push({ id: doc.id, score, coverage: matched / totalWeight });
  });
  return hits.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
}
