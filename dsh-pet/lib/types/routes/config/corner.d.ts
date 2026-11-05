import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
/** 四个角落的合法取值；顺序即双击循环的顺序。 */
export declare const CORNER_CYCLE: readonly ["top-left", "top-right", "bottom-right", "bottom-left"];
/**
 * 写回一只宠物的角落，并返回写后的成品聚合。
 *
 * @param deps - 路由层依赖（路径、轮询快照）。
 * @param input - 已解析的请求（方法、请求体 `{pet, corner}`）。
 * @returns 写后的成品聚合（与 GET /config 同一份），或失败实体。
 */
export declare function savePetCorner(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult>;
