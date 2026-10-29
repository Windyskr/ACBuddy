import type { JudgeRecord } from './judge';

// This function is serialized by chrome.scripting; keep every dependency inside it.
export function editorTool(
  guard: { pattern: string; flags: string; id: string },
  action: 'read' | 'judge' | 'highlight' | 'clear',
  snapshot: { code: string; uri: string } | null,
  ranges: { startLine: number; endLine: number; message: string }[],
) {
  try {
    type Range = { startLine: number; endLine: number; message: string };
    interface Model {
      uri: { toString(): string };
      getValue(): string;
      getLanguageId?(): string;
      getModeId?(): string;
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
    interface AceSession {
      getValue(): string;
      getLength(): number;
      getMode(): { $id?: string };
      addMarker(range: unknown, className: string, type: string, front?: boolean): number;
      removeMarker(id: number): void;
      addGutterDecoration(row: number, className: string): void;
      removeGutterDecoration(row: number, className: string): void;
      on(event: 'change', listener: () => void): void;
      off(event: 'change', listener: () => void): void;
    }
    interface AceEditor {
      container: HTMLElement;
      session: AceSession;
      isFocused(): boolean;
      scrollToLine(line: number, center: boolean, animate: boolean, callback: () => void): void;
    }
    /** 当前代码框：读代码，能标错误行的再给 mark（返回清除函数，代码一改自动清除） */
    interface Target {
      uri: string;
      language: string | null;
      value(): string;
      lineCount(): number;
      mark: ((ranges: Range[], onCleared: () => void) => () => void) | null;
    }
    const page = window as unknown as {
      monaco?: { editor?: {
        getModels(): Model[];
        getEditors?(): Editor[];
        setModelMarkers(model: Model, owner: string, markers: unknown[]): void;
      } };
      ace?: { require(name: string): { Range: new (...args: number[]) => unknown } };
      __acbAgentHighlights?: { clear(): void };
      __acbLastJudge?: JudgeRecord;
      // 牛客自己打包了一份 Monaco，全局的 monaco 拿不到它的编辑器
      __ncMonacoEditorApi?: { editor?: Editor };
    };
    const slug = new RegExp(guard.pattern, guard.flags).exec(location.pathname)?.[1];
    if (!slug || slug.toLowerCase() !== guard.id.toLowerCase()) throw new Error('题目已经切换，请重新提问');
    if (action === 'clear') {
      page.__acbAgentHighlights?.clear();
      return { cleared: true };
    }
    // LeetCode also creates a hidden 5px auxiliary editor; resolve the visible one by its DOM node.
    const isVisible = (node: Element | null) => {
      if (!node?.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20 && getComputedStyle(node).visibility !== 'hidden';
    };

    // Monaco：力扣、codefun2000 用全局 monaco，牛客用它自己那份
    const monaco = page.monaco?.editor;
    const nowcoder = page.__ncMonacoEditorApi?.editor;
    const monacoEditors = nowcoder?.getModel() && isVisible(nowcoder.getDomNode()) ? [nowcoder] : monaco?.getEditors?.() ?? [];
    const visibleMonaco = monacoEditors.filter((editor) => editor.getModel() && isVisible(editor.getDomNode()));
    const selected = visibleMonaco.find((editor) => editor.hasTextFocus()) ?? (visibleMonaco.length === 1 ? visibleMonaco[0] : undefined);
    const models = monaco?.getModels() ?? [];
    const nodes = [...document.querySelectorAll<HTMLElement>('.monaco-editor[data-uri]')].filter(isVisible);
    const domModel = nodes.length === 1 ? models.find((model) => model.uri.toString() === nodes[0]!.dataset.uri) : null;
    const model = selected?.getModel() ?? domModel ?? null;
    let target: Target | null = null;
    if (model) {
      // 编辑器属于全局 monaco 时加错误标记（波浪线和悬停说明）；牛客那份 Monaco 不对外，只标红行
      const markers = monaco && models.includes(model) ? monaco : null;
      target = {
        uri: model.uri.toString(), language: model.getLanguageId?.() ?? model.getModeId?.() ?? null,
        value: () => model.getValue(), lineCount: () => model.getLineCount(),
        mark: (marked, onCleared) => {
          markers?.setModelMarkers(model, 'acbuddy-agent', marked.map((range) => ({
            startLineNumber: range.startLine, endLineNumber: range.endLine,
            startColumn: 1, endColumn: model.getLineMaxColumn(range.endLine),
            message: range.message, severity: 8, source: 'ACBuddy AI',
          })));
          const ids = model.deltaDecorations([], marked.map((range) => ({
            range: { startLineNumber: range.startLine, startColumn: 1, endLineNumber: range.endLine, endColumn: 1 },
            options: { isWholeLine: true, className: 'acb-agent-error-line', linesDecorationsClassName: 'acb-agent-error-gutter' },
          })));
          let cleared = false;
          const clear = () => {
            if (cleared) return;
            cleared = true;
            markers?.setModelMarkers(model, 'acbuddy-agent', []);
            model.deltaDecorations(ids, []);
            listener.dispose();
            onCleared();
          };
          const listener = model.onDidChangeContent(clear);
          selected?.revealLineInCenter(marked[0]!.startLine);
          return clear;
        },
      };
    }

    // Ace：AtCoder 提交区、AcWing
    const ace = page.ace;
    // 只用页面已经建好的编辑器：ace.edit 碰到还没初始化的元素会新建一个
    const aceEditors = ace ? [...document.querySelectorAll<HTMLElement>('.ace_editor')].filter(isVisible)
      .map((node) => (node as HTMLElement & { env?: { editor?: AceEditor } }).env?.editor)
      .filter((editor): editor is AceEditor => !!editor) : [];
    const aceEditor = aceEditors.find((editor) => editor.isFocused()) ?? (aceEditors.length === 1 ? aceEditors[0] : undefined);
    if (!target && ace && aceEditor) {
      const { session } = aceEditor;
      target = {
        uri: `ace:${aceEditor.container.id || 'editor'}`, language: session.getMode().$id?.replace('ace/mode/', '') ?? null,
        value: () => session.getValue(), lineCount: () => session.getLength(),
        mark: (marked, onCleared) => {
          const { Range: AceRange } = ace.require('ace/range');
          const ids = marked.map((range) => session.addMarker(new AceRange(range.startLine - 1, 0, range.endLine - 1, Infinity), 'acb-agent-error-line', 'fullLine'));
          const rows = marked.flatMap((range) => Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine - 1 + index));
          rows.forEach((row) => session.addGutterDecoration(row, 'acb-agent-error-gutter'));
          let cleared = false;
          const clear = () => {
            if (cleared) return;
            cleared = true;
            ids.forEach((id) => session.removeMarker(id));
            rows.forEach((row) => session.removeGutterDecoration(row, 'acb-agent-error-gutter'));
            session.off('change', clear);
            onCleared();
          };
          session.on('change', clear);
          aceEditor.scrollToLine(marked[0]!.startLine - 1, true, true, () => {});
          return clear;
        },
      };
    }

    // CodeMirror 6：洛谷 IDE 模式。视图挂在内容节点上，新版叫 cmTile、旧版叫 cmView；它的装饰要用自己的模块，页面外加不了
    const cmNodes = [...document.querySelectorAll('.cm-editor')].filter(isVisible);
    type CmView = { state?: { doc?: { toString(): string; lines: number } } };
    const cmContent = cmNodes.length === 1 ? cmNodes[0]!.querySelector('.cm-content') as (Element & { cmTile?: CmView & { view?: CmView }; cmView?: CmView & { view?: CmView } }) | null : null;
    const cmTile = cmContent?.cmTile ?? cmContent?.cmView;
    const cmView = cmTile?.view ?? cmTile;
    if (!target && cmView?.state?.doc) {
      const doc = () => cmView.state!.doc!;
      target = { uri: 'codemirror:editor', language: null, value: () => doc().toString(), lineCount: () => doc().lines, mark: null };
    }

    // AtCoder 可以把提交区切成普通文本框
    const plain = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[name="sourceCode"]')].find(isVisible);
    if (!target && plain) {
      target = { uri: 'textarea:sourceCode', language: null, value: () => plain.value, lineCount: () => plain.value.split('\n').length, mark: null };
    }

    if (action === 'judge') {
      const judge = page.__acbLastJudge;
      if (judge?.slug !== guard.id) throw new Error('当前页面还没有这道题的运行或提交结果（刷新页面后会清空），请先运行或提交代码');
      const { code, ...result } = judge;
      // 判题后改过代码，结果就对应改动前的代码；认不出当前编辑器时不下结论
      return { ...result, codeChanged: target && code != null ? target.value() !== code : null };
    }
    if (!target) {
      throw new Error(monacoEditors.length || aceEditors.length || cmNodes.length
        ? '无法确定当前编辑器，请关闭其他代码视图后重试'
        : '没有找到代码框，请打开题目的代码区域（洛谷要先进入 IDE 模式，AtCoder 要登录）');
    }
    if (action === 'read') {
      const code = target.value();
      if (code.length > 80000) throw new Error('当前代码超过 80000 个字符，请缩短代码后提问');
      return { code, uri: target.uri, language: target.language };
    }
    if (!target.mark) throw new Error('这个代码框不支持标出错误行');
    if (!snapshot || snapshot.uri !== target.uri || snapshot.code !== target.value()) {
      throw new Error('代码已经变化，请重新读取代码再高亮');
    }
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 20) throw new Error('高亮数量必须在 1 到 20 之间');
    for (const range of ranges) {
      if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 ||
        range.endLine < range.startLine || range.endLine > target.lineCount() ||
        typeof range.message !== 'string' || !range.message.trim() || range.message.length > 1000) {
        throw new Error('高亮行号或错误说明无效');
      }
    }
    page.__acbAgentHighlights?.clear();
    if (!document.getElementById('acb-agent-highlight-style')) {
      const style = document.createElement('style');
      style.id = 'acb-agent-highlight-style';
      style.textContent = '.acb-agent-error-line { background: rgba(239,68,68,.16); } .acb-agent-error-gutter { border-left: 3px solid #ef4444; margin-left: 3px; }'
        // Ace 的行标记是绝对定位的层，侧栏格子用内阴影画红条，不改它的宽度
        + ' .ace_marker-layer .acb-agent-error-line { position: absolute; } .ace_gutter-cell.acb-agent-error-gutter { border-left: 0; margin-left: 0; box-shadow: inset 3px 0 0 #ef4444; }';
      document.head.append(style);
    }
    const handle = { clear: () => {} };
    handle.clear = target.mark(ranges, () => {
      if (page.__acbAgentHighlights === handle) delete page.__acbAgentHighlights;
    });
    page.__acbAgentHighlights = handle;
    return { highlighted: ranges.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : '编辑器工具执行失败' };
  }
}
