// 显示方式：侧边栏，或者浮在题目页上的悬浮窗。悬浮窗就是把侧边栏的页面放进题目页的 iframe 里，
// 外面的框（拖动、调大小、收起成圆钮）由 float.content.ts 画。
// 模式和位置存在 chrome.storage.local；内容脚本读不到它（存着密钥，只开放给插件自己的页面），经后台转

export type DisplayMode = 'sidepanel' | 'float';

/** 悬浮窗能出现的网站：支持的刷题平台（见 platforms.ts），内容脚本只在这些网站上运行 */
export const FLOAT_SITES = [
  'https://leetcode.cn/*', 'https://leetcode.com/*', 'https://codefun2000.com/*', 'https://www.nowcoder.com/*',
  'https://www.luogu.com.cn/*', 'https://atcoder.jp/*', 'https://www.acwing.com/*',
] as const;
export const DISPLAY_KEY = 'acb-display-mode';
export const FLOAT_LAYOUT_KEY = 'acb-float-layout';

/** 悬浮窗在一个网站上的位置和大小，每个网站单独记。right 是到视口右边的距离，top 是到视口顶部的距离；圆钮也一样 */
export interface FloatLayout {
  right: number;
  top: number;
  width: number;
  height: number;
  bubbleRight: number;
  bubbleTop: number;
  /** 上次是展开还是收起 */
  open: boolean;
}
export type FloatLayouts = Record<string, FloatLayout>;

export const FLOAT_MIN_WIDTH = 320;
export const FLOAT_MIN_HEIGHT = 420;
/** 离视口边缘至少留这么多 */
export const FLOAT_MARGIN = 8;
/** 拖到离边缘这么近时贴上去 */
export const FLOAT_SNAP = 24;
export const BUBBLE_SIZE = 50;

/** 第一次在这个网站上打开：贴右边、导航栏下面，高度不超过视口 */
export function defaultLayout(viewportWidth: number, viewportHeight: number): FloatLayout {
  const top = 72;
  return {
    right: 16, top,
    width: Math.min(380, viewportWidth - 2 * FLOAT_MARGIN),
    height: Math.max(FLOAT_MIN_HEIGHT, Math.min(640, viewportHeight - top - 16)),
    bubbleRight: 14,
    bubbleTop: Math.round(viewportHeight * 0.6),
    open: false,
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** 视口变小或者换了屏幕时，把窗口和圆钮挪回视口里；只用来显示，不改记下的位置 */
export function fitLayout(layout: FloatLayout, viewportWidth: number, viewportHeight: number): FloatLayout {
  const width = clamp(layout.width, FLOAT_MIN_WIDTH, viewportWidth - 2 * FLOAT_MARGIN);
  const height = clamp(layout.height, FLOAT_MIN_HEIGHT, viewportHeight - 2 * FLOAT_MARGIN);
  return {
    ...layout, width, height,
    right: clamp(layout.right, FLOAT_MARGIN, viewportWidth - width - FLOAT_MARGIN),
    top: clamp(layout.top, FLOAT_MARGIN, viewportHeight - height - FLOAT_MARGIN),
    bubbleRight: clamp(layout.bubbleRight, FLOAT_MARGIN, viewportWidth - BUBBLE_SIZE - FLOAT_MARGIN),
    bubbleTop: clamp(layout.bubbleTop, FLOAT_MARGIN, viewportHeight - BUBBLE_SIZE - FLOAT_MARGIN),
  };
}

/** 离边缘不到 FLOAT_SNAP 时贴到边上，high 是另一边能到的最远处 */
const snap = (value: number, high: number) => (value - FLOAT_MARGIN < FLOAT_SNAP ? FLOAT_MARGIN : high - value < FLOAT_SNAP ? high : value);

/** 拖动窗口：在视口里移动，离边缘不到 FLOAT_SNAP 时贴到边上 */
export function moveLayout(layout: FloatLayout, right: number, top: number, viewportWidth: number, viewportHeight: number): FloatLayout {
  const maxRight = viewportWidth - layout.width - FLOAT_MARGIN;
  const maxTop = viewportHeight - layout.height - FLOAT_MARGIN;
  return { ...layout, right: snap(clamp(right, FLOAT_MARGIN, maxRight), maxRight), top: snap(clamp(top, FLOAT_MARGIN, maxTop), maxTop) };
}

/** 拖动圆钮：放在视口里任意位置，靠近边缘时和窗口一样贴上去 */
export function moveBubble(layout: FloatLayout, right: number, top: number, viewportWidth: number, viewportHeight: number): FloatLayout {
  const maxRight = viewportWidth - BUBBLE_SIZE - FLOAT_MARGIN;
  const maxTop = viewportHeight - BUBBLE_SIZE - FLOAT_MARGIN;
  return { ...layout, bubbleRight: snap(clamp(right, FLOAT_MARGIN, maxRight), maxRight), bubbleTop: snap(clamp(top, FLOAT_MARGIN, maxTop), maxTop) };
}

/** 拖左下角调大小：右边和上边不动，往左下长 */
export function resizeLayout(layout: FloatLayout, width: number, height: number, viewportWidth: number, viewportHeight: number): FloatLayout {
  return {
    ...layout,
    width: clamp(width, FLOAT_MIN_WIDTH, viewportWidth - layout.right - FLOAT_MARGIN),
    height: clamp(height, FLOAT_MIN_HEIGHT, viewportHeight - layout.top - FLOAT_MARGIN),
  };
}

/** 悬浮窗里的面板发给外面内容脚本的消息（postMessage），外面按 event.source 认是不是自己的 iframe */
export const FRAME_SOURCE = 'acbuddy-float';
export type FrameMessage =
  /**
   * 按住顶栏开始拖：指针在 iframe 里的位置，ratio 是面板的 devicePixelRatio（缩放可能和题目页不同），外面换算成页面坐标。
   * 指针一出 iframe，事件就只到题目页了，所以之后的移动由外面在题目页上接着收
   */
  | { action: 'drag-start'; x: number; y: number; ratio: number }
  /** 在外面接手之前就松开了 */
  | { action: 'drag-end' }
  | { action: 'collapse' }
  /** 有没有正在进行的回答：收起时圆钮转圈，答完了加绿点 */
  | { action: 'status'; busy: boolean };

/** 后台和内容脚本之间的消息 */
export const FLOAT_STATE = 'FLOAT_STATE';
export const FLOAT_SAVE = 'FLOAT_SAVE';
export const FLOAT_MODE = 'FLOAT_MODE';
export const FLOAT_TOGGLE = 'FLOAT_TOGGLE';
export const FLOAT_OPEN = 'FLOAT_OPEN';
/** 侧边栏请后台在某个标签页上打开悬浮窗（内容脚本还没注入时后台补上） */
export const FLOAT_SHOW = 'FLOAT_SHOW';
