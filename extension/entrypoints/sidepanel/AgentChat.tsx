import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageNotSentError } from '@assistant-ui/react';
import { completedMessages, endpointFor, runAgent, SETTINGS_KEY, type AgentMessage, type AgentSettings } from '../lib/agent';
import {
  CATALOG_KEY, createConversation, deleteConversation, getConversationCatalog,
  openProblemConversation, saveConversation, selectConversation,
  type Conversation, type ConversationCatalog,
} from '../lib/agent-conversation';
import { openSite } from '../lib/api';
import { problemOf, type ProblemRef } from '../lib/platforms';
import AssistantThread, { type Action } from './AssistantThread';
import Sheet from './Sheet';
import { ExternalLinkIcon, HistoryIcon, PlusIcon, SettingsIcon, TrashIcon } from './icons';

const emptySettings: AgentSettings = { baseUrl: '', model: '', apiKey: '' };
type Target = { tabId: number; problem: ProblemRef };
// 进行中的回答按对话记下：切到别的标签页或对话时在后台继续、照常保存，切回这个对话时接着显示。
// done 之后留到最后一次保存写完，免得这期间打开对话读到旧记录
type Run = { abort: AbortController; messages: AgentMessage[]; activity: string; done: boolean };

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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [catalog, setCatalog] = useState<ConversationCatalog>({ conversations: [], selected: {} });
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const beginView = useCallback(() => {
    const ticket = ++version.current;
    if (selectedRef.current) composerDraft.current = '';
    selectedRef.current = null; history.current = [];
    setConversation(null); setMessages([]); setError('');
    setBusy(false); setLoading(true); setActivity('正在加载对话…');
    return ticket;
  }, []);

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
      setConversation(record); setMessages(history.current);
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
        const [data, savedCatalog] = await Promise.all([chrome.storage.local.get(SETTINGS_KEY), getConversationCatalog()]);
        if (!mounted.current) return;
        const saved = data[SETTINGS_KEY] as AgentSettings | undefined;
        if (saved) { setSettings(saved); setDraft(saved); }
        setSettingsLoaded(true);
        if (!catalogChanged) setCatalog(savedCatalog);
      } catch { if (mounted.current) setError('读取本机设置或对话列表失败'); }
    })();
    return () => {
      mounted.current = false; ++version.current; ++targetQuery.current;
      for (const run of runs.current.values()) run.abort.abort();
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [beginView]);

  const syncTarget = useCallback(async () => {
    const query = ++targetQuery.current;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
    chrome.tabs.onActivated.addListener(onActivated);
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
      void openView(async () => {
        const next = await deleteConversation(id);
        const replacement = next.conversations.find((item) => item.key === old.key) ?? next.conversations[0];
        return replacement ? selectConversation(replacement.id) : null;
      });
    } else {
      void deleteConversation(id).catch((reason) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '删除对话失败'); });
    }
  };

  const saveSettings = async () => {
    setSettingsStatus('');
    try {
      const endpoint = endpointFor(draft.baseUrl, draft.apiType);
      if (!draft.model.trim()) throw new Error('请填写模型名称');
      const permission = chrome.permissions.request({ origins: [`${endpoint.protocol}//${endpoint.hostname}/*`] });
      setSaving(true);
      if (!await permission) throw new Error('需要允许访问该 API 地址才能调用模型');
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      const next = { baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), model: draft.model.trim(), apiKey: draft.apiKey.trim(), apiType: draft.apiType ?? 'responses' as const };
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      setSettings(next); setDraft(next); setShowSettings(false);
    } catch (reason) { setSettingsStatus(reason instanceof Error ? reason.message : '保存设置失败'); }
    finally { setSaving(false); }
  };
  const openSettings = () => { setDraft(settings); setSettingsStatus(''); setShowSettings(true); };

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
    const next: AgentMessage[] = [...completedMessages(history.current), { role: 'user', content: text.trim() }];
    if (JSON.stringify(next).length > 200000) {
      setError('对话内容过长，请新建对话后继续提问');
      throw new MessageNotSentError('对话内容过长');
    }
    const run: Run = { abort: new AbortController(), messages: next, activity: '正在思考…', done: false };
    const { signal } = run.abort;
    runs.current.set(id, run); failures.current.delete(id);
    history.current = next; setMessages(next); persist(id, next);
    setBusy(true); setError(''); setActivity(run.activity);
    const showing = () => mounted.current && selectedRef.current?.id === id;
    const show = (activity: string) => {
      run.activity = activity;
      if (showing()) { history.current = run.messages; setMessages(run.messages); setActivity(activity); }
    };
    try {
      await runAgent({
        settings, tabId: target.tabId, problem: target.problem, messages: next, signal,
        onMessage(message) {
          if (signal.aborted) return;
          run.messages = [...run.messages, message];
          persist(id, completedMessages(run.messages));
          show('正在思考…');
        },
        onTool(name) { if (!signal.aborted) show(`${name}…`); },
      });
    } catch (reason) {
      const message = signal.aborted ? '本次回答已停止' : reason instanceof Error ? reason.message : '请求失败';
      if (showing()) setError(message);
      else if (!signal.aborted) failures.current.set(id, message);
    } finally {
      run.messages = completedMessages(run.messages); run.done = true;
      persist(id, run.messages);
      void pendingSave.current.then(() => { if (runs.current.get(id) === run) runs.current.delete(id); });
      if (showing()) { history.current = run.messages; setMessages(run.messages); setBusy(false); setActivity(''); }
    }
  };

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
    <header className="panel-header">
      {header}
      <div className="panel-actions">
        <button type="button" className="icon-button" aria-label="对话记录" title="对话记录" onClick={() => setShowHistory(true)}><HistoryIcon /></button>
        <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={!target || loading} onClick={newConversation}><PlusIcon /></button>
        <button type="button" className="icon-button" aria-label="打开 ACBuddy 网站" title="打开 ACBuddy 网站" onClick={() => openSite()}><ExternalLinkIcon /></button>
        <button type="button" className="icon-button" aria-label="设置" title="设置" disabled={busy} onClick={openSettings}><SettingsIcon /></button>
      </div>
    </header>
    <AssistantThread key={conversation?.id ?? 'none'} conversationId={conversation?.id ?? 'none'}
      messages={messages} isRunning={busy} isLoading={loading} canSend={canSend}
      hint={hint} hintAction={hintAction} initialDraft={composerDraft.current}
      onDraftChange={(text) => { composerDraft.current = text; }}
      activity={activity} error={error} errorAction={errorAction} onSend={send} onCancel={() => runs.current.get(selectedRef.current?.id ?? '')?.abort.abort()} />
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
          <label className="field">接口类型<select value={draft.apiType ?? 'responses'} onChange={(e) => setDraft({ ...draft, apiType: e.target.value as 'responses' | 'chat-completions' })}>
            <option value="responses">Responses（默认）</option>
            <option value="chat-completions">Chat Completions</option>
          </select></label>
          <label className="field">API 基础地址<input type="url" placeholder="https://服务地址/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
          <label className="field">模型名称<input value={draft.model} placeholder="支持工具调用的模型" onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
          <label className="field">API Key<input type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label>
          <p className="settings-note">服务需支持所选接口的工具调用。密钥和对话只保存在本机；提问时题目、代码和作答记录会按需发送到该服务。</p>
          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={saving || busy}>{saving ? '正在保存…' : '保存设置'}</button>
            {settingsStatus && <span className="settings-status" role="status">{settingsStatus}</span>}
          </div>
        </form>
      </div>
    </Sheet>
  </section>;
}
