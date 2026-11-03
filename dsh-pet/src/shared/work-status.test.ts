/**
 * 工作状态叶子解析：`sessionId` 是新增的可选字段，老宿主不写、外部槽写 null。
 *
 * 只测解析边界——聚合与优先级归 host/work-status.test.ts。
 * 跑法：node --experimental-strip-types --test src/shared/work-status.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { progressLabel, toWorkStatus } from './work-status.ts';

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
