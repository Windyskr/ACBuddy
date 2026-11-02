import { describe, expect, it } from 'vitest';
import { readModelStream, usageOf } from './agent-protocol';

const encoder = new TextEncoder();
function sse(chunks: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: object, extra: object = {}) => data({ choices: [{ delta: value }], ...extra });
async function read(response: Response, apiType: 'chat-completions' | 'responses') {
  const texts: string[] = [];
  let chunks = 0;
  const result = await readModelStream(response, apiType, performance.now(), { onText: (text) => texts.push(text), onChunk: () => { chunks++; } });
  return { result, texts, chunks };
}

describe('Chat Completions stream', () => {
  it('reports the text as it grows and keeps the usage from the last chunk', async () => {
    const { result, texts } = await read(sse([
      delta({ content: '你' }), delta({ content: '好' }),
      data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }), 'data: [DONE]\n\n',
    ]), 'chat-completions');
    expect(texts).toEqual(['你', '你好']);
    expect(result.reply).toEqual({ role: 'assistant', content: '你好' });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2, cachedTokens: 5 });
    expect(result.firstTokenMs).not.toBeNull();
  });
  it('joins tool call fragments, including several parallel calls', async () => {
    const { result } = await read(sse([
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'get_code', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'search_memory', arguments: '{"qu' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'ery":"go"}' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
      'data: [DONE]\n\n',
    ]), 'chat-completions');
    expect(result.reply.content).toBeNull();
    expect(result.reply.tool_calls).toEqual([
      { id: 'a', type: 'function', function: { name: 'get_code', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'search_memory', arguments: '{"query":"go"}' } },
    ]);
  });
  it('handles lines split across network chunks and multi-byte characters split across bytes', async () => {
    const line = encoder.encode(delta({ content: '二分' }));
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(line.slice(0, 20));
        controller.enqueue(line.slice(20));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    expect((await read(response, 'chat-completions')).result.reply.content).toBe('二分');
  });
  it('skips comments and malformed lines, and surfaces an error event', async () => {
    const { result } = await read(sse([': keep-alive\n\n', 'data: not json\n\n', delta({ content: 'ok' }), 'data: [DONE]\n\n']), 'chat-completions');
    expect(result.reply.content).toBe('ok');
    await expect(read(sse([data({ error: { message: '额度不足' } })]), 'chat-completions')).rejects.toThrow('额度不足');
  });
  it('counts every chunk for the idle timeout', async () => {
    const { chunks } = await read(sse([delta({ content: 'a' }), delta({ content: 'b' }), 'data: [DONE]\n\n']), 'chat-completions');
    expect(chunks).toBe(3);
  });
});

describe('Responses stream', () => {
  const completed = (output: unknown[], usage: object = { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }) =>
    data({ type: 'response.completed', response: { status: 'completed', output, usage } });
  it('streams text and takes the final message from the completed event', async () => {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }];
    const { result, texts } = await read(sse([
      data({ type: 'response.output_text.delta', delta: '你' }), data({ type: 'response.output_text.delta', delta: '好' }), completed(output),
    ]), 'responses');
    expect(texts).toEqual(['你', '你好']);
    expect(result.reply.content).toBe('你好');
    expect(result.reply.responsesOutput).toEqual(output);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4, cachedTokens: 3 });
  });
  it('returns tool calls from the completed event', async () => {
    const { result } = await read(sse([
      data({ type: 'response.function_call_arguments.delta', delta: '{}' }),
      completed([{ type: 'function_call', call_id: 'c', name: 'get_code', arguments: '{}' }]),
    ]), 'responses');
    expect(result.reply.tool_calls?.[0]?.function.name).toBe('get_code');
    expect(result.firstTokenMs).not.toBeNull();
  });
  it('reports incomplete and failed responses', async () => {
    await expect(read(sse([data({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } })]), 'responses')).rejects.toThrow('生成未完成');
    await expect(read(sse([data({ type: 'error', message: '服务出错' })]), 'responses')).rejects.toThrow('服务出错');
  });
  it('treats a stream that ends early as an error', async () => {
    await expect(read(sse([data({ type: 'response.output_text.delta', delta: '你' })]), 'responses')).rejects.toThrow('响应中断');
  });
});

describe('services that ignore stream: true', () => {
  it('parses a plain JSON response', async () => {
    const body = { choices: [{ message: { role: 'assistant', content: '好' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
    const { result, texts } = await read(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }), 'chat-completions');
    expect(result.reply.content).toBe('好');
    expect(result.usage.inputTokens).toBe(3);
    expect(result.firstTokenMs).toBeNull();
    expect(texts).toEqual([]);
  });
});

describe('usageOf', () => {
  it('is all zeros when the service reports nothing', () => {
    expect(usageOf({})).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(usageOf(null)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });
});
