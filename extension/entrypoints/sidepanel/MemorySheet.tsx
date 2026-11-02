import { useEffect, useRef, useState } from 'react';
import { clearMemories, editMemory, exportMemories, importMemories, listMemories, memorySyncError, memoryUsage, removeMemory, syncMemories, type MemoryUsage } from '../lib/memory/service';
import { MAX_MEMORY_CHARS } from '../lib/memory/gate';
import type { MemoryRecord } from '../lib/memory/types';
import Sheet from './Sheet';
import { TrashIcon } from './icons';

const day = (time: number) => new Date(time).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });

function MemoryItem({ memory, conversationIds, onChanged, onOpenConversation }: {
  memory: MemoryRecord; conversationIds: Set<string>; onChanged(): void; onOpenConversation(id: string): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const quote = memory.evidence.find((item) => item.kind === 'user_quote');
  const source = quote?.kind === 'user_quote' && conversationIds.has(quote.sessionId) ? quote : null;
  if (editing !== null) {
    return <li className="memory-item">
      <textarea className="memory-edit" aria-label="编辑记忆" rows={3} maxLength={MAX_MEMORY_CHARS} value={editing} autoFocus onChange={(event) => setEditing(event.target.value)} />
      <div className="settings-actions">
        <button type="button" className="link-button" disabled={!editing.trim()} onClick={() => void editMemory(memory, editing.trim()).then(() => { setEditing(null); onChanged(); })}>保存</button>
        <button type="button" className="link-button memory-muted-link" onClick={() => setEditing(null)}>取消</button>
      </div>
    </li>;
  }
  return <li className="memory-item">
    <div className="memory-row">
      <button type="button" className="memory-text" title="点击编辑" onClick={() => setEditing(memory.text)}>{memory.text}</button>
      <button type="button" className="icon-button history-delete" data-confirm={confirming ? '' : undefined}
        aria-label={confirming ? `确认删除记忆：${memory.text}` : `删除记忆：${memory.text}`} title={confirming ? undefined : '删除'}
        onBlur={() => setConfirming(false)}
        onClick={() => { if (confirming) void removeMemory(memory.id).then(onChanged); else setConfirming(true); }}>
        {confirming ? '确认删除' : <TrashIcon />}
      </button>
    </div>
    <small className="memory-meta">
      <time dateTime={new Date(memory.validFrom).toISOString()}>{day(memory.validFrom)}</time>
      {memory.invalidAt != null && <> 至 {day(memory.invalidAt)}</>}
      {source && <button type="button" className="link-button" title={source.quote} onClick={() => onOpenConversation(source.sessionId)}>来源</button>}
    </small>
  </li>;
}

const GROUPS = [
  { title: '辅导方式', match: (memory: MemoryRecord) => memory.type === 'procedural' },
  { title: '关于你', match: (memory: MemoryRecord) => memory.type === 'semantic' },
  { title: '经历', match: (memory: MemoryRecord) => memory.type === 'episodic' },
];

export default function MemorySheet({ open, onClose, enabled, onToggle, conversationIds, onOpenConversation }: {
  open: boolean; onClose(): void; enabled: boolean; onToggle(next: boolean): void;
  conversationIds: Set<string>; onOpenConversation(id: string): void;
}) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [status, setStatus] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => void listMemories().then((items) => setRecords(items.sort((x, y) => y.validFrom - x.validFrom || x.id.localeCompare(y.id)))).catch(() => setStatus('读取记忆失败'));
  useEffect(() => {
    if (!open) return;
    setStatus('');
    setConfirmClear(false);
    refresh();
    void memoryUsage().then(setUsage).catch(() => setUsage(null));
    // 先显示本机的，同步完再刷新，别让网络拖慢打开面板
    void syncMemories().then(() => {
      refresh();
      setSyncFailed(!!memorySyncError());
    });
  }, [open]);

  const save = async () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(await exportMemories(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'acbuddy-memory.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const load = async (file: File) => {
    try {
      setStatus(`已导入 ${await importMemories(JSON.parse(await file.text()))} 条记忆`);
      refresh();
    } catch (reason) {
      setStatus(reason instanceof Error ? `导入失败：${reason.message}` : '导入失败');
    }
  };

  const current = records.filter((memory) => memory.invalidAt == null);
  const expired = records.filter((memory) => memory.invalidAt != null);
  const item = (memory: MemoryRecord) => <MemoryItem key={memory.id} memory={memory} conversationIds={conversationIds} onChanged={refresh}
    onOpenConversation={(id) => { onOpenConversation(id); onClose(); }} />;
  return <Sheet open={open} title={`记忆（${current.length}）`} onClose={onClose}>
    <label className="memory-switch">
      <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
      <span>记住我的目标、偏好和薄弱点</span>
    </label>
    <p className="settings-note">记忆登录后会同步到你的账号，换设备也能用，对话和你的原话不上传。提问时相关的记忆会发给你配置的模型；对话结束后会多调用一两次模型来整理记忆{usage?.calls ? `，目前累计 ${usage.calls} 次、${usage.inputTokens + usage.outputTokens} token` : ''}。</p>
    {GROUPS.map(({ title, match }) => {
      const items = current.filter(match);
      return items.length > 0 && <section key={title} className="history-group" aria-label={title}><h3>{title}</h3><ul>{items.map(item)}</ul></section>;
    })}
    {expired.length > 0 && <details className="memory-expired"><summary>已经不成立的（{expired.length}）</summary><ul>{expired.map(item)}</ul></details>}
    {!records.length && <p className="muted">还没有记忆。多聊几次，AI 会记下你提到的目标、习惯和常错的地方。</p>}
    <div className="memory-actions">
      <button type="button" className="link-button" disabled={!records.length} onClick={() => void save()}>导出</button>
      <button type="button" className="link-button" onClick={() => fileInput.current?.click()}>导入</button>
      <input ref={fileInput} type="file" accept="application/json" hidden aria-label="选择记忆文件" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void load(file);
      }} />
      <button type="button" className="link-button memory-danger" disabled={!records.length} onBlur={() => setConfirmClear(false)}
        onClick={() => { if (confirmClear) void clearMemories().then(refresh); else setConfirmClear(true); }}>{confirmClear ? '确认清空' : '清空'}</button>
      {(status || syncFailed) && <span className="settings-status" role="status">{status || '同步失败，之后会自动重试'}</span>}
    </div>
  </Sheet>;
}
