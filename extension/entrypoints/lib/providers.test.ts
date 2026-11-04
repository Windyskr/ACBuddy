import { describe, expect, it } from 'vitest';
import { apiTypeOfUrl, cacheLifetimeMs, vendorOf } from './providers';

describe('apiTypeOfUrl', () => {
  it('uses each official service its own interface', () => {
    expect(apiTypeOfUrl('https://api.deepseek.com')).toBe('chat-completions');
    expect(apiTypeOfUrl('https://api.openai.com/v1')).toBe('responses');
    expect(apiTypeOfUrl('https://api.anthropic.com')).toBe('anthropic');
    expect(apiTypeOfUrl('https://openrouter.ai/api/v1/')).toBe('chat-completions');
  });
  it('follows an address that names the endpoint', () => {
    expect(apiTypeOfUrl('https://relay.example.com/v1/responses')).toBe('responses');
    expect(apiTypeOfUrl('https://api.openai.com/v1/chat/completions')).toBe('chat-completions');
    expect(apiTypeOfUrl('https://relay.example.com/v1/messages')).toBe('anthropic');
    expect(apiTypeOfUrl('https://api.deepseek.com/anthropic')).toBe('anthropic');
    expect(apiTypeOfUrl('https://openrouter.ai/api/v1/responses')).toBe('responses');
  });
  it('falls back to Chat Completions for anything else', () => {
    expect(apiTypeOfUrl('https://relay.example.com/v1')).toBe('chat-completions');
    expect(apiTypeOfUrl('http://localhost:11434/v1')).toBe('chat-completions');
    expect(apiTypeOfUrl('不是地址')).toBe('chat-completions');
  });
});

describe('vendorOf', () => {
  it('knows the four services by their host only', () => {
    expect(vendorOf('https://api.deepseek.com/anthropic')).toBe('deepseek');
    expect(vendorOf('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(vendorOf('https://relay.example.com/v1')).toBeNull();
    expect(cacheLifetimeMs({ baseUrl: 'https://relay.example.com/v1', model: 'm', apiKey: '' })).toBeUndefined();
  });
});
