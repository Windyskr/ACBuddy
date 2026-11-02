export const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN);

export function recallAtK(retrieved: string[], relevant: string[], k: number) {
  if (!relevant.length) return Number.NaN;
  const top = new Set(retrieved.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

export function reciprocalRank(retrieved: string[], relevant: string[]) {
  const wanted = new Set(relevant);
  const index = retrieved.findIndex((id) => wanted.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function ndcgAtK(retrieved: string[], relevant: string[], k: number) {
  if (!relevant.length) return Number.NaN;
  const wanted = new Set(relevant);
  const dcg = retrieved.slice(0, k).reduce((sum, id, index) => sum + (wanted.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.length); index++) ideal += 1 / Math.log2(index + 2);
  return dcg / ideal;
}

export function precisionRecallF1(truePositive: number, falsePositive: number, falseNegative: number) {
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : Number.NaN;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : Number.NaN;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1: Number.isNaN(f1) ? Number.NaN : f1 };
}

export function percentile(values: number[], p: number) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]!;
}

/** 固定种子的随机数，结果才能复现（mulberry32） */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按学习者整群重抽样的 95% 置信区间。同一个学习者的问题彼此相关，
 * 按问题重抽样会把区间算得过窄。
 */
export function clusterBootstrap(groups: number[][], { rounds = 2000, seed = 42 } = {}) {
  const usable = groups.filter((group) => group.length);
  if (!usable.length) return { mean: Number.NaN, low: Number.NaN, high: Number.NaN };
  const random = seededRandom(seed);
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < usable.length; i++) {
      const group = usable[Math.floor(random() * usable.length)]!;
      for (const value of group) total += value;
      count += group.length;
    }
    samples.push(total / count);
  }
  return { mean: mean(usable.flat()), low: percentile(samples, 2.5), high: percentile(samples, 97.5) };
}

/** 配对比较的精确 McNemar 检验：b、c 是只有其中一方答对的题数，返回双侧 p 值 */
export function mcnemarExact(b: number, c: number) {
  const n = b + c;
  if (!n) return 1;
  let tail = 0;
  let term = 0.5 ** n;
  for (let k = 0; k <= Math.min(b, c); k++) {
    tail += term;
    term = term * (n - k) / (k + 1);
  }
  return Math.min(1, 2 * tail);
}
