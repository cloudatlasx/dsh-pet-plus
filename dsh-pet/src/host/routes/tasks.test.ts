/**
 * 任务路由的单元测试 —— 钉住「右键任务面板」背后那条链路：
 *   ① `GET /tasks` 把调度器目录收窄成面板能用的行，坏行直接丢；
 *   ② `POST /tasks/complete` 一定要按 catalog 里的 sessionId 去 delete（删错会话等于没删）；
 *   ③ 服务缺失、id 不存在、调度器拒删都要给出可展示的失败，而不是静默 200。
 *
 * 不覆盖真实 HTTP 管道：读体、写响应在宿主层，见 src/host/routes.test.ts。
 * 跑法：node --experimental-strip-types --test src/host/routes/tasks.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleTaskRoutes } from './tasks.ts';
import type { PetRouteDeps } from './types.ts';
import type { RouteResult } from '../http.ts';
import type { PetReminder } from '../plugin/pet-reminders.ts';

interface Row {
  id: string;
  title: string;
  kind: string;
  scheduledAt: string;
  status: string;
  sessionId: string;
}

/** 只满足任务路由的依赖：一个可编程的假调度器 + 一个内存里的提醒表。 */
function harness(options: {
  rows?: Row[];
  service?: { catalog?: () => Promise<unknown>; delete?: (request: Record<string, unknown>) => Promise<unknown> };
  noService?: boolean;
  reminders?: PetReminder[];
}) {
  const deleted: Record<string, unknown>[] = [];
  const rows = options.rows ?? [];
  const service = options.service ?? {
    catalog: async () => rows,
    delete: async (request: Record<string, unknown>) => {
      deleted.push(request);
      return { id: request.id, deleted: true };
    },
  };
  const logs: string[] = [];
  let pendingReminders = [...(options.reminders ?? [])];
  const deps = {
    optionalService: (name: string) => (options.noService ? undefined : name === 'schedule' ? service : undefined),
    reminders: {
      list: () => pendingReminders,
      cancel: (id: string) => {
        const before = pendingReminders.length;
        pendingReminders = pendingReminders.filter((row) => row.id !== id);
        return pendingReminders.length < before;
      },
    },
    log: {
      info: (line: string) => logs.push(line),
      warn: (line: string) => logs.push(line),
    },
  } as unknown as PetRouteDeps;
  const call = (method: string, rest: string, body?: unknown): Promise<RouteResult | undefined> =>
    handleTaskRoutes(deps, {
      url: new URL('http://127.0.0.1/dsh-pet-7340/tasks'),
      rest,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, deleted, logs };
}

/** 断言是 JSON 应答并取出状态码与响应体。 */
function asJson(result: RouteResult | undefined): { status: number; obj: Record<string, unknown> } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'json');
  return { status: result.status, obj: result.obj as Record<string, unknown> };
}

const row = (patch: Partial<Row> = {}): Row => ({
  id: 's-1',
  title: '禅道今日待办',
  kind: 'weekly',
  scheduledAt: '2026-11-07T00:50:00.000Z',
  status: 'active',
  sessionId: 'session-1',
  ...patch,
});

describe('handleTaskRoutes —— 路径归属', () => {
  test('非 tasks 前缀 → undefined（交给下一个处理器）', async () => {
    const { call } = harness({});
    assert.equal(await call('GET', 'todos'), undefined);
    assert.equal(await call('GET', 'tasksomething'), undefined);
  });

  test('方法不对 → 405', async () => {
    const { call } = harness({});
    assert.equal(asJson(await call('POST', 'tasks')).status, 405);
    assert.equal(asJson(await call('GET', 'tasks/complete')).status, 405);
  });
});

describe('handleTaskRoutes —— GET /tasks', () => {
  test('目录行收窄成五个字段，多余的 sessionId 不外泄', async () => {
    const { call } = harness({ rows: [row(), row({ id: 's-2', title: '  填日志  ' })] });
    const { status, obj } = asJson(await call('GET', 'tasks'));
    assert.equal(status, 200);
    assert.deepEqual(obj.tasks, [
      {
        id: 's-1',
        title: '禅道今日待办',
        kind: 'weekly',
        scheduledAt: '2026-11-07T00:50:00.000Z',
        status: 'active',
      },
      { id: 's-2', title: '填日志', kind: 'weekly', scheduledAt: '2026-11-07T00:50:00.000Z', status: 'active' },
    ]);
  });

  test('缺 id 或标题的行直接丢掉，不把空行画到面板上', async () => {
    const { call } = harness({ rows: [row({ id: '' }), row({ title: '   ' }), row({ id: 's-3' })] });
    const { obj } = asJson(await call('GET', 'tasks'));
    assert.deepEqual(
      (obj.tasks as Row[]).map((item) => item.id),
      ['s-3'],
    );
  });

  test('调度服务不可用 → 可展示的失败（200 + ok:false）', async () => {
    const { call } = harness({ noService: true });
    const { status, obj } = asJson(await call('GET', 'tasks'));
    assert.equal(status, 200);
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /schedule 服务不可用/);
  });

  test('目录读失败 → internal-error，并记一条 warn', async () => {
    const { call, logs } = harness({
      service: {
        catalog: async () => {
          throw new Error('catalog down');
        },
        delete: async () => ({ deleted: true }),
      },
    });
    const { obj } = asJson(await call('GET', 'tasks'));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /读定时任务失败/);
    assert.match(logs.join('\n'), /catalog down/);
  });
});

describe('handleTaskRoutes —— POST /tasks/complete', () => {
  test('按目录里的 sessionId 删除，成功返回 id 并记日志', async () => {
    const { call, deleted, logs } = harness({ rows: [row()] });
    const { status, obj } = asJson(await call('POST', 'tasks/complete', { id: 's-1' }));
    assert.equal(status, 200);
    assert.deepEqual(obj, { ok: true, id: 's-1' });
    assert.deepEqual(deleted, [{ sessionId: 'session-1', id: 's-1' }]);
    assert.match(logs.join('\n'), /定时任务已完成 id=s-1/);
  });

  test('id 必填', async () => {
    const { call } = harness({ rows: [row()] });
    const { obj } = asJson(await call('POST', 'tasks/complete', {}));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /id 必填/);
  });

  test('目录里没有这条 → 失败且不发 delete', async () => {
    const { call, deleted } = harness({ rows: [row()] });
    const { obj } = asJson(await call('POST', 'tasks/complete', { id: 's-404' }));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /没有这条任务/);
    assert.deepEqual(deleted, []);
  });

  test('调度器说 schedule_not_found → 换成用户听得懂的话', async () => {
    const { call } = harness({
      rows: [row()],
      service: {
        catalog: async () => [row()],
        delete: async () => ({ id: 's-1', deleted: false, code: 'schedule_not_found' }),
      },
    });
    const { obj } = asJson(await call('POST', 'tasks/complete', { id: 's-1' }));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /已经不在日程里/);
  });

  test('行里没有 sessionId → 明确失败（不能猜一个会话去删）', async () => {
    const { call, deleted } = harness({ rows: [row({ sessionId: '' })] });
    const { obj } = asJson(await call('POST', 'tasks/complete', { id: 's-1' }));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /没有会话绑定/);
    assert.deepEqual(deleted, []);
  });

  test('宠物自己的提醒（chat- 前缀）→ 取消闹钟，不碰 DSH 调度器', async () => {
    const reminder: PetReminder = {
      id: 'r-1',
      petId: 'main',
      title: '点外卖',
      dueAt: Date.now() + 60_000,
      createdAt: Date.now(),
      repeat: { kind: 'weekday', hour: 11, minute: 0 },
    };
    const { call, deleted, logs } = harness({ reminders: [reminder] });
    const { obj } = asJson(await call('POST', 'tasks/complete', { id: 'chat-r-1' }));
    assert.deepEqual(obj, { ok: true });
    assert.deepEqual(deleted, []);
    assert.match(logs.join('\n'), /任务面板取消提醒 chat-r-1/);
  });

  test('取消一条不存在的宠物提醒 → 失败', async () => {
    const { call } = harness({});
    const { obj } = asJson(await call('POST', 'tasks/complete', { id: 'chat-nope' }));
    assert.equal(obj.ok, false);
    assert.match(String(obj.message), /没有这条提醒/);
  });
});

describe('handleTaskRoutes —— GET /tasks 里的周期提醒', () => {
  test('宠物闹钟折成一行 chat 任务，带周期说法', async () => {
    const reminder: PetReminder = {
      id: 'r-1',
      petId: 'main',
      title: '点外卖',
      dueAt: Date.parse('2026-11-16T03:00:00.000Z'),
      createdAt: Date.parse('2026-11-13T08:51:00.000Z'),
      repeat: { kind: 'weekday', hour: 11, minute: 0 },
    };
    const { call } = harness({ rows: [row()], reminders: [reminder] });
    const { obj } = asJson(await call('GET', 'tasks'));
    const tasks = obj.tasks as Array<Record<string, unknown>>;
    const found = tasks.find((item) => item.id === 'chat-r-1');
    assert.equal(found?.kind, 'chat');
    assert.equal(found?.repeat, '每个工作日 11:00');
    assert.equal(found?.scheduledAt, '2026-11-16T03:00:00.000Z');
  });
});
