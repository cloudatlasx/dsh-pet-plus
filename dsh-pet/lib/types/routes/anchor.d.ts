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
/** 显示器工作区（CSS 像素，与 Electron screen 的 DIP 坐标同系）。 */
interface AnchorArea {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** 当前锚定屏（Helper 用）；测试可重置。 */
export declare function currentAnchorArea(): AnchorArea | null;
/** 重置锚定屏（仅供测试与进程内重载）。 */
export declare function resetAnchorArea(): void;
/** 锚定屏领域：未命中返回 undefined，命中返回应答。 */
export declare function handleAnchorRoutes(_deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined>;
export {};
