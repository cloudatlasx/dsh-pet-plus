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
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 提示词上限：够写一整套流程，又不至于把日程文件撑坏。 */
const MAX_PROMPT_CHARS = 12000;
/** 标题上限。 */
const MAX_TITLE_CHARS = 120;

/** 调度服务的最小可用面（`optionalService('schedule')` 拿到的实测形状）。 */
interface ScheduleService {
  catalog?: () => Promise<unknown>;
  update?: (request: Record<string, unknown>) => Promise<unknown>;
}

/** 目录行里由调度器附加、不属于记录本身的字段。 */
const ROW_ONLY = new Set(['sessionId', 'status', 'lastDelivery', 'deliveryHistory']);

/** 取一个修剪过的字符串；非字符串给空串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 编辑请求里能改的两种内容。 */
interface Patch {
  id: string;
  title?: string;
  prompt?: string;
}

/** 解析 `{id,title?,prompt?}`；缺 id 或缺内容都算坏请求。 */
function readPatch(body: string | undefined): Patch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? 'null');
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const id = textOf(obj.id);
  if (id === '') return null;
  const title = textOf(obj.title);
  const prompt = textOf(obj.prompt);
  if (title === '' && prompt === '') return null;
  if (prompt.length > MAX_PROMPT_CHARS) return null;
  return {
    id,
    ...(title === ''
      ? {}
      : { title: title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS - 1) + '…' : title }),
    ...(prompt === '' ? {} : { prompt }),
  };
}

/** 定时任务领域：未命中返回 undefined，命中返回应答。 */
export async function handleScheduleRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 正向判据：`scripts/check-openapi.mjs` 只收集正向的 rest 相等分支，写成反向守卫会被漏掉。
  if (input.rest === 'schedule/patch') {
    if (input.method !== 'POST') return methodNotAllowed();

    const patch = readPatch(input.body);
    if (patch === null) return failResult('bad-request', 'body 需要 {id, title?|prompt?}');

    const service = deps.optionalService('schedule') as ScheduleService | undefined;
    if (!service || typeof service.catalog !== 'function' || typeof service.update !== 'function') {
      return failResult('unsupported', 'DSH 的 schedule 服务不可用');
    }

    let rows: unknown;
    try {
      rows = await service.catalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: schedule/catalog failed: ' + message);
      return failResult('internal-error', '读定时任务失败：' + message);
    }
    const row = Array.isArray(rows)
      ? (rows as Record<string, unknown>[]).find((item) => textOf(item.id) === patch.id)
      : undefined;
    if (row === undefined) return failResult('bad-request', '没有这条定时任务：' + patch.id);

    const sessionId = textOf(row.sessionId);
    if (sessionId === '') return failResult('bad-request', '这条定时任务没有会话绑定');

    // 乐观并发要求「预期记录」是完整的那条记录，检索行把绑定与投递状态摘出来单独放。
    const expected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) if (!ROW_ONLY.has(key)) expected[key] = value;

    let result: unknown;
    try {
      result = await service.update({ sessionId, expected, ...patch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: schedule/update failed: ' + message);
      return failResult('internal-error', '改定时任务失败：' + message);
    }

    const answer = (result ?? {}) as { updated?: unknown; code?: unknown; message?: unknown };
    if (answer.updated !== true) {
      const code = textOf(answer.code);
      const message = textOf(answer.message);
      return failResult(
        'bad-request',
        message !== '' ? message : code !== '' ? '调度器拒绝了这次修改：' + code : '调度器没有接受这次修改',
      );
    }
    return okResult({ ok: true, id: patch.id });
  }
  return undefined;
}
