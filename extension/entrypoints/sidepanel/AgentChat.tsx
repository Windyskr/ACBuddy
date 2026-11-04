import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageNotSentError } from '@assistant-ui/react';
import { completedMessages, endpointFor, runAgent, SETTINGS_KEY, type AgentMessage, type AgentSettings, type Effort, type MemoryAccess } from '../lib/agent';
import { dropStaleReasoning, trimHistory, TRIM_MIN_TOKENS } from '../lib/context';
import { apiTypeOfUrl, cacheLifetimeMs, PROVIDERS, vendorOf } from '../lib/providers';
import type { ApiType } from '../lib/agent-protocol';
import { RefusalError } from '../lib/protocol-common';
import {
  CATALOG_KEY, createConversation, deleteConversation, getConversationCatalog,
  openProblemConversation, readConversation, saveConversation, selectConversation,
  type Conversation, type ConversationCatalog,
} from '../lib/agent-conversation';
import { openSite } from '../lib/api';
import { extractConversation, forgetConversationProgress, hasNewTurns, MEMORY_ENABLED_KEY, problemTags, recallMemories, searchMemories, syncIfStale, syncMemories } from '../lib/memory/service';
import { problemOf, type ProblemRef } from '../lib/platforms';
import AssistantThread, { type Action } from './AssistantThread';
import MemorySheet from './MemorySheet';
import Sheet from './Sheet';
import { DockIcon, ExternalLinkIcon, FloatIcon, HistoryIcon, MemoryIcon, MinimizeIcon, PlusIcon, SettingsIcon, TrashIcon } from './icons';
import { floatTab, headerDrag, isFloat, postToPage, viewedTab } from './float';
import { DISPLAY_KEY, FLOAT_SHOW } from '../lib/display';

const emptySettings: AgentSettings = { baseUrl: '', model: '', apiKey: '' };
const API_LABELS: Record<ApiType, string> = { responses: 'Responses', 'chat-completions': 'Chat Completions', anthropic: 'Anthropic Messages' };
type Target = { tabId: number; problem: ProblemRef };
// 进行中的回答按对话记下：切到别的标签页或对话时在后台继续、照常保存，切回这个对话时接着显示。
// done 之后留到最后一次保存写完，免得这期间打开对话读到旧记录
type Run = {
  abort: AbortController; messages: AgentMessage[]; activity: string; done: boolean;
  /** 模型正在生成的这段文字，生成完才进 messages */
  streaming: AgentMessage | null;
};
// 对话闲置这么久后提取记忆；切到别的对话时马上提取
const EXTRACT_IDLE_MS = 2 * 60_000;
const CATCH_UP_DAYS = 7;
const CATCH_UP_LIMIT = 5;
const SYNC_ON_FOCUS_AFTER_MS = 5 * 60_000;
const MEMORY_NOTICE_KEY = 'acb-memory-notice-seen';

const timeLabel = (value: number) => {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', date.getFullYear() === now.getFullYear()
    ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
};

export default function AgentChat({ problemKey, account, header }: { problemKey: string | null; account: string | null | undefined; header: ReactNode }) {
  const [settings, setSettings] = useState<AgentSettings>(emptySettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [draft, setDraft] = useState<AgentSettings>(emptySettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryNotice, setMemoryNotice] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [catalog, setCatalog] = useState<ConversationCatalog>({ conversations: [], selected: {} });
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在进行的回答有几个（各个对话加起来）。回答在这个页面里跑，换显示方式会关掉页面，有回答时不让换 */
  const [running, setRunning] = useState(0);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [settingsStatus, setSettingsStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const runs = useRef(new Map<string, Run>());
  // 后台回答出错时对话不在显示，错误留到打开这个对话时再显示
  const failures = useRef(new Map<string, string>());
  const history = useRef<AgentMessage[]>([]);
  const composerDraft = useRef('');
  const selectedRef = useRef<Conversation | null>(null);
  const targetRef = useRef<Target | null>(null);
  const mounted = useRef(true);
  const version = useRef(0);
  const targetQuery = useRef(0);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  // 提取在后台进行，读这两个 ref 拿到最新的设置
  const settingsRef = useRef<AgentSettings>(emptySettings);
  const memoryEnabledRef = useRef(true);
  const extractTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const extractAbort = useRef(new AbortController());

  const extractNow = useCallback(async (id: string) => {
    const pending = extractTimers.current.get(id);
    if (pending) clearTimeout(pending);
    extractTimers.current.delete(id);
    const model = settingsRef.current;
    if (!memoryEnabledRef.current || !model.baseUrl || !model.model) return;
    const running = runs.current.get(id);
    if (running && !running.done) return;
    try {
      await pendingSave.current;
      const record = await readConversation(id);
      if (record && await hasNewTurns(record)) await extractConversation(record, model, extractAbort.current.signal);
    } catch (reason) {
      // 进度没动，下次再试；记忆失败不打扰正常对话
      console.warn('[memory] 提取失败', reason);
    }
  }, []);
  const scheduleExtract = useCallback((id: string) => {
    const pending = extractTimers.current.get(id);
    if (pending) clearTimeout(pending);
    extractTimers.current.set(id, setTimeout(() => void extractNow(id), EXTRACT_IDLE_MS));
  }, [extractNow]);

  const beginView = useCallback(() => {
    const ticket = ++version.current;
    const leaving = selectedRef.current?.id;
    if (leaving && extractTimers.current.has(leaving)) void extractNow(leaving);
    if (selectedRef.current) composerDraft.current = '';
    selectedRef.current = null; history.current = [];
    setConversation(null); setMessages([]); setError('');
    setBusy(false); setLoading(true); setActivity('正在加载对话…');
    return ticket;
  }, [extractNow]);

  const openView = useCallback(async (load: () => Promise<Conversation | null>) => {
    const ticket = beginView();
    try {
      await pendingSave.current;
      if (!mounted.current || ticket !== version.current) return;
      const record = await load();
      if (!mounted.current || ticket !== version.current) return;
      const run = record ? runs.current.get(record.id) : undefined;
      const running = !!run && !run.done;
      selectedRef.current = record; history.current = run?.messages ?? record?.messages ?? [];
      setConversation(record); setMessages(run?.streaming ? [...history.current, run.streaming] : history.current);
      setBusy(running); setActivity(running ? run.activity : '');
      const failure = record && failures.current.get(record.id);
      if (failure) { failures.current.delete(record.id); setError(failure); }
    } catch (reason) {
      if (mounted.current && ticket === version.current) { setError(reason instanceof Error ? reason.message : '加载对话失败'); setActivity(''); }
    } finally {
      if (mounted.current && ticket === version.current) setLoading(false);
    }
  }, [beginView]);

  useEffect(() => {
    mounted.current = true;
    let catalogChanged = false;
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[CATALOG_KEY]) return;
      const next = changes[CATALOG_KEY].newValue as ConversationCatalog | undefined;
      catalogChanged = true;
      const value = next ?? { conversations: [], selected: {} };
      setCatalog(value);
      // 对话删掉了（包括在别的窗口删的），停掉它的回答
      for (const [id, run] of runs.current) if (!value.conversations.some((item) => item.id === id)) run.abort.abort();
      if (selectedRef.current && !value.conversations.some((item) => item.id === selectedRef.current?.id)) {
        beginView(); setLoading(false); setActivity('');
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    void (async () => {
      try {
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        const [data, savedCatalog] = await Promise.all([chrome.storage.local.get([SETTINGS_KEY, MEMORY_ENABLED_KEY, MEMORY_NOTICE_KEY]), getConversationCatalog()]);
        if (!mounted.current) return;
        const saved = data[SETTINGS_KEY] as AgentSettings | undefined;
        if (saved) { setSettings(saved); setDraft(saved); settingsRef.current = saved; }
        const enabled = data[MEMORY_ENABLED_KEY] !== false;
        setMemoryEnabled(enabled); memoryEnabledRef.current = enabled;
        setMemoryNotice(enabled && !data[MEMORY_NOTICE_KEY]);
        setSettingsLoaded(true);
        if (!catalogChanged) setCatalog(savedCatalog);
        // 上次关闭面板时可能还有没提取的对话，补上最近的几个
        const recent = savedCatalog.conversations.filter((item) => Date.now() - item.updatedAt < CATCH_UP_DAYS * 86_400_000).slice(0, CATCH_UP_LIMIT);
        for (const item of recent) {
          if (!mounted.current) return;
          await extractNow(item.id);
        }
      } catch { if (mounted.current) setError('读取本机设置或对话列表失败'); }
    })();
    return () => {
      mounted.current = false; ++version.current; ++targetQuery.current;
      for (const run of runs.current.values()) run.abort.abort();
      for (const timer of extractTimers.current.values()) clearTimeout(timer);
      extractAbort.current.abort();
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [beginView, extractNow]);

  const syncTarget = useCallback(async () => {
    const query = ++targetQuery.current;
    try {
      const tab = await viewedTab();
      if (!mounted.current || query !== targetQuery.current) return;
      const problem = problemOf(tab?.url);
      const next: Target | null = tab?.id != null && problem ? { tabId: tab.id, problem } : null;
      if (targetRef.current?.tabId === next?.tabId && targetRef.current?.problem.key === next?.problem.key) return;
      targetRef.current = next; setTarget(next);
      if (next) await openView(() => openProblemConversation(next.tabId, next.problem));
      else if (!selectedRef.current) {
        // 离开题目页面：作废还在加载的对话；已经打开的对话留着，回答照常进行
        ++version.current; setLoading(false); setActivity('');
      }
    } catch (reason) {
      if (mounted.current && query === targetQuery.current) setError(reason instanceof Error ? reason.message : '读取当前题目失败');
    }
  }, [openView]);

  useEffect(() => {
    // LeetCode's replaceState within a problem (Run, panel switches) also fires 'loading'; syncTarget only aborts on a tab/problem change.
    const onActivated = () => void syncTarget();
    const onUpdated = (_tabId: number, change: { url?: string; status?: string }) => {
      if (change.url || change.status === 'loading') void syncTarget();
    };
    const onBackground = (message: { type?: string }) => { if (message.type === 'PROBLEM_CHANGED') void syncTarget(); };
    // 悬浮窗只管自己所在的标签页，换标签页不用管
    if (!isFloat) chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onBackground);
    window.addEventListener('focus', syncTarget);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onBackground);
      window.removeEventListener('focus', syncTarget);
    };
  }, [syncTarget]);
  useEffect(() => { void syncTarget(); }, [problemKey, syncTarget]);

  // 打开面板、登录、退出、换账号时同步记忆；切回面板时，隔一段时间同步一次
  useEffect(() => { if (account !== undefined) void syncMemories(); }, [account]);
  useEffect(() => {
    const onFocus = () => void syncIfStale(SYNC_ON_FOCUS_AFTER_MS);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const persist = (id: string, value: AgentMessage[]) => {
    pendingSave.current = pendingSave.current.catch(() => {}).then(() => saveConversation(id, value)).catch(() => {
      if (mounted.current && selectedRef.current?.id === id) setError('对话保存失败，请检查浏览器的可用存储空间');
    });
  };
  const choose = (id: string) => {
    if (selectedRef.current?.id === id || loading) return;
    void openView(() => selectConversation(id));
  };
  const newConversation = () => {
    if (!target || loading) return;
    void openView(() => createConversation(target.tabId, target.problem));
  };
  const remove = (id: string) => {
    if (loading) return;
    const old = selectedRef.current;
    if (old?.id === id) {
      void forgetConversationProgress(id);
      void openView(async () => {
        const next = await deleteConversation(id);
        const replacement = next.conversations.find((item) => item.key === old.key) ?? next.conversations[0];
        return replacement ? selectConversation(replacement.id) : null;
      });
    } else {
      void deleteConversation(id).catch((reason) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '删除对话失败'); });
      void forgetConversationProgress(id);
    }
  };

  const saveSettings = async () => {
    setSettingsStatus('');
    try {
      if (!draft.baseUrl.trim()) throw new Error('请填写 API 地址');
      const endpoint = endpointFor(draft.baseUrl, apiTypeOfUrl(draft.baseUrl));
      if (!draft.model.trim()) throw new Error('请填写模型');
      const permission = chrome.permissions.request({ origins: [`${endpoint.protocol}//${endpoint.hostname}/*`] });
      setSaving(true);
      if (!await permission) throw new Error('需要允许访问该 API 地址才能调用模型');
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      // 思考强度只给推荐的服务设：别的服务不一定认这些参数，发了可能报错
      const effort = draftPreset ? draft.effort : undefined;
      const next: AgentSettings = { baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), model: draft.model.trim(), apiKey: draft.apiKey.trim(), ...(effort ? { effort } : {}) };
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      setSettings(next); setDraft(next); setShowSettings(false); settingsRef.current = next;
    } catch (reason) { setSettingsStatus(reason instanceof Error ? reason.message : '保存设置失败'); }
    finally { setSaving(false); }
  };
  // 收起时外面的圆钮要知道有没有正在进行的回答
  useEffect(() => { postToPage({ action: 'status', busy: running > 0 }); }, [running]);
  const toFloat = async () => {
    await chrome.storage.local.set({ [DISPLAY_KEY]: 'float' });
    if (target) await chrome.runtime.sendMessage({ type: FLOAT_SHOW, tabId: target.tabId }).catch(() => {});
    window.close();
  };
  const ownTab = useRef<number | null>(null);
  useEffect(() => { if (isFloat) void floatTab().then((tab) => { ownTab.current = tab?.id ?? null; }); }, []);
  const toSidePanel = () => {
    // 打开侧边栏必须在点击的同一刻调用，不能先等别的
    if (ownTab.current != null) void chrome.sidePanel.open({ tabId: ownTab.current }).catch(() => {});
    void chrome.storage.local.set({ [DISPLAY_KEY]: 'sidepanel' });
  };
  const openSettings = () => {
    setDraft(settings);
    setSettingsStatus(''); setShowSettings(true);
  };
  const toggleMemory = (next: boolean) => {
    setMemoryEnabled(next); memoryEnabledRef.current = next;
    void chrome.storage.local.set({ [MEMORY_ENABLED_KEY]: next });
  };
  const dismissMemoryNotice = () => {
    setMemoryNotice(false);
    void chrome.storage.local.set({ [MEMORY_NOTICE_KEY]: true });
  };

  const canSend = !!conversation && !!target && conversation.key === target.problem.key && !loading && history.current[0]?.kind === 'problem';
  let hint = '';
  let hintAction: Action | undefined;
  if (loading) hint = '正在加载对话，可以先输入草稿。';
  else if (!conversation) hint = target ? '选择或新建对话后可以发送。' : '打开题目页面后可以提问。';
  else if (!target || conversation.key !== target.problem.key) {
    const { problemUrl } = conversation;
    hint = `这是「${conversation.problemTitle}」的对话，打开该题后可以继续提问。`;
    hintAction = { label: '打开题目', run: () => void chrome.tabs.create({ url: problemUrl }) };
  } else if (history.current[0]?.kind !== 'problem') hint = '题目信息尚未加载完成，可以先输入草稿。';
  else if (settingsLoaded && (!settings.baseUrl || !settings.model)) {
    hint = '配置 AI 模型后即可提问。';
    hintAction = { label: '去设置', run: openSettings };
  }
  const send = async (text: string) => {
    if (busy || !canSend || !target || !conversation || !text.trim()) throw new MessageNotSentError('当前对话暂时无法发送');
    if (!settings.baseUrl || !settings.model) {
      openSettings();
      throw new MessageNotSentError('请先配置模型服务');
    }
    const id = conversation.id;
    const question: AgentMessage = { role: 'user', content: text.trim() };
    // 旧工具结果攒够了才一次裁掉，裁过的记在消息上（见 lib/context.ts）
    let next: AgentMessage[] = trimHistory([...completedMessages(history.current), question], Date.now(), TRIM_MIN_TOKENS, cacheLifetimeMs(settings));
    // 发给模型的内容由上下文压缩控制，这里只防止单个对话把本机存储占满
    if (JSON.stringify(next).length > 1_000_000) {
      setError('对话内容过长，请新建对话后继续提问');
      throw new MessageNotSentError('对话内容过长');
    }
    const run: Run = { abort: new AbortController(), messages: next, activity: '正在思考…', done: false, streaming: null };
    const { signal } = run.abort;
    runs.current.set(id, run); failures.current.delete(id);
    setRunning((count) => count + 1);
    history.current = next; setMessages(next);
    setBusy(true); setError(''); setActivity(run.activity);
    const showing = () => mounted.current && selectedRef.current?.id === id;
    const show = (activity: string) => {
      run.activity = activity;
      if (showing()) { history.current = run.messages; setMessages(run.streaming ? [...run.messages, run.streaming] : run.messages); setActivity(activity); }
    };
    // 流式文字来得很快，每帧最多刷新一次界面
    let frame = 0;
    const showText = (partial: string) => {
      // 同一个对象一直用到这段文字结束，界面上这条消息的 id 不变，不会反复重建
      if (run.streaming) run.streaming.content = partial;
      else run.streaming = { role: 'assistant', content: partial };
      run.activity = '';
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (!run.done && run.streaming) show('');
      });
    };
    let refused = false;
    const pendingExtract = extractTimers.current.get(id);
    if (pendingExtract) { clearTimeout(pendingExtract); extractTimers.current.delete(id); }
    try {
      let memory: MemoryAccess | null = null;
      if (memoryEnabled) {
        memory = { search: searchMemories };
        // 这段对话里（最近一次摘要之后）已经给过模型的记忆，还在之前的提问里，不再重复
        const since = Math.max(0, next.findLastIndex((item) => item.kind === 'summary'));
        const present = new Map<string, string>();
        for (const message of next.slice(since)) {
          for (const item of message.usedMemories ?? []) present.set(item.id, item.text);
        }
        // 记忆出问题不能影响回答
        const recalled = await recallMemories({ text: question.content!, tags: problemTags(next[0]), problemKey: target.problem.key, present }).catch(() => null);
        if (recalled?.stale) {
          // 给过的记忆被删除或修改了：撤掉之前注入的，这次重新给一份完整的。缓存会断一次，但删掉的不能再发给模型
          const scrubbed = next.findIndex((message, index) => index >= since && message !== question && (message.memoryText || message.usedMemories));
          next = next.map((message, index) => (index >= since && message !== question && (message.memoryText || message.usedMemories)
            ? { ...message, memoryText: undefined, usedMemories: undefined } : message));
          if (scrubbed >= 0) next = dropStaleReasoning(next, scrubbed);
          history.current = next; run.messages = next;
          if (showing()) setMessages(next);
        }
        if (recalled?.text) question.memoryText = recalled.text;
        if (recalled?.used.length) question.usedMemories = recalled.used.map(({ id: memoryId, text: memoryText }) => ({ id: memoryId, text: memoryText }));
      }
      persist(id, next);
      await runAgent({
        settings, tabId: target.tabId, problem: target.problem, messages: next, memory, conversationId: id, signal,
        onText: showText,
        onCompact(compactedMessages) {
          // 运行中的消息里可能有 runAgent 刚加进去的，把摘要标记放回同样的位置
          const marker = compactedMessages.find((message) => message.kind === 'summary' && !run.messages.includes(message));
          if (!marker) return;
          const after = compactedMessages[compactedMessages.indexOf(marker) + 1];
          const index = run.messages.indexOf(after!);
          if (index < 0) return;
          // 摘要之后留下的消息，思考块和 runAgent 里一样作废（见 lib/context.ts）
          run.messages = dropStaleReasoning([...run.messages.slice(0, index), marker, ...run.messages.slice(index)], index);
          persist(id, completedMessages(run.messages));
        },
        onMessage(message) {
          if (signal.aborted) return;
          // 流式的那个对象变成正式消息
          const finished = run.streaming && message.role === 'assistant' ? Object.assign(run.streaming, message, { content: message.content }) : message;
          run.streaming = null;
          run.messages = [...run.messages, finished];
          persist(id, completedMessages(run.messages));
          show('正在思考…');
        },
        onTool(name) { if (!signal.aborted) show(`${name}…`); },
      }).then((trace) => {
        // 运行记录挂在最后一条助手消息上
        const last = run.messages.at(-1);
        if (last?.role === 'assistant') last.trace = trace;
      });
    } catch (reason) {
      refused = reason instanceof RefusalError;
      const message = signal.aborted ? '本次回答已停止' : reason instanceof Error ? reason.message : '请求失败';
      if (showing()) setError(message);
      else if (!signal.aborted) failures.current.set(id, message);
    } finally {
      cancelAnimationFrame(frame);
      // 中途停止或出错时，已经生成的文字留下来；被模型拒绝时半截的文字不算数
      if (run.streaming?.content && !refused) run.messages = [...run.messages, run.streaming];
      run.streaming = null;
      run.messages = completedMessages(run.messages); run.done = true;
      setRunning((count) => count - 1);
      persist(id, run.messages);
      void pendingSave.current.then(() => { if (runs.current.get(id) === run) runs.current.delete(id); });
      if (!signal.aborted && mounted.current) scheduleExtract(id);
      if (showing()) { history.current = run.messages; setMessages(run.messages); setBusy(false); setActivity(''); }
    }
  };

  // 地址、密钥和模型都由用户填，是哪家服务、用哪种接口按地址判断，不让用户选
  const draftPreset = PROVIDERS.find((item) => item.id === vendorOf(draft.baseUrl)) ?? null;
  const draftApiType = apiTypeOfUrl(draft.baseUrl);
  const keys = [...new Set(catalog.conversations.map((item) => item.key))];
  keys.sort((a, b) => Number(b === target?.problem.key) - Number(a === target?.problem.key));
  const groups = keys.map((key) => ({
    key, conversations: catalog.conversations.filter((item) => item.key === key),
  }));
  const closeHistory = () => { setShowHistory(false); setConfirmDelete(null); };
  const errorAction: Action | undefined = error && target && !conversation && !loading
    ? { label: '重新加载对话', run: () => void openView(() => openProblemConversation(target.tabId, target.problem)) }
    : undefined;

  return <section className="agent-chat" aria-label="AI 编程助手">
    <header className={isFloat ? 'panel-header panel-header-float' : 'panel-header'} {...headerDrag}>
      {header}
      <div className="panel-actions">
        <button type="button" className="icon-button" aria-label="对话记录" title="对话记录" onClick={() => setShowHistory(true)}><HistoryIcon /></button>
        <button type="button" className="icon-button" aria-label="记忆" title="记忆" onClick={() => setShowMemory(true)}><MemoryIcon /></button>
        <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={!target || loading} onClick={newConversation}><PlusIcon /></button>
        {!isFloat && <button type="button" className="icon-button" aria-label="改成悬浮窗" title={running ? '回答完再切换' : '改成悬浮窗'} disabled={running > 0} onClick={() => void toFloat()}><FloatIcon /></button>}
        <button type="button" className="icon-button" aria-label="打开 ACBuddy 网站" title="打开 ACBuddy 网站" onClick={() => openSite()}><ExternalLinkIcon /></button>
        <button type="button" className="icon-button" aria-label="设置" title="设置" disabled={busy} onClick={openSettings}><SettingsIcon /></button>
        {isFloat && <>
          <span className="panel-actions-sep" />
          <button type="button" className="icon-button" aria-label="停靠到侧边栏" title={running ? '回答完再切换' : '停靠到侧边栏'} disabled={running > 0} onClick={toSidePanel}><DockIcon /></button>
          <button type="button" className="icon-button" aria-label="收起" title="收起" onClick={() => postToPage({ action: 'collapse' })}><MinimizeIcon /></button>
        </>}
      </div>
    </header>
    {memoryNotice && <p className="memory-notice" role="status">
      <span>已开启长期记忆，登录后同步到账号</span>
      <button type="button" className="link-button" onClick={() => { dismissMemoryNotice(); setShowMemory(true); }}>管理</button>
      <button type="button" className="link-button memory-muted-link" onClick={dismissMemoryNotice}>知道了</button>
    </p>}
    <AssistantThread key={conversation?.id ?? 'none'} conversationId={conversation?.id ?? 'none'}
      messages={messages} isRunning={busy} isLoading={loading} canSend={canSend}
      hint={hint} hintAction={hintAction} initialDraft={composerDraft.current}
      onDraftChange={(text) => { composerDraft.current = text; }}
      activity={activity} error={error} errorAction={errorAction} onSend={send} onCancel={() => runs.current.get(selectedRef.current?.id ?? '')?.abort.abort()} />
    <MemorySheet open={showMemory} onClose={() => setShowMemory(false)} enabled={memoryEnabled} onToggle={toggleMemory}
      conversationIds={new Set(catalog.conversations.map((item) => item.id))} onOpenConversation={choose} />
    <Sheet open={showHistory} title={`对话记录（${catalog.conversations.length}）`} onClose={closeHistory}>
      <nav aria-label="按题目查看对话">
        {groups.map((group) => <section key={group.key} className="history-group" aria-label={group.conversations[0]?.problemTitle}>
          <h3>{group.conversations[0]?.problemTitle}{target?.problem.key === group.key && <span className="badge">当前题目</span>}</h3>
          <ul>{group.conversations.map((item) => {
            const confirming = confirmDelete === item.id;
            return <li key={item.id} className="history-item">
              <button type="button" className="history-select" aria-current={conversation?.id === item.id ? 'true' : undefined} disabled={loading}
                onClick={() => { choose(item.id); closeHistory(); }}>
                <span>{item.title}</span>
                <time dateTime={new Date(item.updatedAt).toISOString()}>{timeLabel(item.updatedAt)}</time>
              </button>
              <button type="button" className="icon-button history-delete" data-confirm={confirming ? '' : undefined} disabled={loading}
                aria-label={confirming ? `确认删除对话：${item.title}` : `删除对话：${item.title}`} title={confirming ? undefined : '删除'}
                onBlur={() => setConfirmDelete((current) => current === item.id ? null : current)}
                onClick={() => { if (confirming) { setConfirmDelete(null); remove(item.id); } else setConfirmDelete(item.id); }}>
                {confirming ? '确认删除' : <TrashIcon />}
              </button>
            </li>;
          })}</ul>
        </section>)}
        {!groups.length && <p className="muted">还没有对话，打开题目页面后会自动创建。</p>}
      </nav>
    </Sheet>
    <Sheet open={showSettings} title="设置" onClose={() => setShowSettings(false)}>
      <div className="settings">
        <section className="settings-section">
          <h3>账号</h3>
          <div className="settings-account">
            <span>{account ? <>已登录 <strong>{account}</strong></> : account === null ? '未登录，作答不会被记录' : '正在检查登录状态…'}</span>
            <button type="button" className="link-button" onClick={() => openSite()}>{account ? '打开网站' : '去网站登录'}</button>
          </div>
        </section>
        <form className="settings-section" onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
          <h3>AI 模型</h3>
          <label className="field">API 地址<input type="url" list="acb-url-presets" placeholder="例如 https://api.deepseek.com" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
          <datalist id="acb-url-presets">{PROVIDERS.map((provider) => <option key={provider.id} value={provider.baseUrl}>{provider.label}</option>)}</datalist>
          <label className="field">API Key<input type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label>
          <label className="field">模型<input list={draftPreset ? 'acb-model-presets' : undefined} value={draft.model}
            placeholder={draftPreset ? `例如 ${draftPreset.models[0]!.id}` : '支持工具调用的模型'} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
          {draftPreset && <datalist id="acb-model-presets">{draftPreset.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>}
          {draftPreset && <label className="field">思考强度<select value={draft.effort ?? ''} onChange={(e) => {
            const { effort: _effort, ...rest } = draft;
            setDraft(e.target.value ? { ...rest, effort: e.target.value as Effort } : rest);
          }}>
            <option value="">默认</option>
            <option value="low">低：更快更省</option>
            <option value="medium">中</option>
            <option value="high">高：更慢更贵</option>
          </select></label>}
          <p className="settings-note">
            {!draftPreset && draft.baseUrl.trim() && `按 ${API_LABELS[draftApiType]} 接口调用，服务需支持工具调用；地址写到 /responses 或 /messages 可以换接口。`}
            密钥和对话只保存在本机，记忆登录后同步到账号；提问时题目、代码、作答记录和相关记忆会按需发送到该服务。
          </p>
          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={saving || busy}>{saving ? '正在保存…' : '保存设置'}</button>
            {settingsStatus && <span className="settings-status" role="status">{settingsStatus}</span>}
          </div>
        </form>
      </div>
    </Sheet>
  </section>;
}
