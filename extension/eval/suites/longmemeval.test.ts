import { describe, expect, it } from 'vitest';
import { categoryOf, isAbstention, parseLmeDate, sampleQuestions, sessionRetrieval, toLearner, type LmeQuestion } from './longmemeval';

const question = (id: string, type: string, extra: Partial<LmeQuestion> = {}): LmeQuestion => ({
  question_id: id, question_type: type, question: 'where did I buy my bike', question_date: '2023/05/30 (Tue) 10:00', answer: 'Portland',
  answer_session_ids: ['b'], haystack_session_ids: ['a', 'b'], haystack_dates: ['2023/05/20 (Sat) 02:21', '2023/05/10 (Wed) 09:00'],
  haystack_sessions: [
    [{ role: 'user', content: 'I love pasta recipes' }, { role: 'assistant', content: 'bike bike bike' }],
    [{ role: 'user', content: 'I bought my bike in Portland' }, { role: 'assistant', content: 'nice' }],
  ], ...extra,
});

describe('LongMemEval adapter', () => {
  it('parses the dates', () => {
    expect(parseLmeDate('2023/05/20 (Sat) 02:21')).toBe('2023-05-20T02:21:00.000Z');
    expect(() => parseLmeDate('昨天')).toThrow('日期格式不对');
  });
  it('maps question types to the judge categories', () => {
    expect(categoryOf(question('1_abs', 'multi-session'))).toBe('abstention');
    expect(isAbstention(question('1_abs', 'multi-session'))).toBe(true);
    expect(categoryOf(question('1', 'temporal-reasoning'))).toBe('temporal');
    expect(categoryOf(question('1', 'knowledge-update'))).toBe('update');
    expect(categoryOf(question('1', 'single-session-preference'))).toBe('preference');
    expect(categoryOf(question('1', 'multi-session'))).toBe('multi_session');
    expect(categoryOf(question('1', 'single-session-user'))).toBe('fact');
  });
  it('sorts sessions by time when converting', () => {
    const learner = toLearner(question('1', 'single-session-user'));
    expect(learner.sessions.map((session) => session.id)).toEqual(['b', 'a']);
    expect(learner.questions[0]).toMatchObject({ answer: 'Portland', problem: null, category: 'fact' });
  });
  it('samples evenly across types and reproducibly', () => {
    const all = ['x', 'y'].flatMap((type) => Array.from({ length: 10 }, (_, index) => question(`${type}${index}`, type)));
    const sample = sampleQuestions(all, 6);
    expect(sample.filter((item) => item.question_type === 'x')).toHaveLength(3);
    expect(sampleQuestions(all, 6)).toEqual(sample);
    expect(sampleQuestions(all, 100)).toHaveLength(20);
  });
  it('retrieves the evidence session, and leaves out assistant text when asked', () => {
    const result = sessionRetrieval([question('1', 'single-session-user')], { k: 1 });
    expect(result.recall).toBe(1);
    expect(result.byType['single-session-user']).toBe(1);
    const noisy = sessionRetrieval([question('1', 'single-session-user', { question: 'bike bike' })], { k: 1, userOnly: true });
    expect(noisy.recall).toBe(1);
  });
  it('skips abstention questions', () => {
    expect(sessionRetrieval([question('1_abs', 'multi-session')]).questions).toBe(0);
  });
});
