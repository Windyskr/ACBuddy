import { describe, expect, it } from 'vitest';
import { BUBBLE_SIZE, defaultLayout, fitLayout, FLOAT_MARGIN, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, moveBubble, moveLayout, resizeLayout } from './display';

const VW = 1440;
const VH = 900;

describe('floating window layout', () => {
  it('starts at the right, under the site header, and fits a small screen', () => {
    expect(defaultLayout(VW, VH)).toEqual({ right: 16, top: 72, width: 380, height: 640, bubbleRight: 14, bubbleTop: 540, open: false });
    const small = defaultLayout(360, 500);
    expect(small.width).toBe(344);
    expect(small.height).toBe(FLOAT_MIN_HEIGHT);
  });
  it('keeps a remembered layout inside a smaller viewport without changing what was saved', () => {
    const saved = { right: 900, top: 600, width: 500, height: 700, bubbleRight: 1300, bubbleTop: 880, open: true };
    const fitted = fitLayout(saved, 1024, 768);
    expect(fitted.width).toBe(500);
    expect(fitted.height).toBe(700);
    expect(fitted.right).toBe(1024 - 500 - FLOAT_MARGIN);
    expect(fitted.top).toBe(768 - 700 - FLOAT_MARGIN);
    // 视口比窗口还矮：窗口缩到放得下
    expect(fitLayout(saved, 1024, 600).height).toBe(600 - 2 * FLOAT_MARGIN);
    expect(fitted.bubbleRight).toBe(1024 - BUBBLE_SIZE - FLOAT_MARGIN);
    expect(fitted.bubbleTop).toBe(768 - BUBBLE_SIZE - FLOAT_MARGIN);
    expect(saved.right).toBe(900);
  });
  it('moves within the viewport and snaps to an edge when dragged close to it', () => {
    const start = defaultLayout(VW, VH);
    expect(moveLayout(start, 300, 200, VW, VH)).toMatchObject({ right: 300, top: 200 });
    // 离右边不到 24 像素：贴到右边
    expect(moveLayout(start, 20, 200, VW, VH).right).toBe(FLOAT_MARGIN);
    // 拖出视口：停在边上
    expect(moveLayout(start, -500, -500, VW, VH)).toMatchObject({ right: FLOAT_MARGIN, top: FLOAT_MARGIN });
    const maxRight = VW - start.width - FLOAT_MARGIN;
    expect(moveLayout(start, maxRight - 10, 200, VW, VH).right).toBe(maxRight);
    expect(moveLayout(start, 5000, 5000, VW, VH)).toMatchObject({ right: maxRight, top: VH - start.height - FLOAT_MARGIN });
  });
  it('puts the bubble anywhere in the viewport, snapping to an edge like the window', () => {
    const start = defaultLayout(VW, VH);
    // 拖到页面中间：两个方向都照放，窗口的位置不动
    expect(moveBubble(start, 700, 300, VW, VH)).toMatchObject({ bubbleRight: 700, bubbleTop: 300, right: start.right, top: start.top });
    const maxRight = VW - BUBBLE_SIZE - FLOAT_MARGIN;
    const maxTop = VH - BUBBLE_SIZE - FLOAT_MARGIN;
    // 靠近左边和顶上：贴过去
    expect(moveBubble(start, maxRight - 10, 20, VW, VH)).toMatchObject({ bubbleRight: maxRight, bubbleTop: FLOAT_MARGIN });
    // 拖出视口：停在角上
    expect(moveBubble(start, -300, 5000, VW, VH)).toMatchObject({ bubbleRight: FLOAT_MARGIN, bubbleTop: maxTop });
  });
  it('resizes towards the bottom left, keeping the right and top edges, within limits', () => {
    const start = { ...defaultLayout(VW, VH), right: 16, top: 72 };
    expect(resizeLayout(start, 520, 700, VW, VH)).toMatchObject({ right: 16, top: 72, width: 520, height: 700 });
    expect(resizeLayout(start, 100, 100, VW, VH)).toMatchObject({ width: FLOAT_MIN_WIDTH, height: FLOAT_MIN_HEIGHT });
    expect(resizeLayout(start, 5000, 5000, VW, VH)).toMatchObject({ width: VW - 16 - FLOAT_MARGIN, height: VH - 72 - FLOAT_MARGIN });
  });
});
