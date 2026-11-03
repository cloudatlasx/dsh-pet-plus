/**
 * 锚定屏路由：浏览器半侧上报「自己窗口所在显示器的工作区」。
 *
 * 桌面宠物默认摆在这块屏的右下角（多屏时跟随 DSH 窗口，而不是永远主屏）。
 * 只做协议与形状校验，不判断显示拓扑：上报值原样保存，桌面 Helper 取用时再换算成视口坐标。
 * 内存态、不落盘：DSH 重启后由浏览器半侧重新上报，缺省时 Helper 回落到主屏。
 * @module dsh-pet/src/host/routes/anchor
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 显示器工作区（CSS 像素，与 Electron screen 的 DIP 坐标同系）。 */
interface AnchorArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

let anchor: AnchorArea | null = null;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 校验并收窄上报体：缺字段/非数字/非正尺寸一律拒绝，绝不保存半成品。 */
function readAnchor(value: unknown): AnchorArea | null {
  if (value === null || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!finite(body.x) || !finite(body.y) || !finite(body.width) || !finite(body.height)) return null;
  if (body.width <= 0 || body.height <= 0) return null;
  return { x: body.x, y: body.y, width: body.width, height: body.height };
}

/** 当前锚定屏（Helper 用）；测试可重置。 */
export function currentAnchorArea(): AnchorArea | null {
  return anchor;
}

/** 重置锚定屏（仅供测试与进程内重载）。 */
export function resetAnchorArea(): void {
  anchor = null;
}

/** 锚定屏领域：未命中返回 undefined，命中返回应答。 */
export async function handleAnchorRoutes(_deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest !== 'anchor') return undefined;
  if (input.method === 'GET') return okResult({ area: anchor });

  if (input.method !== 'POST') return methodNotAllowed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body ?? 'null');
  } catch {
    return invalidJson();
  }
  const next = readAnchor(parsed);
  if (next === null) return failResult('bad-request', 'anchor area must be four finite numbers with positive size');
  anchor = next;
  return okResult({ ok: true });
}
