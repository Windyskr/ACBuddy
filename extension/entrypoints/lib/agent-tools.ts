import type { JudgeRecord } from './judge';

// This function is serialized by chrome.scripting; keep every dependency inside it.
export function editorTool(
  slug: string,
  action: 'read' | 'judge' | 'highlight' | 'clear',
  snapshot: { code: string; uri: string } | null,
  ranges: { startLine: number; endLine: number; message: string }[],
) {
  try {
    interface Model {
      uri: { toString(): string };
      getValue(): string;
      getLanguageId(): string;
      getLineCount(): number;
      getLineMaxColumn(line: number): number;
      deltaDecorations(old: string[], next: unknown[]): string[];
      onDidChangeContent(listener: () => void): { dispose(): void };
    }
    interface Editor {
      getModel(): Model | null;
      getDomNode(): HTMLElement | null;
      hasTextFocus(): boolean;
      revealLineInCenter(line: number): void;
    }
    const page = window as unknown as {
      monaco?: { editor: {
        getModels(): Model[];
        getEditors?(): Editor[];
        setModelMarkers(model: Model, owner: string, markers: unknown[]): void;
      } };
      __acbAgentHighlights?: { clear(): void };
      __acbLastJudge?: JudgeRecord;
    };
    if (location.pathname.match(/\/problems\/([a-z0-9-]+)/i)?.[1] !== slug) {
      throw new Error('题目已经切换，请重新提问');
    }
    const monaco = page.monaco?.editor;
    if (!monaco) throw new Error('无法访问代码编辑器，请打开题目的代码区域');
    if (action === 'clear') {
      page.__acbAgentHighlights?.clear();
      return { cleared: true };
    }
    // LeetCode also creates a hidden 5px auxiliary editor; resolve the visible one by its DOM node.
    const isVisible = (node: HTMLElement | null) => {
      if (!node?.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20 && getComputedStyle(node).visibility !== 'hidden';
    };
    const editors = monaco.getEditors?.() ?? [];
    const visible = editors.filter((editor) => editor.getModel() && isVisible(editor.getDomNode()));
    const selected = visible.find((editor) => editor.hasTextFocus()) ?? (visible.length === 1 ? visible[0] : undefined);
    const models = monaco.getModels();
    const nodes = [...document.querySelectorAll<HTMLElement>('.monaco-editor[data-uri]')].filter(isVisible);
    const domModel = nodes.length === 1 ? models.find((model) => model.uri.toString() === nodes[0]!.dataset.uri) : null;
    const model = selected?.getModel() ?? domModel;
    if (action === 'judge') {
      const judge = page.__acbLastJudge;
      if (judge?.slug !== slug) throw new Error('当前页面还没有这道题的运行或提交结果（刷新页面后会清空），请先运行或提交代码');
      const { code, ...result } = judge;
      // 判题后改过代码，结果就对应改动前的代码；认不出当前编辑器时不下结论
      return { ...result, codeChanged: model && code != null ? model.getValue() !== code : null };
    }
    if (!model) throw new Error('无法确定当前编辑器，请关闭其他代码视图后重试');
    if (action === 'read') {
      const code = model.getValue();
      if (code.length > 80000) throw new Error('当前代码超过 80000 个字符，请缩短代码后提问');
      return { code, uri: model.uri.toString(), language: model.getLanguageId() };
    }
    if (!snapshot || snapshot.uri !== model.uri.toString() || snapshot.code !== model.getValue()) {
      throw new Error('代码已经变化，请重新读取代码再高亮');
    }
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 20) throw new Error('高亮数量必须在 1 到 20 之间');
    for (const range of ranges) {
      if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 ||
        range.endLine < range.startLine || range.endLine > model.getLineCount() ||
        typeof range.message !== 'string' || !range.message.trim() || range.message.length > 1000) {
        throw new Error('高亮行号或错误说明无效');
      }
    }
    page.__acbAgentHighlights?.clear();
    if (!document.getElementById('acb-agent-highlight-style')) {
      const style = document.createElement('style');
      style.id = 'acb-agent-highlight-style';
      style.textContent = '.acb-agent-error-line { background: rgba(239,68,68,.16); } .acb-agent-error-gutter { border-left: 3px solid #ef4444; margin-left: 3px; }';
      document.head.append(style);
    }
    monaco.setModelMarkers(model, 'acbuddy-agent', ranges.map((range) => ({
      startLineNumber: range.startLine, endLineNumber: range.endLine,
      startColumn: 1, endColumn: model.getLineMaxColumn(range.endLine),
      message: range.message, severity: 8, source: 'ACBuddy AI',
    })));
    const ids = model.deltaDecorations([], ranges.map((range) => ({
      range: { startLineNumber: range.startLine, startColumn: 1, endLineNumber: range.endLine, endColumn: 1 },
      options: { isWholeLine: true, className: 'acb-agent-error-line', linesDecorationsClassName: 'acb-agent-error-gutter' },
    })));
    const clear = () => {
      monaco.setModelMarkers(model, 'acbuddy-agent', []);
      model.deltaDecorations(ids, []);
      listener.dispose();
      if (page.__acbAgentHighlights?.clear === clear) delete page.__acbAgentHighlights;
    };
    const listener = model.onDidChangeContent(clear);
    page.__acbAgentHighlights = { clear };
    selected?.revealLineInCenter(ranges[0]!.startLine);
    return { highlighted: ranges.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '编辑器工具执行失败' };
  }
}
