// 知识点规范名取自力扣标签，提取记忆时模型只能从这张表里选，检索时题目标签和查询都先映射到这里。
// 别名只收常见说法，宁缺毋滥：错配比漏配更伤检索
const ALIASES: Record<string, string[]> = {
  数组: ['array'],
  字符串: ['string'],
  哈希表: ['hash table', 'hashmap', 'hash map', '哈希', '散列'],
  动态规划: ['dynamic programming', 'dp', '状态转移'],
  记忆化搜索: ['记忆化', 'memoization'],
  背包问题: ['背包', 'knapsack'],
  树形DP: ['树形 dp', '树形动规', 'tree dp'],
  数学: ['math'],
  深度优先搜索: ['depth-first search', 'dfs', '深搜'],
  广度优先搜索: ['breadth-first search', 'bfs', '广搜', '层序遍历'],
  排序: ['sorting', 'sort'],
  归并排序: ['merge sort', '归并'],
  快速选择: ['quickselect', '快速排序', '快排', 'quick sort'],
  树: ['tree'],
  二叉树: ['binary tree'],
  二叉搜索树: ['binary search tree', 'bst'],
  字典树: ['trie', '前缀树'],
  线段树: ['segment tree'],
  树状数组: ['binary indexed tree', 'fenwick'],
  双指针: ['two pointers', 'two pointer'],
  滑动窗口: ['sliding window'],
  二分查找: ['binary search', '二分'],
  栈: ['stack'],
  单调栈: ['monotonic stack'],
  队列: ['queue'],
  单调队列: ['monotonic queue'],
  堆: ['heap', 'priority queue', '优先队列'],
  贪心: ['greedy'],
  矩阵: ['matrix'],
  位运算: ['bit manipulation', '位操作', '异或'],
  位掩码: ['bitmask', '状压', '状态压缩'],
  链表: ['linked list'],
  设计: ['design'],
  回溯: ['backtracking', 'backtrack'],
  前缀和: ['prefix sum', '差分'],
  图: ['graph'],
  拓扑排序: ['topological sort'],
  最短路: ['shortest path', 'dijkstra', 'floyd', 'spfa', 'bellman-ford'],
  并查集: ['union find', 'union-find', 'dsu'],
  递归: ['recursion', '爆栈', 'stack overflow'],
  分治: ['divide and conquer'],
  模拟: ['simulation'],
  字符串匹配: ['string matching', 'kmp'],
  博弈: ['game theory'],
  枚举: ['enumeration', '暴力'],
  复杂度分析: ['时间复杂度', '空间复杂度', '复杂度', 'complexity', 'tle', '超时'],
  边界条件: ['边界', 'off-by-one', '越界', '下标'],
  整数溢出: ['溢出', 'overflow', 'long long'],
};

export const CONCEPTS = Object.keys(ALIASES);

// 按别名长度倒序匹配，「二叉搜索树」不会被「二叉树」「树」抢先。英文别名要求词边界，dp 不会匹配 adpcm
const MATCHERS = Object.entries(ALIASES)
  .flatMap(([concept, aliases]) => [concept, ...aliases].map((alias) => ({ concept, alias: alias.toLowerCase() })))
  .sort((x, y) => y.alias.length - x.alias.length)
  .map(({ concept, alias }) => ({
    concept,
    pattern: new RegExp(/^[\x00-\x7f]+$/.test(alias) ? `(?<![a-z0-9])${alias.replace(/[-\s]/g, '[-\\s]?')}(?![a-z0-9])` : alias.replace(/\s/g, '\\s*'), 'g'),
  }));

/** 找出文本提到的知识点。先匹配长别名并把它抠掉，「单调栈」只算单调栈，不再算栈 */
export function conceptsIn(text: string): string[] {
  let rest = text.normalize('NFKC').toLowerCase();
  const found = new Set<string>();
  for (const { concept, pattern } of MATCHERS) {
    rest = rest.replace(pattern, () => {
      found.add(concept);
      return ' ';
    });
  }
  return [...found];
}

/** 题目标签（平台原文）映射成规范名，表里没有的丢掉 */
export function normalizeConcepts(tags: string[]): string[] {
  return [...new Set(tags.flatMap(conceptsIn))];
}
