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
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 调度服务的最小可用面（`optionalService('schedule')` 拿到的实测形状）。 */
interface ScheduleService {
  catalog?: () => Promise<unknown>;
  delete?: (request: Record<string, unknown>) => Promise<unknown>;
}

/** 面板上一行任务需要的字段。 */
export interface TaskRow {
  id: string;
  title: string;
  kind: string;
  scheduledAt: string;
  status: string;
}

/** 取一个修剪过的字符串；非字符串给空串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 把目录行收窄成面板能用的形状；缺 id 或标题的行直接丢。 */
function readRows(value: unknown): TaskRow[] {
  if (!Array.isArray(value)) return [];
  const out: TaskRow[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = textOf(row.id);
    const title = textOf(row.title);
    if (id === '' || title === '') continue;
    out.push({
      id,
      title,
      kind: textOf(row.kind),
      scheduledAt: textOf(row.scheduledAt),
      status: textOf(row.status),
    });
  }
  return out;
}

/** 取调度服务；不可用时给出可展示的失败。 */
function scheduleOf(deps: PetRouteDeps): ScheduleService | null {
  const service = deps.optionalService('schedule') as ScheduleService | undefined;
  if (!service) return null;
  return service;
}

/** 任务领域：未命中返回 undefined，命中返回应答。 */
export async function handleTaskRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 正向判据：`scripts/check-openapi.mjs` 只收集正向的 rest 相等分支，写成反向守卫会被漏掉。
  if (input.rest === 'tasks') {
    if (input.method !== 'GET') return methodNotAllowed();
    const service = scheduleOf(deps);
    if (!service || typeof service.catalog !== 'function') {
      return failResult('unsupported', 'DSH 的 schedule 服务不可用');
    }
    let rows: unknown;
    try {
      rows = await service.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: tasks/catalog failed: ' + message);
      return failResult('internal-error', '读定时任务失败：' + message);
    }
    return okResult({ ok: true, tasks: readRows(rows) });
  }

  if (input.rest === 'tasks/complete') {
    if (input.method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(input.body ?? 'null') as Record<string, unknown> | null;
    } catch {
      return invalidJson();
    }
    const id = textOf(parsed?.id);
    if (id === '') return failResult('bad-request', 'id 必填');

    const service = scheduleOf(deps);
    if (!service || typeof service.catalog !== 'function' || typeof service.delete !== 'function') {
      return failResult('unsupported', 'DSH 的 schedule 服务不可用');
    }

    let rows: unknown;
    try {
      rows = await service.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: tasks/catalog failed: ' + message);
      return failResult('internal-error', '读定时任务失败：' + message);
    }
    const row = Array.isArray(rows)
      ? (rows as Record<string, unknown>[]).find((item) => textOf(item.id) === id)
      : undefined;
    if (row === undefined) return failResult('bad-request', '没有这条任务：' + id);
    const sessionId = textOf(row.sessionId);
    if (sessionId === '') return failResult('bad-request', '这条任务没有会话绑定');

    let result: unknown;
    try {
      result = await service.delete({ sessionId, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: tasks/delete failed: ' + message);
      return failResult('internal-error', '完成任务失败：' + message);
    }
    const answer = (result ?? {}) as { deleted?: unknown; code?: unknown };
    if (answer.deleted !== true) {
      const code = textOf(answer.code);
      return failResult(
        'bad-request',
        code === 'schedule_not_found' ? '这条任务已经不在日程里了' : '调度器没有删掉这条任务',
      );
    }
    deps.log.info('[dsh-pet] 定时任务已完成 id=' + id);
    return okResult({ ok: true, id });
  }

  return undefined;
}
