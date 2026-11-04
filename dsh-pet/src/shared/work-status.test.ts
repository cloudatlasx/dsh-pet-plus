/**
 * 工作状态叶子解析：`sessionId` 是新增的可选字段，老宿主不写、外部槽写 null。
 *
 * 只测解析边界——聚合与优先级归 host/work-status.test.ts。
 * 跑法：node --experimental-strip-types --test src/shared/work-status.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isWorkingState, progressLabel, todoPercent, todoProgressLabel, toWorkStatus } from './work-status.ts';

describe('toWorkStatus —— sessionId 解析', () => {
  test('带 sessionId → 原样保留，供点气泡跳会话', () => {
    const snap = toWorkStatus({ state: 'working', task: '改文件', sessionId: 'session-abc' });
    assert.equal(snap?.sessionId, 'session-abc');
  });

  test('缺字段 / null（老宿主或外部槽）→ null，气泡因此不可点', () => {
    assert.equal(toWorkStatus({ state: 'working', task: null })?.sessionId, null);
    assert.equal(toWorkStatus({ state: 'working', task: null, sessionId: null })?.sessionId, null);
  });

  test('空串 / 哨兵 unknown / 非字符串 → null（不让气泡跳到不存在的地方）', () => {
    for (const sessionId of ['', 'unknown', 42, {}, true]) {
      assert.equal(toWorkStatus({ state: 'working', task: null, sessionId })?.sessionId, null);
    }
  });

  test('空闲快照也带 sessionId: null', () => {
    assert.equal(toWorkStatus({ state: null, task: null })?.sessionId, null);
  });
});

describe('toWorkStatus —— 进度字段', () => {
  test('缺字段（老宿主）→ steps 0、startedAt null', () => {
    const snap = toWorkStatus({ state: 'working', task: '改文件' });
    assert.equal(snap?.steps, 0);
    assert.equal(snap?.startedAt, null);
  });

  test('steps 取整、非正数归零；startedAt 只认正数', () => {
    assert.equal(toWorkStatus({ state: 'working', task: null, steps: 3.7 })?.steps, 3);
    assert.equal(toWorkStatus({ state: 'working', task: null, steps: 0 })?.steps, 0);
    assert.equal(toWorkStatus({ state: 'working', task: null, steps: -2 })?.steps, 0);
    assert.equal(toWorkStatus({ state: 'working', task: null, steps: Number.NaN })?.steps, 0);
    assert.equal(toWorkStatus({ state: 'working', task: null, startedAt: 0 })?.startedAt, null);
    assert.equal(
      toWorkStatus({ state: 'working', task: null, startedAt: 1_700_000_000_000 })?.startedAt,
      1_700_000_000_000,
    );
  });
});

describe('progressLabel —— 第二行进度文案', () => {
  test('空闲 → 没有第二行', () => {
    assert.equal(progressLabel(toWorkStatus({ state: null, task: null })), null);
    assert.equal(progressLabel(null), null);
  });

  test('只有步数 / 只有时长 / 两者都有', () => {
    const startedAt = 1_700_000_000_000;
    assert.equal(progressLabel(toWorkStatus({ state: 'working', task: null, steps: 3 })), '第 3 步');
    assert.equal(
      progressLabel(toWorkStatus({ state: 'working', task: null, startedAt }), startedAt + 2 * 60_000),
      '已用 2 分钟',
    );
    assert.equal(
      progressLabel(toWorkStatus({ state: 'working', task: null, steps: 3, startedAt }), startedAt + 2 * 60_000),
      '第 3 步 · 已用 2 分钟',
    );
  });

  test('不足一分钟且没步数 → 不显示（别写「已用 0 分钟」）', () => {
    const startedAt = 1_700_000_000_000;
    assert.equal(progressLabel(toWorkStatus({ state: 'working', task: null, startedAt }), startedAt + 30_000), null);
  });
});

describe('todoPercent / todoProgressLabel —— 清单进度条', () => {
  test('百分比四舍五入、夹在 0–100', () => {
    assert.equal(todoPercent(toWorkStatus({ state: 'working', task: null, todoDone: 1, todoTotal: 3 })), 33);
    assert.equal(todoPercent(toWorkStatus({ state: 'working', task: null, todoDone: 3, todoTotal: 3 })), 100);
    assert.equal(todoPercent(toWorkStatus({ state: 'working', task: null, todoDone: 9, todoTotal: 3 })), 100);
  });

  test('没有清单 → null（前端因此不画条子）', () => {
    assert.equal(todoPercent(toWorkStatus({ state: 'working', task: null })), null);
    assert.equal(todoPercent(null), null);
    assert.equal(todoProgressLabel(toWorkStatus({ state: 'working', task: null })), null);
  });

  test('文案是「已完成/总数 项」', () => {
    assert.equal(
      todoProgressLabel(toWorkStatus({ state: 'working', task: null, todoDone: 4, todoTotal: 7 })),
      '4/7 项',
    );
    assert.equal(
      todoProgressLabel(toWorkStatus({ state: 'working', task: null, todoDone: 0, todoTotal: 7 })),
      '0/7 项',
    );
  });

  test('解析时 done 超过 total 收敛，非法值归零', () => {
    assert.equal(toWorkStatus({ state: 'working', todoDone: 9, todoTotal: 4 })?.todoDone, 4);
    assert.equal(toWorkStatus({ state: 'working', todoDone: -1, todoTotal: 4 })?.todoDone, 0);
    assert.equal(toWorkStatus({ state: 'working', todoDone: 3, todoTotal: 0 })?.todoDone, 0);
    assert.equal(toWorkStatus({ state: 'working', todoDone: 3, todoTotal: 0 })?.todoTotal, 0);
  });
});

describe('isWorkingState —— 「正忙着」的四档（随机链据此不许走开）', () => {
  test('思考 / 工作 / 整理 / 等审批 → true', () => {
    for (const state of ['thinking', 'working', 'result', 'waiting'] as const) {
      assert.equal(isWorkingState(state), true, `${state} 应该算在干活`);
    }
  });

  test('成功 / 出错 / 空闲 → false（终态该抬头报喜或报错，允许走动）', () => {
    for (const state of ['success', 'error', null, undefined] as const) {
      assert.equal(isWorkingState(state), false, `${String(state)} 不该拦住随机链`);
    }
  });
});
