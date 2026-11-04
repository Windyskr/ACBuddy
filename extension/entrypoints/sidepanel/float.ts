import type { PointerEvent as ReactPointerEvent } from 'react';
import { FRAME_SOURCE, type FrameMessage } from '../lib/display';

// 同一个面板页面有两种开法：侧边栏，和题目页上悬浮窗里的 iframe（float.content.ts 给的地址带 ?mode=float）。
// 侧边栏跟着当前窗口的活动标签页走；悬浮窗只管它所在的那个标签页

export const isFloat = new URLSearchParams(location.search).get('mode') === 'float';

let ownTab: Promise<chrome.tabs.Tab | undefined> | null = null;
/** 悬浮窗所在的标签页，一直不变 */
export const floatTab = () => (ownTab ??= chrome.tabs.getCurrent());

/** 面板要看的标签页 */
export async function viewedTab() {
  if (isFloat) return floatTab();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 发给题目页上画悬浮窗的内容脚本 */
export function postToPage(message: FrameMessage) {
  if (!isFloat || window.parent === window) return;
  window.parent.postMessage({ source: FRAME_SOURCE, ...message }, location.ancestorOrigins?.[0] ?? '*');
}

/**
 * 悬浮窗的顶栏当拖动把手：按住空白处，把指针在 iframe 里的位置发给外面，之后的移动由外面在题目页上接着收
 * （指针一出 iframe，事件就只到题目页了）。顶栏上的按钮照常能点
 */
export const headerDrag = isFloat ? {
  onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest('button, a, input, select, textarea, label')) return;
    event.preventDefault();
    postToPage({ action: 'drag-start', x: event.clientX, y: event.clientY, ratio: devicePixelRatio });
  },
  onPointerUp() { postToPage({ action: 'drag-end' }); },
} : {};
