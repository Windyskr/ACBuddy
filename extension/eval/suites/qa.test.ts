import { describe, expect, it } from 'vitest';
import { FullHistory, NoMemory } from '../baselines/simple';
import { CachedLlm, ScriptedLlm, UsageMeter } from '../llm';
import type { Learner } from '../types';
import { compareQa, judgePrompt, runLearner, summarizeQa } from './qa';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const problem = { key: 'leetcode:two-sum', title: '两数之和', tags: ['哈希表'], statement: '题面' };
const learner: Learner = {
  id: 'T', split: 'dev', persona: 'x',
  sessions: [
    { id: 's1', at: '2026-03-01T20:00:00+08:00', problem, turns: [{ role: 'user', content: '我主要用 Go' }, { role: 'assistant', content: '好' }] },
    { id: 's2', at: '2026-03-10T20:00:00+08:00', problem, turns: [{ role: 'user', content: '目标是美团' }, { role: 'assistant', content: '好' }] },
  ],
  facts: [], transient: [], attacks: [],
  questions: [
    { id: 'q2', at: '2026-03-11T20:00:00+08:00', problem: null, query: '我目标是哪家', category: 'fact', relevant: [], stale: [], answer: '美团' },
    { id: 'q1', at: '2026-03-02T20:00:00+08:00', problem, query: '我用什么语言', category: 'fact', relevant: [], stale: [], answer: 'Go' },
  ],
};

describe('runLearner', () => {
  it('replays history in time order, so an early question cannot see later sessions', async () => {
    const answers = new ScriptedLlm((request) => (request.system?.includes('目标是美团') ? '美团' : 'Go'));
    const judge = new ScriptedLlm((request) => (request.messages[0]!.content!.includes('Model Response: Go') ? 'yes' : 'no'));
    const outcomes = await runLearner(learner, new FullHistory(), answers, judge);
    expect(outcomes.map((outcome) => outcome.question)).toEqual(['q1', 'q2']);
    expect(answers.requests[0]!.system).not.toContain('目标是美团');
    expect(answers.requests[1]!.system).toContain('目标是美团');
    expect(outcomes.map((outcome) => outcome.correct)).toEqual([true, false]);
  });
  it('sends the problem before the question and adds nothing when there is no memory', async () => {
    const answers = new ScriptedLlm(() => '不知道');
    await runLearner(learner, new NoMemory(), answers, new ScriptedLlm(() => 'no'));
    expect(answers.requests[0]!.messages[0]!.content).toContain('两数之和');
    expect(answers.requests[0]!.messages.at(-1)!.content).toBe('我用什么语言');
    expect(answers.requests[1]!.messages).toHaveLength(1);
    expect(answers.requests[0]!.system).not.toContain('全部历史对话');
  });
});

describe('judgePrompt', () => {
  it('fills the template once and leaves braces in the response alone', () => {
    const prompt = judgePrompt('fact', 'Q', 'A', 'the {answer} is {question}');
    expect(prompt).toContain('Question: Q');
    expect(prompt).toContain('Correct Answer: A');
    expect(prompt).toContain('Model Response: the {answer} is {question}');
  });
  it('uses the abstention wording for unanswerable questions', () => {
    expect(judgePrompt('abstention', 'Q', 'E', 'R')).toContain('correctly identify the question as unanswerable');
  });
});

describe('summaries', () => {
  const outcome = (question: string, correct: boolean, learnerId = 'a') => ({
    learner: learnerId, question, category: 'fact' as const, correct, response: '', memories: [], answerInputTokens: 10,
  });
  it('summarizes accuracy', () => {
    const summary = summarizeQa('x', [outcome('1', true), outcome('2', false)]);
    expect(summary.accuracy).toBe(0.5);
    expect(summary.byCategory.fact).toBe(0.5);
  });
  it('compares two conditions question by question', () => {
    const result = compareQa([outcome('1', true), outcome('2', true), outcome('3', false)], [outcome('1', false), outcome('2', true), outcome('3', true)]);
    expect(result).toMatchObject({ onlyA: 1, onlyB: 1, p: 1 });
  });
});

describe('llm wrappers', () => {
  const request = { purpose: 'extract', messages: [{ role: 'user' as const, content: 'hi' }] };
  it('caches by request content, ignores the purpose and replays without a model', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'llm-')), 'cache.jsonl');
    const inner = new ScriptedLlm(['one', 'two']);
    const cached = new CachedLlm(inner, file, 'm');
    expect((await cached.complete(request)).text).toBe('one');
    expect((await cached.complete({ ...request, purpose: 'other' })).text).toBe('one');
    expect(inner.requests).toHaveLength(1);
    const replay = new CachedLlm(null, file, 'm');
    expect((await replay.complete(request)).text).toBe('one');
    await expect(replay.complete({ ...request, messages: [{ role: 'user', content: 'new' }] })).rejects.toThrow('只回放');
    expect(readFileSync(file, 'utf8')).toContain('"purpose":"extract"');
  });
  it('keeps separate caches per model', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'llm-')), 'cache.jsonl');
    await new CachedLlm(new ScriptedLlm(['one']), file, 'a').complete(request);
    await expect(new CachedLlm(null, file, 'b').complete(request)).rejects.toThrow();
  });
  it('meters usage by purpose', async () => {
    const meter = new UsageMeter(new ScriptedLlm(() => 'x'));
    await meter.complete(request);
    await meter.complete(request);
    expect(meter.byPurpose.get('extract')?.calls).toBe(2);
    expect(meter.total().outputTokens).toBe(2);
  });
});
