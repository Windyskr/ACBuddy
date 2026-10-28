export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface Problem {
  id: string;
  slug: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
}

export interface ProblemData {
  problems: Problem[];
}

export type SortKey = "id" | "difficulty" | "lastAttempt" | "mastery";
export type SortDir = "asc" | "desc";

export type ColumnKey = "difficulty" | "tags" | "recent" | "urgency" | "mastery" | "userTags";
export type TableColumnKey = "problem" | ColumnKey;
export type MasteryFilter = number[];

export interface Filters {
  keyword: string;
  difficulties: Difficulty[];
  mastery: MasteryFilter;
  latestResult: "" | "pass" | "fail" | "unattempted";
  tag: string;
  userTag: string;
}

export interface SortState {
  key: SortKey | null;
  dir: SortDir;
}

export interface ServerProgress {
  platform: string;
  slug: string;
  title: string | null;
  difficulty: string | null;
  done: boolean;
  mastery: number;
  urgency: number;
  tags: string[];
  note: string;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  totalTimeMs: number;
  attemptCount: number;
  lastResult: "pass" | "fail" | null;
}

export interface AuthUser {
  id: number;
  username: string;
}

export interface ProgressView {
  mastery: number;
  urgency: number;
  note: string;
  tags: string[];
  lastResult: "pass" | "fail" | null;
  lastAttemptAt: string | null;
  /** 已完成 = 有 AC 记录或掌握拉满；顶部统计和行内划线必须共用这一个值 */
  done: boolean;
}

export type ProgressViewMap = Record<string, ProgressView>;
