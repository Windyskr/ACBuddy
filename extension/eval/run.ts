// 评测入口，用法见 eval/README.md。检索相关的命令不调用模型，结果完全确定
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACBUDDY_VARIANTS, AcbuddyMemory } from './baselines/acbuddy';
import { FullHistory, NoMemory } from './baselines/simple';
import { S09Memory } from './baselines/s09';
import { loadLearners, loadLearnersById, validateLearner } from './datasets/load';
import { llmFromEnv, UsageMeter } from './llm';
import { DEFAULT_GATE } from '../entrypoints/lib/memory/gate';
import { runExtraction, summarizeExtraction, type ExtractionOutcome } from './suites/extraction';
import { gateSuite, supportDistribution } from './suites/gate';
import { compareInjection, runInjection, summarizeInjection } from './suites/injection';
import { loadLongMemEval, sampleQuestions, sessionRetrieval, toLearner } from './suites/longmemeval';
import { compareQa, runLearner, summarizeQa, type QaOutcome } from './suites/qa';
import { buildEmbeddings, loadEmbeddings } from './embed/embed';
import { embeddingTexts, retrievalSuite, scaleSuite, tune, tuneSimilarity, type NoiseKind, type RetrievalRow } from './suites/retrieval';
import type { Llm } from '../entrypoints/lib/memory/types';
import type { MemorySystem } from './types';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, 'results');
const CACHE = path.join(ROOT, '.cache');
const LME_FILE = path.join(CACHE, 'longmemeval_s_cleaned.json');
// 模型配置放这个文件（eval/.cache 被 git 忽略），密钥不用出现在命令行和终端记录里。已经设了的环境变量优先
const ENV_FILE = path.join(CACHE, 'model.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const LME_SYSTEM = 'You are a helpful assistant. Answer the question using what you know about the user. If that information is not available, say you do not know. Answer in the language of the question.';

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] ?? fallback : fallback;
}
const percent = (value: number) => (Number.isNaN(value) ? '—' : `${(value * 100).toFixed(1)}%`);
const fixed = (value: number, digits = 3) => (Number.isNaN(value) ? '—' : value.toFixed(digits));

function table(headers: string[], rows: string[][]) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}
function save(name: string, data: unknown, markdown: string) {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, `${name}.md`), `${markdown}\n`);
  console.log(markdown);
}

function retrievalTable(rows: RetrievalRow[]) {
  return table(
    ['条件', 'Recall@5', '95% CI', 'MRR', 'nDCG@5', '过期命中率', '拒答率', '平均注入条数', '平均注入字数'],
    rows.map((row) => [
      row.name, percent(row.recall), `${percent(row.recallLow)}–${percent(row.recallHigh)}`, fixed(row.mrr), fixed(row.ndcg),
      percent(row.staleRate), percent(row.abstainRate), fixed(row.avgInjected, 1), fixed(row.avgChars, 0),
    ]),
  );
}

const CATEGORY_NAMES = { fact: '单点事实', multi_session: '跨对话', update: '事实更新', temporal: '时间相关', preference: '偏好', contextual: '隐式相关', abstention: '拒答' };

async function main() {
  const command = process.argv[2];
  const split = option('split', 'test') as 'dev' | 'test' | 'all';
  if (command === 'validate') {
    const only = option('only', '');
    const pool = only ? loadLearnersById(only.split(',')) : loadLearners('all');
    const errors = pool.flatMap(validateLearner);
    const questions = pool.flatMap((learner) => learner.questions);
    const count = (category: string) => questions.filter((question) => question.category === category).length;
    console.log(`${pool.length} 个学习者（开发集 ${pool.filter((learner) => learner.split === 'dev').length}，测试集 ${pool.filter((learner) => learner.split === 'test').length}）`);
    console.log(`${pool.reduce((sum, learner) => sum + learner.sessions.length, 0)} 段对话，${pool.reduce((sum, learner) => sum + learner.facts.length, 0)} 条事实，${questions.length} 个问题，${pool.reduce((sum, learner) => sum + learner.attacks.length, 0)} 条攻击样本`);
    console.log(Object.entries(CATEGORY_NAMES).map(([category, name]) => `${name} ${count(category)}`).join('，'));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else console.log('校验通过');
    return;
  }
  if (command === 'injection') {
    const meter = new UsageMeter(llmFromEnv(path.join(CACHE, 'model.jsonl')));
    const plain = await runInjection(meter, false);
    const fenced = await runInjection(meter, true);
    const plainSummary = summarizeInjection(plain);
    const fencedSummary = summarizeInjection(fenced);
    const compared = compareInjection(plain, fenced);
    const row = (name: string, summary: ReturnType<typeof summarizeInjection>) => [name, percent(summary.attackSuccess), percent(summary.byChannel.problem ?? Number.NaN), percent(summary.byChannel.code ?? Number.NaN), percent(summary.byChannel.judge ?? Number.NaN)];
    const markdown = [
      `# 提示注入（${plain.length} 条攻击，模型 ${process.env.EVAL_MODEL ?? '回放'}）`,
      table(['系统提示', '攻击成功率', '题面', '代码注释', '判题输出'], [row('现有声明', plainSummary), row('定界符加规则', fencedSummary)]),
      `逐条比较：只有现有声明被攻破 ${compared.onlyA} 条，只有定界符被攻破 ${compared.onlyB} 条，McNemar p=${fixed(compared.p, 4)}。`,
    ].join('\n\n');
    save('injection', { plain, fenced, plainSummary, fencedSummary, compared, usage: Object.fromEntries(meter.byPurpose) }, markdown);
    return;
  }
  if (command === 'lme-retrieval') {
    const questions = loadLongMemEval(option('file', LME_FILE));
    const rows = [
      { name: '只用用户的话', ...sessionRetrieval(questions, { userOnly: true }) },
      { name: '用户和助手的话', ...sessionRetrieval(questions, { userOnly: false }) },
    ];
    const types = Object.keys(rows[0]!.byType);
    const markdown = [
      `# LongMemEval 会话级检索（${rows[0]!.questions} 个可回答的问题）`,
      '原始对话上的 BM25，不经过记忆系统，不调用模型。用来校验分词和 BM25 在外部数据上工作正常。',
      table(['条件', 'Recall@5', ...types], rows.map((row) => [row.name, percent(row.recall), ...types.map((type) => percent(row.byType[type] ?? Number.NaN))])),
    ].join('\n\n');
    save('lme-retrieval', rows, markdown);
    return;
  }
  if (command === 'lme') {
    const names = option('conditions', 'none,s09,acbuddy').split(',');
    const questions = sampleQuestions(loadLongMemEval(option('file', LME_FILE)), Number(option('limit', '60')));
    const judgeLlm = llmFromEnv(path.join(CACHE, 'judge.jsonl'), process.env.EVAL_JUDGE_MODEL ? 'EVAL_JUDGE' : 'EVAL');
    const summaries = [];
    mkdirSync(RESULTS, { recursive: true });
    for (const name of names) {
      const meter = new UsageMeter(llmFromEnv(path.join(CACHE, 'lme-model.jsonl')));
      const outcomes: QaOutcome[] = [];
      for (const [index, question] of questions.entries()) {
        outcomes.push(...await runLearner(toLearner(question), createSystem(name, meter), meter, judgeLlm, LME_SYSTEM));
        console.error(`${name}: ${index + 1}/${questions.length}`);
      }
      // 官方判分脚本要的文件：python3 evaluate_qa.py gpt-4o <这个文件> <数据集文件>
      writeFileSync(path.join(RESULTS, `lme-${name}.hypotheses.jsonl`), outcomes.map((outcome) => JSON.stringify({ question_id: outcome.question, hypothesis: outcome.response })).join('\n'));
      summaries.push({ ...summarizeQa(name, outcomes), usage: Object.fromEntries(meter.byPurpose), total: meter.total() });
    }
    const categories = [...new Set(summaries.flatMap((summary) => Object.keys(summary.byCategory)))];
    const markdown = [
      `# LongMemEval 子集（S 版，分层抽样 ${questions.length} 题，答题模型 ${process.env.EVAL_MODEL ?? '回放'}）`,
      table(['条件', '准确率', '回答的平均输入 token', '全流程总 token', ...categories], summaries.map((summary) => [
        summary.name, percent(summary.accuracy), fixed(summary.answerInputTokens, 0), String(summary.total.inputTokens + summary.total.outputTokens),
        ...categories.map((category) => percent(summary.byCategory[category] ?? Number.NaN)),
      ])),
    ].join('\n\n');
    save('lme', summaries, markdown);
    return;
  }
  const learners = loadLearners(split);
  const pool = loadLearners('all');
  if (command === 'retrieval') {
    const distractors = Number(option('distractors', '0'));
    const noise = option('noise', 'episodic') as NoiseKind;
    const rows = retrievalSuite(learners, pool, distractors, noise, loadEmbeddings());
    const categories = [...new Set(rows.flatMap((row) => Object.keys(row.byCategory)))] as (keyof typeof CATEGORY_NAMES)[];
    const markdown = [
      `# 检索评测（${split}，${learners.length} 个学习者，${rows[0]?.questions ?? 0} 个问题，干扰记忆 ${distractors} 条，类型 ${noise}）`,
      '假设提取和更新完美：记忆库直接用标注好的事实。不调用模型，结果完全确定。',
      retrievalTable(rows),
      '## 各题型的 Recall@5',
      table(['条件', ...categories.map((category) => CATEGORY_NAMES[category])], rows.map((row) => [row.name, ...categories.map((category) => percent(row.byCategory[category] ?? Number.NaN))])),
    ].join('\n\n');
    save(`retrieval-${split}-d${distractors}${noise === 'all' ? '-all' : ''}`, rows, markdown);
    return;
  }
  if (command === 'embed') {
    console.log(await buildEmbeddings(embeddingTexts(pool)));
    return;
  }
  if (command === 'scale') {
    const sizes = option('sizes', '0,50,200,500').split(',').map(Number);
    const noise = option('noise', 'episodic') as NoiseKind;
    const rows = scaleSuite(learners, pool, sizes, noise);
    const markdown = [
      `# 记忆库规模（${split}，干扰类型 ${noise}）`,
      table(['干扰记忆条数', 'Recall@5', 'MRR', '拒答率', '过期命中率', '检索耗时 p95（毫秒）'], rows.map(({ size, row }) => [
        String(size), percent(row.recall), fixed(row.mrr), percent(row.abstainRate), percent(row.staleRate), fixed(row.p95ms, 2),
      ])),
    ].join('\n\n');
    save(`scale-${split}${noise === 'all' ? '-all' : ''}`, rows, markdown);
    return;
  }
  if (command === 'tune') {
    const best = tune(loadLearners('dev'), pool);
    for (const { score, config, row } of best) {
      console.log(`${score.toFixed(4)}  recall=${percent(row.recall)} abstain=${percent(row.abstainRate)} stale=${percent(row.staleRate)} chars=${fixed(row.avgChars, 0)} core=${config.coreSemantic} minCoverage=${config.minCoverage} weights=${JSON.stringify(config.weights)}`);
    }
    const embeddings = loadEmbeddings();
    if (embeddings) {
      for (const { minSimilarity, score, row } of tuneSimilarity(loadLearners('dev'), pool, embeddings, best[0]!.config)) {
        console.log(`向量门槛 ${minSimilarity}: ${score.toFixed(4)} recall=${percent(row.recall)} abstain=${percent(row.abstainRate)} chars=${fixed(row.avgChars, 0)}`);
      }
    }
    return;
  }
  if (command === 'gate') {
    const thresholds = option('thresholds', '0,0.1,0.15,0.2,0.25,0.3,0.4,0.5').split(',').map(Number);
    const rows = thresholds.map((minSupport) => gateSuite(learners, { ...DEFAULT_GATE, minSupport }));
    const noEvidence = gateSuite(learners, { ...DEFAULT_GATE, evidence: false });
    const distribution = supportDistribution(learners);
    const markdown = [
      `# 写入门禁（${split}，${learners.length} 个学习者）`,
      '最坏情况：假设提取模型已被攻破，把投毒内容当记忆输出。不调用模型，结果完全确定。',
      table(['证据支持度下限', '真实事实通过率', '伪造证据拦截率', '95% CI', '假原话拦截率'], [
        ['关闭证据校验', percent(noEvidence.goldAccepted), percent(noEvidence.forgedBlocked), '—', percent(noEvidence.fakeQuoteBlocked)],
        ...rows.map((row) => [String(row.minSupport), percent(row.goldAccepted), percent(row.forgedBlocked), `${percent(row.forgedBlockedLow)}–${percent(row.forgedBlockedHigh)}`, percent(row.fakeQuoteBlocked)]),
      ]),
      `支持度分布：真实事实 ${JSON.stringify(distribution.gold)}；投毒内容 ${JSON.stringify(distribution.attacks)}`,
    ].join('\n\n');
    save(`gate-${split}`, { rows, noEvidence, distribution }, markdown);
    return;
  }
  if (command === 'extraction') {
    const names = option('conditions', 's09,acbuddy').split(',');
    const limit = Number(option('limit', '0'));
    const selected = limit ? learners.slice(0, limit) : learners;
    const summaries = [];
    for (const name of names) {
      const meter = new UsageMeter(llmFromEnv(path.join(CACHE, 'model.jsonl')));
      const outcomes: ExtractionOutcome[] = [];
      for (const learner of selected) outcomes.push(await runExtraction(learner, createSystem(name, meter)));
      summaries.push({ ...summarizeExtraction(name, outcomes), usage: Object.fromEntries(meter.byPurpose), total: meter.total() });
    }
    const interval = (value: { mean: number; low: number; high: number }) => `${percent(value.mean)}（${percent(value.low)}–${percent(value.high)}）`;
    const markdown = [
      `# 提取评测（${split}，${selected.length} 个学习者）`,
      table(['条件', '事实召回率', '过期事实仍有效', '一次性内容被存', '投毒写入率', '平均存储条数', '总 token'], summaries.map((summary) => [
        summary.name, interval(summary.factRecall), interval(summary.staleActive), interval(summary.transientStored), interval(summary.attackWritten), fixed(summary.avgStored, 1), String(summary.total.inputTokens + summary.total.outputTokens),
      ])),
    ].join('\n\n');
    save(`extraction-${split}`, summaries, markdown);
    return;
  }
  if (command === 'qa') {
    const names = option('conditions', 'none,full-history,s09').split(',');
    const limit = Number(option('limit', '0'));
    const selected = limit ? learners.slice(0, limit) : learners;
    const judgeLlm = llmFromEnv(path.join(CACHE, 'judge.jsonl'), process.env.EVAL_JUDGE_MODEL ? 'EVAL_JUDGE' : 'EVAL');
    const summaries = [];
    const allOutcomes = new Map<string, QaOutcome[]>();
    for (const name of names) {
      const meter = new UsageMeter(llmFromEnv(path.join(CACHE, 'model.jsonl')));
      const outcomes: QaOutcome[] = [];
      for (const learner of selected) {
        const system = createSystem(name, meter);
        outcomes.push(...await runLearner(learner, system, meter, judgeLlm));
        console.error(`${name}: ${learner.id} 完成`);
      }
      allOutcomes.set(name, outcomes);
      const summary = summarizeQa(name, outcomes);
      summaries.push({ ...summary, usage: Object.fromEntries(meter.byPurpose), total: meter.total() });
    }
    const baselineName = names[0]!;
    const markdown = [
      `# 端到端问答（${split}，${selected.length} 个学习者）`,
      table(['条件', '准确率', '95% CI', `相对 ${baselineName} 的 p 值`, '回答的平均输入 token', '全流程总 token'], summaries.map((summary) => {
        const compared = compareQa(allOutcomes.get(summary.name)!, allOutcomes.get(baselineName)!);
        return [
          summary.name, percent(summary.accuracy), `${percent(summary.low)}–${percent(summary.high)}`,
          summary.name === baselineName ? '—' : fixed(compared.p, 4), fixed(summary.answerInputTokens, 0),
          String(summary.total.inputTokens + summary.total.outputTokens),
        ];
      })),
      '## 各题型准确率',
      table(['条件', ...Object.values(CATEGORY_NAMES)], summaries.map((summary) => [summary.name, ...Object.keys(CATEGORY_NAMES).map((category) => percent(summary.byCategory[category] ?? Number.NaN))])),
    ].join('\n\n');
    save(`qa-${split}`, { summaries, outcomes: Object.fromEntries(allOutcomes) }, markdown);
    return;
  }
  console.error('用法：tsx eval/run.ts <validate|retrieval|embed|scale|tune|gate|extraction|qa|injection|lme-retrieval|lme> [--only L02,L03] [--split dev|test|all] [--distractors N] [--noise episodic|all] [--sizes 0,50] [--conditions a,b] [--limit N]');
  process.exitCode = 1;
}

function createSystem(name: string, llm: Llm): MemorySystem {
  if (name === 'none') return new NoMemory();
  if (name === 'full-history') return new FullHistory();
  if (name === 's09') return new S09Memory(llm);
  if (name in ACBUDDY_VARIANTS) return new AcbuddyMemory(llm, name);
  throw new Error(`未知条件：${name}`);
}

await main();
