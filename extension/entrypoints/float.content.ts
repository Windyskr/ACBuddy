import {
  defaultLayout, fitLayout, FLOAT_MODE, FLOAT_OPEN, FLOAT_SAVE, FLOAT_SITES, FLOAT_STATE, FLOAT_TOGGLE, FRAME_SOURCE,
  moveBubble, moveLayout, resizeLayout, type DisplayMode, type FloatLayout, type FrameMessage,
} from './lib/display';
import { problemOf } from './lib/platforms';

// 悬浮窗模式：在题目页上画一个可以拖动、调大小、收起的窗口，里面是侧边栏同一个页面（iframe）。
// 收起时只是藏起来，iframe 还在，回答照常进行。位置和大小按网站分开记，存在后台

const STYLE = `
:host { all: initial; }
.window { position: fixed; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;
  box-shadow: 0 16px 48px rgb(15 23 42 / .22), 0 2px 6px rgb(15 23 42 / .08); }
[hidden] { display: none !important; }
.grip { flex: none; display: grid; place-items: center; height: 10px; cursor: grab; touch-action: none; }
.grip::before { content: ""; width: 32px; height: 4px; border-radius: 2px; background: #cbd5e1; }
.window.moving, .window.moving .grip { cursor: grabbing; }
.body { flex: 1; min-height: 0; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; color-scheme: light; }
.window.moving iframe { pointer-events: none; }
.resize { position: absolute; left: 0; bottom: 0; width: 18px; height: 18px; cursor: nesw-resize; touch-action: none; }
.resize::before { content: ""; position: absolute; left: 4px; bottom: 4px; width: 7px; height: 7px; box-sizing: border-box;
  border-left: 2px solid #94a3b8; border-bottom: 2px solid #94a3b8; border-bottom-left-radius: 2px; opacity: .7; }
.bubble { position: fixed; box-sizing: border-box; width: 50px; height: 50px; padding: 0; border: 2px solid #fff; border-radius: 50%;
  background: #fff center 34% / 128% no-repeat; cursor: pointer; touch-action: none;
  box-shadow: 0 6px 20px rgb(15 23 42 / .24), 0 0 0 1px rgb(15 23 42 / .06); }
.bubble:focus-visible { outline: 2px solid #358614; outline-offset: 3px; }
.dot { position: absolute; top: -1px; right: -1px; box-sizing: border-box; width: 13px; height: 13px; border: 2px solid #fff; border-radius: 50%; background: #22c55e; }
.bubble.busy::after { content: ""; position: absolute; inset: -6px; border: 2.5px solid transparent; border-radius: 50%;
  border-top-color: #358614; border-right-color: #358614; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bubble.busy::after { animation-duration: 4s; } }
`;

interface Ui {
  root: HTMLElement;
  panel: HTMLDivElement;
  body: HTMLDivElement;
  bubble: HTMLButtonElement;
  dot: HTMLSpanElement;
  frame: HTMLIFrameElement | null;
}

/** 一次拖动：起点是拖之前看到的位置，scale 把指针的位移换成页面的 CSS 像素 */
interface Drag { move(x: number, y: number): void; end(): void }

export default defineContentScript({
  matches: [...FLOAT_SITES],
  main() {
    // 插件装好之前就开着的标签页，后台会补注入一次；已经有了就不再画一遍
    const scope = globalThis as { __acbFloat?: boolean };
    if (scope.__acbFloat) return;
    scope.__acbFloat = true;

    let mode: DisplayMode = 'sidepanel';
    let layout: FloatLayout = defaultLayout(innerWidth, innerHeight);
    let ui: Ui | null = null;
    let drag: Drag | null = null;
    let busy = false;
    let unread = false;
    let href = location.href;

    const onProblemPage = () => problemOf(location.href) != null;
    const save = () => void chrome.runtime.sendMessage({ type: FLOAT_SAVE, layout }).catch(() => {});

    const render = () => {
      if (!ui) return;
      const shown = mode === 'float' && onProblemPage();
      const fitted = fitLayout(layout, innerWidth, innerHeight);
      ui.panel.hidden = !shown || !layout.open;
      ui.bubble.hidden = !shown || layout.open;
      Object.assign(ui.panel.style, { right: `${fitted.right}px`, top: `${fitted.top}px`, width: `${fitted.width}px`, height: `${fitted.height}px` });
      Object.assign(ui.bubble.style, { right: `${fitted.bubbleRight}px`, top: `${fitted.bubbleTop}px` });
      ui.bubble.classList.toggle('busy', busy);
      ui.bubble.setAttribute('aria-label', busy ? 'ACBuddy 正在回答，展开查看' : unread ? 'ACBuddy 回答好了，展开查看' : '展开 ACBuddy');
      ui.dot.hidden = !unread;
    };

    /** 从拖之前看到的位置开始移动窗口。拖动时关掉 iframe 的指针事件，免得指针滑进 iframe 就断了 */
    const startMove = (x: number, y: number): Drag => {
      const origin = fitLayout(layout, innerWidth, innerHeight);
      ui?.panel.classList.add('moving');
      return {
        move(nextX, nextY) {
          layout = moveLayout(origin, origin.right - (nextX - x), origin.top + (nextY - y), innerWidth, innerHeight);
          render();
        },
        end() {
          ui?.panel.classList.remove('moving');
          save();
        },
      };
    };

    /** 指针按下到松开，交给 handlers；按住时指针移到 iframe 上也收得到 */
    const track = (element: HTMLElement, begin: (event: PointerEvent) => Drag | null) => {
      element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const current = begin(event);
        if (!current) return;
        event.preventDefault();
        // 脚本合成的指针事件没有真的指针，抓不住也照常拖
        try { element.setPointerCapture(event.pointerId); } catch { /* 没有可抓的指针 */ }
        const move = (next: PointerEvent) => current.move(next.clientX, next.clientY);
        const stop = () => {
          element.removeEventListener('pointermove', move);
          element.removeEventListener('pointerup', stop);
          element.removeEventListener('pointercancel', stop);
          current.end();
        };
        element.addEventListener('pointermove', move);
        element.addEventListener('pointerup', stop);
        element.addEventListener('pointercancel', stop);
      });
    };

    const createUi = (): Ui => {
      const root = document.createElement('acbuddy-float');
      root.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
      const shadow = root.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${STYLE}</style>
        <div class="window" hidden><div class="grip" title="拖动"></div><div class="body"></div><div class="resize" title="调整大小"></div></div>
        <button type="button" class="bubble" hidden><span class="dot" hidden></span></button>`;
      const panel = shadow.querySelector<HTMLDivElement>('.window')!;
      const bubble = shadow.querySelector<HTMLButtonElement>('.bubble')!;
      bubble.style.backgroundImage = `url("${chrome.runtime.getURL('/icons/bubble.png')}")`;
      document.documentElement.append(root);
      const created: Ui = { root, panel, body: shadow.querySelector<HTMLDivElement>('.body')!, bubble, dot: shadow.querySelector<HTMLSpanElement>('.dot')!, frame: null };

      track(shadow.querySelector<HTMLDivElement>('.grip')!, (event) => startMove(event.clientX, event.clientY));
      track(shadow.querySelector<HTMLDivElement>('.resize')!, (event) => {
        const origin = fitLayout(layout, innerWidth, innerHeight);
        panel.classList.add('moving');
        return {
          move(x, y) {
            layout = resizeLayout(origin, origin.width - (x - event.clientX), origin.height + (y - event.clientY), innerWidth, innerHeight);
            render();
          },
          end() {
            panel.classList.remove('moving');
            save();
          },
        };
      });
      // 圆钮：拖到哪里都行，没拖动就是点击（键盘的回车和空格也走 click）。拖完松手时浏览器会补一次点击，那次不算
      let draggedAt = 0;
      track(bubble, (event) => {
        let dragged = false;
        const origin = fitLayout(layout, innerWidth, innerHeight);
        return {
          move(x, y) {
            if (!dragged && Math.hypot(x - event.clientX, y - event.clientY) < 4) return;
            dragged = true;
            // 起点用看到的位置，窗口那几项照记下的留着，拖圆钮不该改窗口大小
            layout = moveBubble(layout, origin.bubbleRight - (x - event.clientX), origin.bubbleTop + (y - event.clientY), innerWidth, innerHeight);
            render();
          },
          end() {
            if (!dragged) return;
            draggedAt = Date.now();
            save();
          },
        };
      });
      bubble.addEventListener('click', () => {
        if (Date.now() - draggedAt > 300) expand();
      });
      return created;
    };

    const ensureUi = () => (ui ??= createUi());

    /** persist：用户点开的要记下来；按上次的状态恢复时不用 */
    function expand(persist = true) {
      const current = ensureUi();
      if (!current.frame) {
        // 收起时只是藏起来，iframe 一直留着，回答照常进行
        const frame = document.createElement('iframe');
        frame.title = 'ACBuddy';
        frame.allow = 'clipboard-write';
        frame.src = `${chrome.runtime.getURL('/sidepanel.html')}?mode=float`;
        current.body.append(frame);
        current.frame = frame;
      }
      unread = false;
      layout = { ...layout, open: true };
      render();
      if (persist) save();
    }

    function collapse() {
      layout = { ...layout, open: false };
      render();
      save();
    }

    const destroy = () => {
      ui?.root.remove();
      ui = null;
      busy = false;
      unread = false;
    };

    const apply = (next: DisplayMode) => {
      mode = next;
      if (mode !== 'float') destroy();
      else if (onProblemPage()) {
        ensureUi();
        if (layout.open) expand(false);
        else render();
      } else render();
    };

    /**
     * 面板里按住了顶栏：换算成页面坐标，之后在题目页上收指针事件来移动。拖动时 iframe 不接指针事件，
     * 指针滑过窗口也落在页面上；松开或者发现按键已经松开就结束
     */
    const dragFromFrame = (x: number, y: number, ratio: number) => {
      endDrag();
      const rect = ui!.frame!.getBoundingClientRect();
      const scale = ratio / devicePixelRatio;
      const current = startMove(rect.left + x * scale, rect.top + y * scale);
      const move = (event: PointerEvent) => {
        if (event.buttons === 0) endDrag();
        else current.move(event.clientX, event.clientY);
      };
      const stop = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', endDrag, true);
        removeEventListener('pointercancel', endDrag, true);
        current.end();
      };
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', endDrag, true);
      addEventListener('pointercancel', endDrag, true);
      drag = { move: current.move, end: stop };
    };
    function endDrag() {
      const current = drag;
      drag = null;
      current?.end();
    }

    // 悬浮窗里的面板发来的消息：拖顶栏、收起、有没有正在进行的回答
    window.addEventListener('message', (event) => {
      if (!ui?.frame || event.source !== ui.frame.contentWindow) return;
      const data = event.data as (FrameMessage & { source?: string }) | null;
      if (data?.source !== FRAME_SOURCE) return;
      if (data.action === 'drag-start') dragFromFrame(data.x, data.y, data.ratio);
      else if (data.action === 'drag-end') endDrag();
      else if (data.action === 'collapse') collapse();
      else if (data.action === 'status') {
        if (busy && !data.busy && !layout.open) unread = true;
        busy = data.busy;
        render();
      }
    });

    // 先从后台拿到模式和这个网站记下的位置，再处理工具栏图标和侧边栏发来的指令
    const ready = chrome.runtime.sendMessage({ type: FLOAT_STATE }).then((state: { mode?: DisplayMode; layout?: FloatLayout | null } | undefined) => {
      if (state?.layout) layout = state.layout;
      apply(state?.mode ?? 'sidepanel');
    }).catch(() => {});

    chrome.runtime.onMessage.addListener((message: { type?: string; mode?: DisplayMode }, _sender, sendResponse) => {
      if (message?.type === FLOAT_MODE && message.mode) {
        void ready.then(() => apply(message.mode!));
        return;
      }
      if (message?.type !== FLOAT_TOGGLE && message?.type !== FLOAT_OPEN) return;
      void ready.then(() => {
        mode = 'float';
        if (message.type === FLOAT_TOGGLE && layout.open && ui && !ui.panel.hidden) collapse();
        else expand();
        sendResponse({ ok: true });
      });
      return true;
    });

    addEventListener('resize', render);
    // 站内换页不刷新（力扣切题、去题库），每秒看一次地址，离开题目页就藏起来
    setInterval(() => {
      if (document.visibilityState !== 'visible' || location.href === href) return;
      href = location.href;
      if (mode === 'float') apply(mode);
    }, 1000);
  },
});
