/**
 * 定时任务编辑路由：`POST /schedule/patch` 改一条 DSH 定时任务的标题或提示词。
 *
 * 为什么不直接改 `storages/schedule.json`：调度器启动时把整张表读进内存，之后只写不回读，
 * 手改文件会被下一次投递回写覆盖。所以这里走 `ctx.schedule.update`，让调度器自己落盘并广播
 * `schedule/changed`——顺便兼容它要求的「预期记录」乐观并发。
 * @module dsh-pet/src/host/routes/schedule
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
/** 定时任务领域：未命中返回 undefined，命中返回应答。 */
export declare function handleScheduleRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined>;
