import { describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../llm';
import type { DatasetSession } from '../types';
import {
  dialogueText, extractJsonArray, keywordMemorySelection, memorySlug, recentUserText, S09Memory, type S09Message, shouldStoreMemory,
  TEMPORARY_MEMORY_MARKERS, validateMemoryRecord,
} from './s09';
import vectors from './s09-vectors.json';

// 向量由原版 Python 代码生成（gen-s09-vectors.py），这里逐条比对，保证基线移植得和原版一致
describe('port matches the original Python', () => {
  it('memory_slug', () => {
    for (const [input, output] of vectors.slug as [string, string][]) expect(memorySlug(input)).toBe(output);
  });
  it('should_store_memory', () => {
    for (const [candidate, output] of vectors.shouldStore as [unknown, boolean][]) expect(shouldStoreMemory(candidate, vectors.existing)).toBe(output);
  });
  it('keyword_memory_selection', () => {
    for (const [query, output] of vectors.keyword as [string, string[]][]) expect(keywordMemorySelection(vectors.records, query, 2)).toEqual(output);
  });
  it('recent_user_text', () => {
    expect(recentUserText(vectors.messages as S09Message[])).toBe(vectors.recentUserText);
    expect(recentUserText(vectors.messages as S09Message[], 1)).toBe(vectors.recentUserTextOne);
  });
  it('dialogue_text', () => {
    expect(dialogueText(vectors.messages as S09Message[])).toBe(vectors.dialogueText);
    expect(dialogueText(vectors.messages as S09Message[], 2)).toBe(vectors.dialogueTextTwo);
  });
  it('extract_json_array', () => {
    for (const [text, output] of vectors.extractJsonArray as [string, unknown[]][]) expect(extractJsonArray(text)).toEqual(output);
  });
  it('validate_memory_record', () => {
    for (const [record, output] of vectors.validate as [unknown, unknown][]) expect(validateMemoryRecord(record, true)).toEqual(output);
    for (const [record, output] of vectors.validateNoScope as [unknown, unknown][]) expect(validateMemoryRecord(record)).toEqual(output);
  });
  it('temporary markers', () => {
    expect(TEMPORARY_MEMORY_MARKERS).toEqual(vectors.markers);
  });
});

const session: DatasetSession = {
  id: 's1', at: '2026-03-01T20:00:00+08:00',
  problem: { key: 'leetcode:two-sum', title: '两数之和', tags: ['哈希表'], statement: '题面' },
  turns: [
    { role: 'user', content: '我以后都用 Go 写题' },
    { role: 'assistant', content: '好的，我看看代码' },
    { role: 'tool', name: 'get_code', content: 'func twoSum() {}' },
    { role: 'assistant', content: '代码有问题' },
    { role: 'user', content: '谢谢' },
    { role: 'assistant', content: '不客气' },
  ],
};
const go = { name: 'lang', type: 'user', scope: 'persistent', description: '主要用 Go', body: '用户主要用 Go 写题' };

describe('S09Memory', () => {
  it('extracts once per finished agent turn and never sees tool output', async () => {
    const llm = new ScriptedLlm([JSON.stringify([go]), '[]']);
    const memory = new S09Memory(llm);
    await memory.ingest(session);
    expect(llm.requests.map((request) => request.purpose)).toEqual(['extract', 'extract']);
    expect(llm.requests[0]!.messages[0]!.content).toContain('user: 题目：两数之和');
    expect(llm.requests[1]!.messages[0]!.content).not.toContain('func twoSum');
    expect(memory.dump().map((item) => item.id)).toEqual(['lang.md']);
  });
  it('rejects temporary and current-task candidates', async () => {
    const llm = new ScriptedLlm([JSON.stringify([{ ...go, scope: 'current_task' }, { ...go, name: 'x', description: 'y', body: '暂时先用 Go' }]), '[]']);
    const memory = new S09Memory(llm);
    await memory.ingest(session);
    expect(memory.dump()).toEqual([]);
  });
  it('consolidates once the store reaches the threshold and keeps old records when the reply is bad', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...go, name: `m${i}`, description: `d${i}`, body: `b${i}` }));
    const good = new S09Memory(new ScriptedLlm([JSON.stringify(many), JSON.stringify([go]), '[]']));
    await good.ingest(session);
    expect(good.dump().map((item) => item.id)).toEqual(['lang.md']);
    const bad = new S09Memory(new ScriptedLlm([JSON.stringify(many), 'not json', '[]']));
    await bad.ingest(session);
    expect(bad.dump()).toHaveLength(10);
  });
  it('selects through the model, caps at five and loads the bodies', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...go, name: `m${i}`, description: `d${i}`, body: `b${i}` }));
    const llm = new ScriptedLlm([JSON.stringify(many), '[]', '[0, 1, 2, 3, 4, 5, 99, 0]']);
    const memory = new S09Memory(llm);
    await memory.ingest(session);
    const result = await memory.recall({ query: '问题', problem: null, now: 0 });
    expect(result.memories.map((item) => item.id)).toEqual(['m0.md', 'm1.md', 'm2.md', 'm3.md', 'm4.md']);
    expect(result.systemText).toContain('Memory catalog:\n- [m0](m0.md) - d0');
    expect(result.systemText).toContain('b4');
  });
  it('falls back to keywords when the model call fails', async () => {
    const llm = new ScriptedLlm([JSON.stringify([go]), '[]']);
    const memory = new S09Memory(llm);
    await memory.ingest(session);
    const result = await memory.recall({ query: 'lang 是什么', problem: null, now: 0 });
    expect(result.memories.map((item) => item.id)).toEqual(['lang.md']);
  });
});
