/**
 * 对话弹窗的落点：宠物贴哪边，弹窗就朝另一边长，别把自己盖在宠物身上、也别伸出屏幕。
 *
 * 只做纯计算，不碰 DOM：调用方量好「宠物矩形 / 弹窗尺寸 / 允许占用的矩形」再喂进来，
 * 结果直接写进 `left` / `top`。桌面端与浏览器端共用同一份判断。
 * @module dsh-pet/src/shared/chat/place
 */

/** 视口（或窗口）局部坐标里的矩形。 */
export interface PlaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 落点与选中的一侧。 */
export interface PlaceResult {
  x: number;
  y: number;
  /** 弹窗在宠物的哪一侧：贴右边缘的宠物会得到 `left`。 */
  side: 'left' | 'right';
}

/** 夹回区间；区间非法（高/宽不够）时退到左/上边界，别吐 NaN 或负数。 */
function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}

/**
 * 在宠物旁边挑一侧放弹窗。
 *
 * - 横向上**优先朝空间更大的那边**（宠物在右半屏就往左长，反之往右），
 *   首选那侧塞不下、另一侧塞得下时换边；两边都塞不下才夹回边界（宁可压住宠物也别出屏）。
 * - 纵向上：宠物在下半屏时弹窗底边对齐宠物脚底（向上长），否则顶边对齐宠物头顶。
 * - 最后整体夹进 `bounds`，四条边各留 `pad` 的呼吸位。
 *
 * @param anchor - 宠物（命中区）矩形。
 * @param tip - 弹窗当前尺寸。
 * @param bounds - 允许占用的矩形（浏览器视口 / 桌面「窗口 ∩ 工作区」）。
 * @param gap - 宠物与弹窗之间的间距。
 * @param pad - 与 bounds 四边的最小距离。
 * @returns 弹窗左上角落点与选中的一侧。
 */
export function placeBeside(
  anchor: PlaceRect,
  tip: { w: number; h: number },
  bounds: PlaceRect,
  gap = 10,
  pad = 4,
): PlaceResult {
  // 宠物在右半屏就往左长、反之往右：这一侧的空间一定不小于另一侧，所以不用再考虑「换边」。
  // 两边都塞不下时仍听这一侧，靠最后的夹取保证不出屏（宁可压住宠物）。
  const side: 'left' | 'right' = anchor.x + anchor.w / 2 > bounds.x + bounds.w / 2 ? 'left' : 'right';
  const x = side === 'left' ? anchor.x - gap - tip.w : anchor.x + anchor.w + gap;
  const lowerHalf = anchor.y + anchor.h / 2 > bounds.y + bounds.h / 2;
  const rawY = lowerHalf ? anchor.y + anchor.h - tip.h : anchor.y;
  return {
    x: clamp(x, bounds.x + pad, bounds.x + bounds.w - tip.w - pad),
    y: clamp(rawY, bounds.y + pad, bounds.y + bounds.h - tip.h - pad),
    side,
  };
}
