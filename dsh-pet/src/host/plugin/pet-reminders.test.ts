/**
 * 对话提醒的闹钟存储测试：排期、落盘、过期丢弃、没有端在线时不吞也不空转。
 *
 * 时间一律由 `now` 注入；到点这件事通过 `tick()` 显式驱动，测试不睡真实时间。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/pet-reminders.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPetReminderStore,
  MAX_PENDING_REMINDERS,
  MISS_GRACE_MS,
  REMINDERS_FILE_NAME,
  type PetReminder,
} from './pet-reminders.ts';

/** 固定时钟（可推进）。 */
function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** 一拍用的最小替身：记录写入口。 */
function harness(options: { hasClient?: boolean; start?: number } = {}) {
  const time = clock(options.start);
  const writes: Array<{ section: string; data: unknown }> = [];
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-reminders-'));
  const store = createPetReminderStore({
    state: { writeSection: (section: string, data: unknown) => writes.push({ section, data }) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    userRoot: dir,
    now: time.now,
    hasClient: () => options.hasClient ?? true,
  });
  return { store, writes, time, dir, file: join(dir, REMINDERS_FILE_NAME) };
}

/** 等某个文件出现（写盘是异步的，测试不猜时间）。 */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      readFileSync(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`等不到文件：${path}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** 从写进 S 的记录里挑出提醒气泡。 */
function remindersOf(writes: Array<{ section: string; data: unknown }>): Array<Record<string, unknown>> {
  return writes
    .filter((w) => w.section === 'reminder')
    .map((w) => w.data as Record<string, unknown>)
    .filter((r) => r.closed !== true);
}

describe('createPetReminderStore —— 排期与取消', () => {
  test('排一条：到点时刻 = 现在 + 秒数，列表按到点升序', () => {
    const { store, time, dir } = harness();
    const a = store.schedule('main', '开会', 120);
    time.advance(1000);
    const b = store.schedule('main', '喝水', 60);
    assert.equal(a.dueAt, a.createdAt + 120_000);
    assert.deepEqual(
      store.list().map((r) => r.title),
      ['喝水', '开会'],
    );
    assert.equal(b.petId, 'main');
    rmSync(dir, { recursive: true, force: true });
  });

  test('取消命中的那条；没命中返回 false', () => {
    const { store, dir } = harness();
    const item = store.schedule('main', '开会', 120);
    assert.equal(store.cancel('不存在'), false);
    assert.equal(store.cancel(item.id), true);
    assert.deepEqual(store.list(), []);
    rmSync(dir, { recursive: true, force: true });
  });

  test('超过上限时顶掉最早到点的那条', () => {
    const { store, dir } = harness();
    for (let i = 0; i < MAX_PENDING_REMINDERS + 3; i++) store.schedule('main', '第' + i + '条', 60 + i);
    assert.equal(store.list().length, MAX_PENDING_REMINDERS);
    // 最早的（60s）先出局，最新的还在
    assert.equal(store.list()[0]?.title, '第3条');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createPetReminderStore —— 到点与落盘', () => {
  test('到点：写成 kind=chat 的提醒气泡，并从待发表里摘掉', () => {
    const { store, writes, time, dir } = harness();
    const item = store.schedule('main', '开会', 60);
    time.advance(60_000);
    store.tick();
    const bubbles = remindersOf(writes);
    assert.equal(bubbles.length, 1);
    assert.equal(bubbles[0]?.id, 'chat-' + item.id);
    assert.equal(bubbles[0]?.kind, 'chat');
    assert.equal(bubbles[0]?.title, '开会');
    assert.equal(bubbles[0]?.hint, '到点啦');
    assert.deepEqual(store.list(), []);
    rmSync(dir, { recursive: true, force: true });
  });

  test('迟到超过一分钟：提示里点明本来该几点', () => {
    const { store, writes, time, dir } = harness();
    store.schedule('main', '开会', 60);
    time.advance(60_000 + 5 * 60_000);
    store.tick();
    const hint = String(remindersOf(writes)[0]?.hint ?? '');
    assert.match(hint, /本来 \d{2}:\d{2} 就该提醒你的/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('没有端在线：不写气泡、也不丢这条（等端回来再弹）', () => {
    const { store, writes, time, dir } = harness({ hasClient: false });
    store.schedule('main', '开会', 60);
    time.advance(60_000);
    store.tick();
    assert.equal(remindersOf(writes).length, 0);
    assert.equal(store.list().length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('排一条就落盘；重载后待发提醒还在', async () => {
    const { store, time, dir, file } = harness();
    store.schedule('main', '开会', 600);
    await waitForFile(file);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as PetReminder[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.title, '开会');

    const reloaded = createPetReminderStore({
      state: { writeSection: () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      userRoot: dir,
      now: time.now,
    });
    await reloaded.load();
    assert.deepEqual(
      reloaded.list().map((r) => r.title),
      ['开会'],
    );
    reloaded.dispose();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test('过期太久的丢弃，没过期的留着', async () => {
    const { time, dir, file } = harness();
    const now = time.now();
    const rows: PetReminder[] = [
      { id: 'old', petId: 'main', title: '昨天的会', dueAt: now - MISS_GRACE_MS - 1000, createdAt: now },
      { id: 'new', petId: 'main', title: '十分钟后的会', dueAt: now + 10 * 60_000, createdAt: now },
    ];
    writeFileSync(file, JSON.stringify(rows), 'utf8');
    const store = createPetReminderStore({
      state: { writeSection: () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      userRoot: dir,
      now: time.now,
    });
    await store.load();
    assert.deepEqual(
      store.list().map((r) => r.id),
      ['new'],
    );
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test('坏文件按空处理，不抛', async () => {
    const { dir, file, time } = harness();
    writeFileSync(file, '{ 不是数组', 'utf8');
    const store = createPetReminderStore({
      state: { writeSection: () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      userRoot: dir,
      now: time.now,
    });
    await store.load();
    assert.deepEqual(store.list(), []);
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** 「每个工作日 11:00」——这次用户报的那条。 */
const WEEKDAY_11 = { kind: 'weekday' as const, hour: 11, minute: 0 };

describe('createPetReminderStore —— 周期提醒', () => {
  test('排期对齐到整分：10:59:31 排「每个工作日 11:00」→ 今天 11:00:00', () => {
    const start = new Date(2026, 10, 16, 10, 59, 31, 0).getTime();
    const { store, dir } = harness({ start });
    const item = store.schedule('main', '点外卖', 60, WEEKDAY_11);
    assert.equal(item.dueAt, new Date(2026, 10, 16, 11, 0, 0, 0).getTime());
    assert.deepEqual(item.repeat, WEEKDAY_11);
    // 不是 createdAt + 60s，那个数字只是模型的估算
    assert.notEqual(item.dueAt, item.createdAt + 60_000);
    rmSync(dir, { recursive: true, force: true });
  });

  test('周五下午排「每个工作日 11:00」→ 周一 11:00（跳过周末）', () => {
    const start = new Date(2026, 10, 13, 16, 51, 0, 0).getTime();
    const { store, dir } = harness({ start });
    const item = store.schedule('main', '点外卖', 60, WEEKDAY_11);
    const at = new Date(item.dueAt);
    assert.equal(at.getDay(), 1);
    assert.equal(at.getHours(), 11);
    assert.equal(at.getMinutes(), 0);
    assert.equal(at.getSeconds(), 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('响过之后不摘，推进到下一天同一时刻；提示里写明周期', () => {
    const start = new Date(2026, 10, 16, 10, 59, 31, 0).getTime();
    const { store, writes, time, dir } = harness({ start });
    const item = store.schedule('main', '点外卖', 60, WEEKDAY_11);
    time.advance(29_000); // → 11:00:00
    store.tick();
    const bubbles = remindersOf(writes);
    assert.equal(bubbles.length, 1);
    assert.equal(bubbles[0]?.id, 'chat-' + item.id);
    assert.match(String(bubbles[0]?.hint ?? ''), /每个工作日 11:00/);
    const left = store.list();
    assert.equal(left.length, 1);
    assert.equal(left[0]?.id, item.id);
    assert.equal(left[0]?.dueAt, new Date(2026, 10, 17, 11, 0, 0, 0).getTime());
    rmSync(dir, { recursive: true, force: true });
  });

  test('再响一次仍然只有一条，不会越排越多', () => {
    const start = new Date(2026, 10, 16, 10, 59, 31, 0).getTime();
    const { store, time, dir } = harness({ start });
    store.schedule('main', '点外卖', 60, WEEKDAY_11);
    time.advance(29_000);
    store.tick();
    time.advance(24 * 3600 * 1000); // 第二天 11:00
    store.tick();
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.dueAt, new Date(2026, 10, 18, 11, 0, 0, 0).getTime());
    rmSync(dir, { recursive: true, force: true });
  });

  test('load：周期项错过很久也推进到下一次，而不是像一次性那样丢掉', async () => {
    const start = new Date(2026, 10, 16, 9, 0, 0, 0).getTime();
    const { dir, file, time } = harness({ start });
    // 一个月前那条「每个工作日 11:00」，正常实现里早该被丢弃
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'old-repeat',
          petId: 'main',
          title: '点外卖',
          dueAt: new Date(2026, 9, 16, 11, 0, 0, 0).getTime(),
          createdAt: new Date(2026, 9, 16, 10, 0, 0, 0).getTime(),
          repeat: WEEKDAY_11,
        },
      ]),
      'utf8',
    );
    const store = createPetReminderStore({
      state: { writeSection: () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      userRoot: dir,
      now: time.now,
    });
    await store.load();
    const rows = store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.dueAt, new Date(2026, 10, 16, 11, 0, 0, 0).getTime());
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test('坏 repeat 数据当一次性：照常到点弹出并按一次性摘掉', async () => {
    const start = new Date(2026, 10, 16, 10, 59, 0, 0).getTime();
    const { store, writes, time, dir, file } = harness({ start });
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'bad',
          petId: 'main',
          title: '开会',
          dueAt: start + 60_000,
          createdAt: start,
          repeat: { kind: 'hourly' },
        },
      ]),
      'utf8',
    );
    await store.load();
    time.advance(60_000);
    store.tick();
    assert.equal(remindersOf(writes).length, 1);
    assert.deepEqual(store.list(), []);
    rmSync(dir, { recursive: true, force: true });
  });
});
