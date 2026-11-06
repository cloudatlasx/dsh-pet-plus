/**
 * `/reminder/close` 对待办提醒的语义：点「知道了」= 这件事办完了。
 *
 * 不勾掉的话，逾期待办会按 30 分钟档一直重弹——用户点了几次它还在催，
 * 看起来就是「点了没反应」。这里钉住两个方向：待办提醒会勾掉，其它提醒绝不动待办。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequestRoutes } from './requests.ts';
import type { PetRouteDeps } from './types.ts';

/** 只满足 reminder/close 分支的依赖：section 里挂着一条给定提醒，外加一个记账的待办表。 */
function harness(
  reminder: Record<string, unknown> | null,
  options: { updateResult?: unknown; todos?: unknown[] } = {},
) {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const writes: { name: string; data: unknown }[] = [];
  let current = reminder;
  const deps = {
    state: {
      read: () => ({ sections: { reminder: { counter: 1, data: current } } }),
      writeSection: (name: string, data: unknown) => {
        writes.push({ name, data });
        current = data as Record<string, unknown>;
      },
      waiterCount: () => 1,
    },
    todos: {
      list: async () => options.todos ?? [],
      update: async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        return options.updateResult === undefined ? { id, ...patch } : options.updateResult;
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    userRoot: 'C:/tmp/dsh-pet-test',
  } as unknown as PetRouteDeps;
  const call = (body: unknown) =>
    handleRequestRoutes(deps, {
      url: new URL('http://127.0.0.1/dsh-pet-7340/reminder/close'),
      rest: 'reminder/close',
      method: 'POST',
      body: JSON.stringify(body),
    });
  return { patches, writes, call };
}

const todoReminder = {
  id: 'todo-todo-1-1793945689436',
  kind: 'todo',
  ts: 1_700_000_000_000,
  title: '过渡动画自检',
  hint: '点「知道了」就是办完了',
  ttlMs: 300_000,
  ref: 'todo-1',
};

describe('POST /reminder/close —— 「知道了」对待办就是办完了', () => {
  test('待办提醒：勾掉待办，回包带 todoDone', async () => {
    const { patches, writes, call } = harness(todoReminder);
    const body = (await call({ id: todoReminder.id })) as { obj: { ok: boolean; todoDone?: string } };
    assert.equal(body.obj.ok, true);
    assert.equal(body.obj.todoDone, 'todo-1');
    assert.deepEqual(patches, [{ id: 'todo-1', patch: { done: true } }]);
    const closed = writes[0]?.data as { closed?: boolean; kind?: string } | undefined;
    assert.equal(writes[0]?.name, 'reminder');
    assert.equal(closed?.closed, true, '气泡照样收起');
    assert.equal(closed?.kind, 'announce', '收起信封信封类型不变（原逻辑如此）');
  });

  test('非待办提醒：不碰待办表', async () => {
    const { patches, call } = harness({ ...todoReminder, kind: 'schedule', ref: 'todo-1' });
    const body = (await call({ id: todoReminder.id })) as { obj: { ok: boolean; todoDone?: string } };
    assert.equal(body.obj.ok, true);
    assert.equal(body.obj.todoDone, undefined);
    assert.deepEqual(patches, []);
  });

  test('待办已经被删了：update 返回 null 时不报 todoDone，气泡仍然收起', async () => {
    const { writes, call } = harness(todoReminder, { updateResult: null });
    const body = (await call({ id: todoReminder.id })) as { obj: { ok: boolean; todoDone?: string } };
    assert.equal(body.obj.ok, true);
    assert.equal(body.obj.todoDone, undefined, '没勾掉就不该说勾掉了');
    const closed = writes[0]?.data as { closed?: boolean } | undefined;
    assert.equal(closed?.closed, true, '气泡照样收起，不然会卡在屏幕上');
  });

  test('id 必填', async () => {
    const { call } = harness(todoReminder);
    const body = (await call({})) as { obj: { ok: boolean; message?: string } };
    assert.equal(body.obj.ok, false);
    assert.match(String(body.obj.message), /id 必填/);
  });

  test('老信封没带 ref：按标题认领那条未完成的待办', async () => {
    const old: Record<string, unknown> = { ...todoReminder };
    delete old.ref;
    const todos = [
      { id: 'todo-old', text: '过渡动画自检', dueAt: 1_700_000_000_000, done: false },
      { id: 'todo-done', text: '过渡动画自检', dueAt: 1_700_000_000_000, done: true },
    ];
    const { patches, call } = harness(old, { todos });
    const body = (await call({ id: todoReminder.id })) as { obj: { ok: boolean; todoDone?: string } };
    assert.equal(body.obj.todoDone, 'todo-old', '只认未完成的那条');
    assert.deepEqual(patches, [{ id: 'todo-old', patch: { done: true } }]);
  });

  test('老信封对不上任何待办：只收气泡，不乱勾', async () => {
    const old: Record<string, unknown> = { ...todoReminder };
    delete old.ref;
    const todos = [{ id: 'todo-other', text: '别的事情', dueAt: null, done: false }];
    const { patches, writes, call } = harness(old, { todos });
    const body = (await call({ id: todoReminder.id })) as { obj: { ok: boolean; todoDone?: string } };
    assert.equal(body.obj.todoDone, undefined);
    assert.deepEqual(patches, []);
    assert.equal((writes[0]?.data as { closed?: boolean } | undefined)?.closed, true);
  });
});
