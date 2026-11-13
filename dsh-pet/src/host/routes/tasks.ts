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
import { repeatLabel } from '../reminder-repeat.ts';
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
  /** 周期说法（`每个工作日 11:00`）；一次性的任务没有这一项。 */
  repeat?: string;
}

/** 对话提醒在任务面板里的 id 前缀：与 DSH 调度器的任务区分开，删除时才能走对分支。 */
export const PET_REMINDER_PREFIX = 'chat-';

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

/** 直接把宠物自己的闹钟折成面板行：它们的「下次时刻」不在 DSH 调度器里。 */
function reminderRows(deps: PetRouteDeps): TaskRow[] {
  return deps.reminders.list().map((item) => ({
    id: PET_REMINDER_PREFIX + item.id,
    title: item.title,
    kind: 'chat',
    scheduledAt: new Date(item.dueAt).toISOString(),
    status: 'active',
    ...(item.repeat === undefined ? {} : { repeat: repeatLabel(item.repeat) }),
  }));
}

/** 读调度器清单；失败折成结果对象，由调用方转成可展示的失败（不 throw 以免丢日志上下文）。 */
async function readCatalog(
  deps: PetRouteDeps,
  service: ScheduleService,
): Promise<{ ok: true; rows: unknown } | { ok: false; message: string }> {
  if (typeof service.catalog !== 'function') return { ok: true, rows: [] };
  try {
    return { ok: true, rows: await service.catalog() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn('dsh-pet: tasks/catalog failed: ' + message);
    return { ok: false, message };
  }
}

/** 任务领域：未命中返回 undefined，命中返回应答。 */
export async function handleTaskRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 正向判据：`scripts/check-openapi.mjs` 只收集正向的 rest 相等分支，写成反向守卫会被漏掉。
  if (input.rest === 'tasks') {
    if (input.method !== 'GET') return methodNotAllowed();
    const service = scheduleOf(deps);
    if (!service) return failResult('unsupported', 'DSH 的 schedule 服务不可用');
    const catalog = await readCatalog(deps, service);
    if (!catalog.ok) return failResult('internal-error', '读定时任务失败：' + catalog.message);
    // DSH 调度器的任务 + 宠物自己的闹钟：两套存储，面板上一起列
    return okResult({ ok: true, tasks: [...readRows(catalog.rows), ...reminderRows(deps)] });
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

    // 宠物自己的提醒：从闹钟里取消，不碰 DSH 调度器
    if (id.startsWith(PET_REMINDER_PREFIX)) {
      const cancelled = deps.reminders.cancel(id.slice(PET_REMINDER_PREFIX.length));
      if (!cancelled) return failResult('bad-request', '没有这条提醒：' + id);
      deps.log.info(`[dsh-pet] 任务面板取消提醒 ${id}`);
      return okResult({ ok: true });
    }

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
