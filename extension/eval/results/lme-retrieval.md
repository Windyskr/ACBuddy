# LongMemEval 会话级检索（470 个可回答的问题）

原始对话上的 BM25，不经过记忆系统，不调用模型。用来校验分词和 BM25 在外部数据上工作正常。

| 条件 | Recall@5 | single-session-user | multi-session | single-session-preference | temporal-reasoning | knowledge-update | single-session-assistant |
|---|---|---|---|---|---|---|---|
| 只用用户的话 | 90.3% | 100.0% | 85.8% | 76.7% | 86.2% | 98.6% | 94.6% |
| 用户和助手的话 | 91.5% | 100.0% | 84.5% | 86.7% | 87.7% | 97.9% | 100.0% |
