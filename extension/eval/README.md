# 记忆系统评测

设计和结论见 [`docs/memory-system.md`](../../docs/memory-system.md)。这里说明怎么复现。

## 不需要模型的部分

结果完全确定，CI 也跑。

```bash
npx tsx eval/run.ts validate                  # 校验数据集
npx tsx eval/run.ts retrieval --split test    # 检索消融：假设提取和更新完美，只看检索
npx tsx eval/run.ts scale --split test        # 记忆库变大时的召回率和耗时
npx tsx eval/run.ts gate --split test         # 写入门禁：假设提取模型已被攻破，代码层能挡住多少
npx tsx eval/run.ts tune                      # 在开发集上搜索检索参数，测试集不参与
npx tsx eval/run.ts lme-retrieval             # LongMemEval 原始对话上的 BM25（数据集放 eval/.cache/）
```

## 需要模型的部分

模型配置写在 `eval/.cache/model.env`（gitignored），也可以直接设环境变量。密钥不进代码、缓存和结果文件。请求和响应缓存在 `eval/.cache/`，同样的请求不会重复花钱。

```bash
# eval/.cache/model.env
EVAL_BASE_URL=https://服务地址/v1
EVAL_MODEL=模型名
EVAL_API_TYPE=chat-completions
EVAL_API_KEY=…
```

```bash
npx tsx eval/run.ts extraction --split test --conditions s09,acbuddy,acbuddy-no-gate-no-minimize
npx tsx eval/run.ts qa --split test --conditions none,full-history,s09,acbuddy,acbuddy-no-validity
npx tsx eval/run.ts injection
npx tsx eval/run.ts lme --limit 60 --conditions none,s09,acbuddy
```

判分可以用另一个模型：再设 `EVAL_JUDGE_BASE_URL`、`EVAL_JUDGE_API_KEY`、`EVAL_JUDGE_MODEL`、`EVAL_JUDGE_API_TYPE`。判分提示词照抄 LongMemEval 的 `evaluate_qa.py`。`lme` 还会生成 `results/lme-<条件>.hypotheses.jsonl`，可以直接喂给官方脚本，用它规定的 gpt-4o 判分。

## 目录

- `baselines/`：`s09.ts` 是 learn-claude-code s09 的移植（纯函数用原版生成的向量校验），`simple.ts` 是无记忆和全量历史，`acbuddy.ts` 是完整方案和它的消融版本。
- `datasets/tutormem/`：自建的模拟数据集，写作要求见它的 README。开发集用来调参，指标只报测试集。
- `suites/`：各项评测。
- `results/`：跑出来的结果，报告里的数字都从这里来。
- `embed/`：向量检索对照实验的依赖，很大，单独一个 `package.json`。
