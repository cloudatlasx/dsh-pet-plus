/**
 * 任务路由：`GET /tasks` 列出 DSH 调度器里的定时任务，`POST /tasks/complete` 完成（删除）一条。
 *
 * 「完成」就是删除：DSH 的定时任务没有「已完成」这个状态，一次性任务跑完自然退场，
 * 周期任务只有「删掉」才算不再打扰。所以右键「任务」面板里的 ✓ 直接走 `schedule.delete`。
 *
 * 为什么不像 `storages/schedule.json` 那样改文件：调度器启动时把整张表读进内存，
 * 手改文件会被下一次投递回写覆盖。这里一律走服务，让调度器自己落盘并广播 `schedule/changed`。
 * @module dsh-pet/src/host/routes/tasks
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
/** 面板上一行任务需要的字段。 */
export interface TaskRow {
    id: string;
    title: string;
    kind: string;
    scheduledAt: string;
    status: string;
}
/** 任务领域：未命中返回 undefined，命中返回应答。 */
export declare function handleTaskRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined>;
