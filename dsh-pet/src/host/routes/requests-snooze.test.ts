/**
 * 「等会儿」的查找范围：`/announce` 记过的提醒走 `recentReminders`，对话里约的提醒由
 * `pet-reminders` 直接写 section、不进那张表——这里钉住后者也能被延后，否则按钮点下去
 * 只会得到一句 unknown reminder，看起来就是「没反应」。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequestRoutes } from './requests.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 只满足 /reminder/snooze 分支的依赖：section 里挂着一条给定的提醒。 */
function harness(reminder: Record<string, unknown> | null) {
  const writes: { name: string; data: unknown }[] = [];
  let current: Record<string, unknown> | null = reminder;
  const deps = {
    state: {
      read: () => ({ sections: { reminder: { counter: 1, data: current } } }),
      writeSection: (name: string, data: unknown) => {
        writes.push({ name, data });
        current = data as Record<string, unknown>;
      },
      waiterCount: () => 1,
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    userRoot: 'C:/tmp/dsh-pet-test',
  } as unknown as PetRouteDeps;
  const call = (body: unknown) =>
    handleRequestRoutes(deps, {
      url: new URL('http://127.0.0.1/dsh-pet-7340/reminder/snooze'),
      rest: 'reminder/snooze',
      method: 'POST',
      body: JSON.stringify(body),
    } as RouteInput);
  return { writes, call };
}

/** 对话里约的那种提醒（kind='chat'、没有 sessionId）。 */
const chatReminder = {
  id: 'chat-abc',
  kind: 'chat',
  ts: 1_700_000_000_000,
  title: '拿快递',
  hint: '到点啦',
  ttlMs: 180_000,
};

describe('POST /reminder/snooze —— 能延后当前气泡上的提醒', () => {
  test('对话里约的提醒（不在 recentReminders 里）也能延后，而不是 unknown reminder', async () => {
    const { writes, call } = harness(chatReminder);
    const result = await call({ id: 'chat-abc', minutes: 0.01 });
    const body = (result as { obj: { ok: boolean; reason?: string; snoozeMs?: number } }).obj;
    assert.equal(body.ok, true, '不该再是 unknown reminder');
    assert.equal(body.reason, undefined);
    assert.equal(body.snoozeMs, 600);
    const closed = writes[0]?.data as { id?: string; kind?: string; closed?: boolean } | undefined;
    assert.equal(writes[0]?.name, 'reminder', '写回的是提醒 section');
    assert.equal(closed?.id, 'chat-abc', '收起的就是这一条');
    assert.equal(closed?.kind, 'chat', 'kind 原样保留，徽标不会跳成定时任务');
    assert.equal(closed?.closed, true, '先把气泡收起来');
  });

  test('id 对不上就照旧拒绝，不拿别的气泡顶替', async () => {
    const { call } = harness(chatReminder);
    const result = await call({ id: 'chat-other', minutes: 15 });
    const body = (result as { obj: { ok: boolean; message?: string } }).obj;
    assert.equal(body.ok, false);
    assert.match(body.message ?? '', /unknown reminder/);
  });

  test('气泡已经被收起（closed）时不再接受延后', async () => {
    const { call } = harness({ ...chatReminder, closed: true });
    const result = await call({ id: 'chat-abc', minutes: 15 });
    assert.equal((result as { obj: { ok: boolean } }).obj.ok, false);
  });
});
