/**
 * 周期提醒的纯逻辑测试 —— 钉住「每个工作日 11 点」这类说法的三件事：
 *   ① 认得出周期与钟点（用户原话与模型标记的第三段都走同一套）；
 *   ② 下一次触发对齐到整分、跳过周末、严格晚于现在；
 *   ③ 模型漏写提醒标记时，只在「周期 + 钟点 + 提醒动词」三件套齐全时才兜底补一条。
 *
 * 跑法：node --experimental-strip-types --test src/host/reminder-repeat.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRepeat,
  inferRepeatReminder,
  nextOccurrence,
  repeatAt,
  repeatKindOf,
  repeatLabel,
  repeatOf,
} from './reminder-repeat.ts';

/** 2026-11-13（周五）16:51 本地时间：与用户报这次问题时刻一致，周末跳转才看得见。 */
const FRIDAY = new Date(2026, 10, 13, 16, 51, 0, 0).getTime();

describe('repeatKindOf —— 认出周期说法', () => {
  test('每个工作日 / 每工作日 / 周一到周五', () => {
    assert.deepEqual(repeatKindOf('每个工作日提醒我'), { kind: 'weekday' });
    assert.deepEqual(repeatKindOf('每工作日 11 点'), { kind: 'weekday' });
    assert.deepEqual(repeatKindOf('周一到周五都要'), { kind: 'weekday' });
  });

  test('每天 / 每日 / 每晚', () => {
    assert.deepEqual(repeatKindOf('每天 11 点'), { kind: 'daily' });
    assert.deepEqual(repeatKindOf('每日提醒'), { kind: 'daily' });
  });

  test('每周三 → weekly 且带星期数字', () => {
    assert.deepEqual(repeatKindOf('每周三下午'), { kind: 'weekly', weekday: 3 });
    assert.deepEqual(repeatKindOf('每个礼拜天'), { kind: 'weekly', weekday: 0 });
  });

  test('没有周期说法返回 null', () => {
    assert.equal(repeatKindOf('两分钟后提醒我开会'), null);
  });
});

describe('repeatOf —— 周期 + 钟点', () => {
  test('每个工作日的 11 点', () => {
    assert.deepEqual(repeatOf('每个工作日的11点提醒我点外卖'), { kind: 'weekday', hour: 11, minute: 0 });
  });

  test('冒号形式与十二小时制', () => {
    assert.deepEqual(repeatOf('每天 11:30 提醒我喝水'), { kind: 'daily', hour: 11, minute: 30 });
    assert.deepEqual(repeatOf('每天晚上八点提醒我吃药'), { kind: 'daily', hour: 20, minute: 0 });
  });

  test('只有周期没有钟点时返回 null（没法排期）', () => {
    assert.equal(repeatOf('每个工作日都提醒我'), null);
  });
});

describe('nextOccurrence —— 下一次触发', () => {
  test('周五 16:51 求「每个工作日 11:00」→ 下周一 11:00（跳过周末）', () => {
    const repeat = { kind: 'weekday' as const, hour: 11, minute: 0 };
    const next = nextOccurrence(repeat, FRIDAY);
    const at = new Date(next);
    assert.equal(at.getDay(), 1);
    assert.equal(at.getHours(), 11);
    assert.equal(at.getMinutes(), 0);
    assert.equal(at.getSeconds(), 0);
    // 周五 16:51 → 周一 11:00 是 66 小时 9 分
    assert.equal((next - FRIDAY) / 3600000, 66.15);
  });

  test('同一天还没到点就用今天', () => {
    const repeat = { kind: 'daily' as const, hour: 18, minute: 30 };
    const next = nextOccurrence(repeat, FRIDAY);
    const at = new Date(next);
    assert.equal(at.getDate(), 13);
    assert.equal(at.getHours(), 18);
  });

  test('刚好就是这一刻时排下一天，不会原地重复', () => {
    const at1100 = new Date(2026, 10, 16, 11, 0, 0, 0).getTime();
    const repeat = { kind: 'weekday' as const, hour: 11, minute: 0 };
    const next = nextOccurrence(repeat, at1100);
    assert.equal(new Date(next).getDate(), 17);
  });

  test('每周三：从周五数到下一个周三', () => {
    const repeat = { kind: 'weekly' as const, hour: 9, minute: 0, weekday: 3 };
    const next = nextOccurrence(repeat, FRIDAY);
    assert.equal(new Date(next).getDay(), 3);
  });
});

describe('repeatLabel 与 repeatAt', () => {
  test('人话标签', () => {
    assert.equal(repeatLabel({ kind: 'weekday', hour: 11, minute: 0 }), '每个工作日 11:00');
    assert.equal(repeatLabel({ kind: 'daily', hour: 8, minute: 5 }), '每天 08:05');
    assert.equal(repeatLabel({ kind: 'weekly', hour: 9, minute: 0, weekday: 3 }), '周三 09:00');
  });

  test('标记里只有种类时，从到点时刻取时分', () => {
    const at = new Date(2026, 10, 16, 11, 0, 0, 0).getTime();
    assert.deepEqual(repeatAt({ kind: 'weekday' }, at), { kind: 'weekday', hour: 11, minute: 0 });
  });
});

describe('inferRepeatReminder —— 模型漏写标记时的兜底', () => {
  test('周期 + 钟点 + 提醒动词齐全时补一条', () => {
    const inferred = inferRepeatReminder('每个工作日11点提醒我点外卖', FRIDAY);
    assert.notEqual(inferred, null);
    assert.equal(inferred?.title, '点外卖');
    assert.deepEqual(inferred?.repeat, { kind: 'weekday', hour: 11, minute: 0 });
    assert.equal(inferred?.seconds, 238140);
  });

  test('没有提醒动词时不当成请求（避免凭空造打扰）', () => {
    assert.equal(inferRepeatReminder('每个工作日11点我都点外卖', FRIDAY), null);
  });

  test('没有钟点时补不了', () => {
    assert.equal(inferRepeatReminder('每个工作日提醒我点外卖', FRIDAY), null);
  });
});

describe('applyRepeat —— 用原话规则覆盖模型算的秒数', () => {
  test('模型算成 66 小时 8 分 51 秒，按原话对齐到周一 11:00 整', () => {
    const merged = applyRepeat('点外卖', 238131, '每个工作日的11点提醒我点外卖', FRIDAY);
    assert.equal(merged.seconds, 238140);
    assert.deepEqual(merged.repeat, { kind: 'weekday', hour: 11, minute: 0 });
  });

  test('原话没提周期时原样返回', () => {
    const merged = applyRepeat('开会', 120, '两分钟后提醒我开会', FRIDAY);
    assert.equal(merged.seconds, 120);
    assert.equal(merged.repeat, undefined);
  });
});
