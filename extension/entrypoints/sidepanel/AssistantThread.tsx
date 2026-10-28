import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
  useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike, type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps, type SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { toolLabels, type AgentMessage } from '../lib/agent';
import { ArrowDownIcon, CheckIcon, CopyIcon, SendIcon, StopIcon } from './icons';
import './assistant-thread.css';

for (const [name, language] of Object.entries({ javascript, typescript, cpp, c, python, java, go, rust, json, bash })) {
  PrismLight.registerLanguage(name, language);
}
PrismLight.alias('javascript', ['js']);
PrismLight.alias('typescript', ['ts']);
PrismLight.alias('python', ['py']);
function SyntaxHighlighter({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) {
  return <PrismLight PreTag={Pre} CodeTag={Code} language={language} style={oneDark}
    customStyle={{ background: '#1e2430', margin: 0, padding: '10px 12px', fontSize: '12px', lineHeight: 1.6, borderRadius: '0 0 8px 8px' }}>{code}</PrismLight>;
}

type ContentPart = Exclude<ThreadMessageLike['content'], string>[number];
function readJSON(text: string | null): unknown {
  try { return JSON.parse(text ?? 'null'); } catch { return text; }
}

function displayMessages(messages: AgentMessage[], conversationId: string, ids: WeakMap<AgentMessage, string>, running: boolean): ThreadMessageLike[] {
  const results = new Map(messages.filter((message) => message.role === 'tool')
    .map((message) => [message.tool_call_id, readJSON(message.content)]));
  const output: { id: string; role: 'user' | 'assistant'; content: ContentPart[] }[] = [];
  messages.forEach((message) => {
    if (message.kind === 'problem' || message.role === 'tool') return;
    let item = output.at(-1);
    if (message.role === 'user' || item?.role !== 'assistant') {
      let id = ids.get(message);
      if (!id) { id = `${conversationId}:${crypto.randomUUID()}`; ids.set(message, id); }
      item = { id, role: message.role, content: [] };
      output.push(item);
    }
    if (message.content) item.content.push({ type: 'text', text: message.content });
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      item.content.push({
        type: 'tool-call', toolCallId: call.id, toolName: call.function.name,
        argsText: call.function.arguments,
        ...(results.has(call.id) ? { result, isError: !!(result && typeof result === 'object' && 'error' in result) } : {}),
      });
    }
  });
  return output.map((message, index) => ({
    ...message,
    ...(message.role === 'assistant' ? { status: running && index === output.length - 1
      ? { type: 'running' as const } : { type: 'complete' as const, reason: 'stop' as const } } : {}),
  }));
}

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return <div className="aui-code-header">
    <span>{language || '代码'}</span>
    <button type="button" aria-label="复制代码" onClick={() => {
      void navigator.clipboard.writeText(code).then(() => setState('copied')).catch(() => setState('error'));
    }}>{state === 'copied' ? <><CheckIcon width={12} height={12} />已复制</> : state === 'error' ? '复制失败' : <><CopyIcon width={12} height={12} />复制</>}</button>
  </div>;
}

function MarkdownText() {
  return <MarkdownTextPrimitive className="aui-markdown" smooth={false} remarkPlugins={[remarkGfm, remarkMath, remarkCjkFriendly]}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', errorColor: '#b91c1c' }]]} skipHtml components={{
    SyntaxHighlighter, CodeHeader,
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    table: ({ node: _node, ...props }) => <div className="aui-table-scroll"><table {...props} /></div>,
  }} />;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  if ('error' in result) return String(result.error);
  if ('code' in result) return `${'language' in result ? `语言：${result.language}\n\n` : ''}${result.code}`;
  if ('highlighted' in result) return `已标记 ${result.highlighted} 处错误`;
  if ('cleared' in result) return '已清除错误标记';
  if ('attempts' in result && Array.isArray(result.attempts)) {
    const note = 'progress' in result && result.progress && typeof result.progress === 'object' && 'note' in result.progress ? result.progress.note : '';
    return [note ? `当前笔记：${note}` : '', ...result.attempts.map((attempt) =>
      `${attempt.createdAt} · ${attempt.result === 'pass' ? '通过' : '未通过'}${attempt.language ? ` · ${attempt.language}` : ''}${attempt.note ? `\n${attempt.note}` : ''}`,
    )].filter(Boolean).join('\n\n') || '还没有作答记录';
  }
  return JSON.stringify(result, null, 2);
}

function ToolCall({ toolName, result, isError, status }: ToolCallMessagePartProps) {
  const finished = result !== undefined;
  const stopped = !finished && status.type === 'incomplete';
  const label = isError ? '执行失败' : finished ? '已完成' : stopped ? '已停止' : '执行中';
  return <details className="aui-tool" data-state={isError ? 'error' : finished ? 'complete' : stopped ? 'stopped' : 'running'}>
    <summary><span className="aui-tool-dot" /><span>{toolLabels[toolName] ?? toolName}</span><small>{label}</small></summary>
    {finished && <pre>{resultText(result)}</pre>}
  </details>;
}

function UserMessage() {
  return <MessagePrimitive.Root className="aui-message aui-user-message">
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>;
}
function AssistantMessage() {
  return <MessagePrimitive.Root className="aui-message aui-assistant-message">
    <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolCall } }} />
    <ActionBarPrimitive.Root className="aui-actions" hideWhenRunning>
      <ActionBarPrimitive.Copy className="icon-button" aria-label="复制回答" title="复制回答">
        <CopyIcon className="aui-copy-idle" width={14} height={14} /><CheckIcon className="aui-copy-done" width={14} height={14} />
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>;
}

const SUGGESTIONS = [
  { label: '思路提示', prompt: '给我一点解题思路的提示，先不要给出完整代码。' },
  { label: '检查我的代码', prompt: '读取我当前的代码，指出其中的错误并高亮有问题的行。' },
  { label: '完整题解', prompt: '给出完整题解和可运行的代码，并分析时间和空间复杂度。' },
];

export interface Action { label: string; run(): void }

interface Props {
  conversationId: string;
  messages: AgentMessage[];
  isRunning: boolean;
  isLoading: boolean;
  canSend: boolean;
  hint: string;
  hintAction?: Action;
  initialDraft: string;
  activity: string;
  error: string;
  errorAction?: Action;
  onSend(text: string): Promise<void>;
  onCancel(): void;
  onDraftChange(text: string): void;
}
export default function AssistantThread(props: Props) {
  const { conversationId, messages, isRunning, isLoading, canSend, hint, hintAction, activity, error, errorAction, onSend, onCancel } = props;
  const ids = useRef(new WeakMap<AgentMessage, string>());
  const converted = useMemo(() => displayMessages(messages, conversationId, ids.current, isRunning), [messages, conversationId, isRunning]);
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    await onSend(text);
  }, [onSend]);
  const runtime = useExternalStoreRuntime({
    messages: converted, isRunning, isSendDisabled: !canSend || isLoading,
    convertMessage: (message: ThreadMessageLike) => message,
    onNew, onCancel: async () => { onCancel(); },
  });
  const initialDraft = useRef(props.initialDraft);
  const input = useRef<HTMLTextAreaElement>(null);
  const draftChange = useRef(props.onDraftChange);
  draftChange.current = props.onDraftChange;
  useEffect(() => {
    const composer = runtime.thread.composer;
    composer.setText(initialDraft.current);
    const unsubscribe = composer.subscribe(() => draftChange.current(composer.getState().text));
    const frame = requestAnimationFrame(() => {
      if (initialDraft.current && document.activeElement === document.body && input.current) {
        input.current.focus({ preventScroll: true });
        input.current.setSelectionRange(input.current.value.length, input.current.value.length);
      }
    });
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, [runtime]);
  const problem = messages.find((message) => message.kind === 'problem');
  const suggest = (prompt: string) => {
    const composer = runtime.thread.composer;
    composer.setText(prompt);
    if (canSend && !isLoading && !isRunning) composer.send();
    else input.current?.focus();
  };
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="aui-thread" aria-label="聊天区域">
      <div className="aui-stage">
        <ThreadPrimitive.Viewport className="aui-viewport">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {!converted.length && !isLoading && <div className="aui-empty">
            {problem ? <>
              <p>问思路、要题解，或让 AI 检查当前代码</p>
              {canSend && <div className="aui-suggestions">
                {SUGGESTIONS.map((item) => <button key={item.label} type="button" disabled={isRunning} onClick={() => suggest(item.prompt)}>{item.label}</button>)}
              </div>}
            </> : <p>打开力扣题目，或在对话记录中选择对话</p>}
          </div>}
          {activity && <p className="aui-status" role="status"><span className="aui-status-dot" />{activity}</p>}
          {error && <p className="aui-error" role="alert"><span>{error}</span>
            {errorAction && <button type="button" className="link-button" onClick={errorAction.run}>{errorAction.label}</button>}</p>}
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom className="aui-scroll-bottom" aria-label="回到最新消息" title="回到最新消息"><ArrowDownIcon /></ThreadPrimitive.ScrollToBottom>
      </div>
      <ComposerPrimitive.Root className="aui-composer">
        {hint && <p className="aui-composer-hint" role="status"><span>{hint}</span>
          {hintAction && <button type="button" className="link-button" onClick={hintAction.run}>{hintAction.label}</button>}</p>}
        <div className="aui-composer-box">
          <ComposerPrimitive.Input ref={input} className="aui-input" aria-label="向 AI 提问" placeholder="询问思路，或让 AI 检查当前代码…"
            minRows={1} maxRows={8} maxLength={12000} submitMode="enter" disabled={isRunning} />
          {isRunning
            ? <ComposerPrimitive.Cancel className="aui-send aui-stop" aria-label="停止回答" title="停止回答"><StopIcon /></ComposerPrimitive.Cancel>
            : <ComposerPrimitive.Send className="aui-send" aria-label="发送" title="发送（Enter，Shift + Enter 换行）"><SendIcon /></ComposerPrimitive.Send>}
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
