// 力扣「运行」「提交」的判题结果。页面钩子整理后留在页面里，AI 调用 get_judge_result 时读取，不上传 ACBuddy

export interface JudgeCase {
  input?: string;
  expected?: string;
  output?: string;
  stdout?: string;
  passed?: boolean;
}

export interface JudgeRecord {
  slug: string;
  kind: 'run' | 'submit';
  status: string;
  language?: string;
  passed?: number;
  total?: number;
  runtime?: string;
  memory?: string;
  /** 编译或运行报错。不能叫 error：工具结果里带 error 字段会被当成工具执行失败 */
  errorMessage?: string;
  /** 运行：每个用例的输入、预期输出、实际输出和标准输出 */
  cases?: JudgeCase[];
  /** 运行的测试输入没法按用例拆开时，原样给出 */
  input?: string;
  /** 提交：第一个没通过的用例 */
  failedCase?: JudgeCase;
  /** 判题时的代码，只用来判断之后有没有改过，不交给 AI */
  code?: string;
}

/** 运行、提交请求体里的语言和代码，运行还带测试输入 */
export interface JudgeRequest {
  slug: string;
  lang?: string;
  code?: string;
  input?: string;
}

const TEXT_LIMIT = 2000;
const ERROR_LIMIT = 4000;
const CASE_LIMIT = 10;

const clip = (value: unknown, limit = TEXT_LIMIT) => {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}…（共 ${value.length} 个字符，已截断）` : value;
};
const count = (value: unknown) => (typeof value === 'number' ? value : undefined);
// 没跑出结果时力扣填 "N/A"
const metric = (value: unknown) => (typeof value === 'string' && value !== 'N/A' ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function judgeRecord(kind: 'run' | 'submit', request: JudgeRequest, j: Record<string, unknown>): JudgeRecord {
  const record: JudgeRecord = {
    slug: request.slug,
    kind,
    // 「运行」只要代码跑完就回 Accepted，答案对不对看 correct_answer
    status: kind === 'run' && j.status_msg === 'Accepted' && j.correct_answer === false ? 'Wrong Answer' : String(j.status_msg),
    language: typeof j.pretty_lang === 'string' ? j.pretty_lang : request.lang,
    passed: count(j.total_correct),
    total: count(j.total_testcases),
    runtime: metric(j.status_runtime),
    memory: metric(j.status_memory),
    errorMessage: clip(j.full_compile_error || j.compile_error || j.full_runtime_error || j.runtime_error, ERROR_LIMIT),
    code: request.code,
  };
  if (kind === 'submit') {
    const failed = { input: clip(j.last_testcase || j.input), expected: clip(j.expected_output), output: clip(j.code_output), stdout: clip(j.std_output) };
    if (j.status_msg !== 'Accepted' && Object.values(failed).some(Boolean)) record.failedCase = failed;
    return record;
  }
  // 「运行」的测试输入只在请求体里，每个用例占的行数相同；输出等列表按用例排列，末尾多一个空串
  const total = record.total ?? 0;
  if (total > 0) {
    const lines = request.input?.replace(/\n+$/, '').split('\n') ?? [];
    const per = lines.length % total === 0 ? lines.length / total : 0;
    const compare = typeof j.compare_result === 'string' ? j.compare_result : '';
    const outputs = list(j.code_answer), expected = list(j.expected_code_answer), stdout = list(j.std_output_list);
    record.cases = Array.from({ length: Math.min(total, CASE_LIMIT) }, (_, i) => ({
      input: per ? clip(lines.slice(i * per, (i + 1) * per).join('\n')) : undefined,
      expected: clip(expected[i]),
      output: clip(outputs[i]),
      stdout: clip(stdout[i]),
      passed: compare[i] === '1' ? true : compare[i] === '0' ? false : undefined,
    }));
    if (!per) record.input = clip(request.input);
  }
  return record;
}
