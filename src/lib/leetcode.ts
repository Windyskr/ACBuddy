import type { Problem } from "../types";

export type LeetCodeSite = "leetcode.cn" | "leetcode.com";
export const LEETCODE_SITE_LABEL: Record<LeetCodeSite, string> = {
  "leetcode.cn": "国内版",
  "leetcode.com": "国际版",
};

export function problemUrl(problem: Pick<Problem, "id" | "slug">, site: LeetCodeSite): string {
  const host = /^\d+$/.test(problem.id) ? site : "leetcode.cn";
  return `https://${host}/problems/${problem.slug}/`;
}

const VERDICT_LABEL: Record<string, string> = {
  Accepted: "通过",
  "Wrong Answer": "解答错误",
  "Time Limit Exceeded": "超出时间限制",
  "Memory Limit Exceeded": "超出内存限制",
  "Output Limit Exceeded": "超出输出限制",
  "Runtime Error": "执行出错",
  "Compile Error": "编译出错",
  "Internal Error": "内部出错",
};
export const verdictLabel = (verdict: string): string => VERDICT_LABEL[verdict] ?? verdict;
