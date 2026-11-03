/**
 * 锚定屏上报：把自己窗口所在显示器的工作区告诉宿主。
 *
 * 桌面宠物默认摆在这块屏的右下角（多屏时跟随 DSH 窗口，而不是永远主屏）。
 * 只读 window.screen 的四个 avail* 值——它们就是该显示器工作区（DIP），
 * 与 Electron 主进程的 screen 坐标同系；浏览器半侧拿得到，宿主与 Helper 拿不到。
 *
 * 上报时机：挂载时一次、之后每 5 秒比对一次、窗口获得焦点或尺寸变化时再比一次；
 * 值没变不发请求，避免多屏切换之外的无效轮询。
 * @module dsh-pet/src/client/anchor-report
 */
import { ROUTE_PATH } from '../shared/constants.ts';
import { postAction } from '../shared/state.ts';

/** 上报体：工作区四元组（CSS 像素），windowX/Y 只用于排障。 */
interface AnchorPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  windowX: number;
  windowY: number;
}

const REPORT_INTERVAL_MS = 5000;

function readScreen(): AnchorPayload | null {
  if (window.screen === undefined) return null;
  // 四个 avail* 是 CSSOM Screen 的可选成员（Chromium 都有，lib.dom 的类型里没写全）
  const screen = window.screen as Screen & {
    availLeft?: number;
    availTop?: number;
  };
  const { availLeft, availTop, availWidth, availHeight } = screen;
  if (typeof availLeft !== 'number' || typeof availTop !== 'number') return null;
  if (!Number.isFinite(availLeft) || !Number.isFinite(availTop)) return null;
  if (!Number.isFinite(availWidth) || !Number.isFinite(availHeight)) return null;
  if (availWidth <= 0 || availHeight <= 0) return null;
  return {
    x: Math.round(availLeft),
    y: Math.round(availTop),
    width: Math.round(availWidth),
    height: Math.round(availHeight),
    windowX: Math.round(window.screenX),
    windowY: Math.round(window.screenY),
  };
}

/** 开始上报，返回清理函数（交给 ctx.effect 的返回值）。 */
export function startAnchorReport(): () => void {
  let last = '';

  const tick = (): void => {
    const area = readScreen();
    if (area === null) return;
    const key = `${area.x},${area.y},${area.width},${area.height}`;
    if (key === last) return;
    last = key;
    void postAction(`${ROUTE_PATH}/anchor`, area);
  };

  tick();
  const timer = setInterval(tick, REPORT_INTERVAL_MS);
  window.addEventListener('focus', tick);
  window.addEventListener('resize', tick);

  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', tick);
    window.removeEventListener('resize', tick);
  };
}
