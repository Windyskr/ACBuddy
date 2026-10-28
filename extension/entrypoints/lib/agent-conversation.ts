import { completedMessages, type AgentMessage } from './agent';

export interface ConversationSummary {
  id: string;
  slug: string;
  problemTitle: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface Conversation extends ConversationSummary { messages: AgentMessage[] }
export interface ConversationCatalog {
  conversations: ConversationSummary[];
  selected: Record<string, string>;
}
export const CATALOG_KEY = 'acb-agent-threads';
const recordKey = (id: string) => `acb-agent-thread:${id}`;

// Web Locks also serialize updates from side panels in other browser windows.
const locked = <T>(work: () => Promise<T>) => navigator.locks.request(CATALOG_KEY, work);
export async function getConversationCatalog(): Promise<ConversationCatalog> {
  const stored = await chrome.storage.local.get(CATALOG_KEY);
  return (stored[CATALOG_KEY] as ConversationCatalog | undefined) ?? { conversations: [], selected: {} };
}

async function readConversation(id: string): Promise<Conversation | null> {
  const stored = await chrome.storage.local.get(recordKey(id));
  const record = stored[recordKey(id)] as Conversation | undefined;
  return record ? { ...record, messages: completedMessages(record.messages) } : null;
}

async function writeConversation(record: Conversation, catalog: ConversationCatalog) {
  const { messages: _messages, ...summary } = record;
  catalog.conversations = [summary, ...catalog.conversations.filter((item) => item.id !== record.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  await chrome.storage.local.set({ [recordKey(record.id)]: record, [CATALOG_KEY]: catalog });
}

async function create(tabId: number, slug: string, catalog: ConversationCatalog): Promise<Conversation> {
  const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_AGENT_PROBLEM', slug });
  if (!data?.ok || data.slug !== slug || typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error(data?.error ?? '读取完整题目失败，请重试');
  }
  const problemTitle = `${data.questionId ? `${data.questionId}. ` : ''}${data.title || data.translatedTitle || slug}`;
  const usedTitles = new Set(catalog.conversations.filter((item) => item.slug === slug).map((item) => item.title));
  let number = 1;
  while (usedTitles.has(`新对话 ${number}`)) number++;
  const record: Conversation = {
    id: crypto.randomUUID(), slug, problemTitle,
    title: `新对话 ${number}`,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: [{
      role: 'user', kind: 'problem',
      content: [
        '当前题目信息', problemTitle,
        data.difficultyCn ? `难度：${data.difficultyCn}` : null,
        `题目链接：${new URL(data.url).origin}/problems/${slug}/`,
        '', data.description,
      ].filter((line) => line !== null).join('\n'),
    }],
  };
  catalog.selected[slug] = record.id;
  await writeConversation(record, catalog);
  return record;
}

export const createConversation = (tabId: number, slug: string) => locked(async () =>
  create(tabId, slug, await getConversationCatalog()),
);

export const openProblemConversation = (tabId: number, slug: string) => locked(async () => {
  const catalog = await getConversationCatalog();
  const summary = catalog.conversations.filter((item) => item.slug === slug)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  if (summary) {
    const record = await readConversation(summary.id);
    if (!record) throw new Error('对话记录不存在，请新建对话');
    catalog.selected[slug] = record.id;
    await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
    return record;
  }
  return create(tabId, slug, catalog);
});

export const selectConversation = (id: string) => locked(async () => {
  const catalog = await getConversationCatalog();
  if (!catalog.conversations.some((item) => item.id === id)) throw new Error('对话已删除，请选择其他对话');
  const record = await readConversation(id);
  if (!record) throw new Error('对话已删除，请选择其他对话');
  catalog.selected[record.slug] = id;
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  return record;
});

export const saveConversation = (id: string, messages: AgentMessage[]) => locked(async () => {
  const catalog = await getConversationCatalog();
  if (!catalog.conversations.some((item) => item.id === id)) throw new Error('对话已删除');
  const record = await readConversation(id);
  if (!record) throw new Error('对话已删除');
  const firstQuestion = messages.find((message) => message.role === 'user' && message.kind !== 'problem')?.content;
  record.messages = completedMessages(messages);
  record.title = firstQuestion ? firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 48) : record.title;
  record.updatedAt = Date.now();
  await writeConversation(record, catalog);
});

export const deleteConversation = (id: string) => locked(async () => {
  const catalog = await getConversationCatalog();
  const summary = catalog.conversations.find((item) => item.id === id);
  catalog.conversations = catalog.conversations.filter((item) => item.id !== id);
  if (summary && catalog.selected[summary.slug] === id) {
    const next = catalog.conversations.find((item) => item.slug === summary.slug);
    if (next) catalog.selected[summary.slug] = next.id;
    else delete catalog.selected[summary.slug];
  }
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  await chrome.storage.local.remove(recordKey(id));
  return catalog;
});
