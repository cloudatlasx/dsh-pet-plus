/**
 * 拍一拍规格单测：钉住「阈值围绕五/十抖动但仍有序」「躲的时长落在 1~5 分钟且偏短」
 * 「台词尽量不连着重复」「四组台词从条目配置收窄」。
 *
 * 纯逻辑，无 IO。跑法：node --experimental-strip-types --test src/shared/pat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAT_ANNOYED_BASE,
  PAT_BUSY_SAY_MS,
  PAT_HIDE_GAP_MS,
  PAT_HIDE_MAX_MS,
  PAT_HIDE_MIN_MS,
  PAT_RESET_MS,
  PAT_SAY_MS,
  PAT_SHY_BASE,
  hideDuration,
  patTextsOf,
  patTier,
  pickPatText,
  planPats,
  type PatPlan,
} from './pat.ts';

/** 依次吐出给定数值的随机源；用光后回落到最后一个。 */
function rolls(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('planPats —— 每轮阈值都抖动，但三档不会互相挤没', () => {
  test('随机源固定时给出确定的一轮：娇羞上界 4~6、生气点 9~12', () => {
    // 第一次 roll = 1 → +1；第二次 roll = 1（>=0.5）→ 正号；两次都加，得到上界
    const plan = planPats(rolls([1, 1]));
    assert.equal(plan.shyUntil, PAT_SHY_BASE + 1);
    assert.ok(plan.annoyedUntil >= PAT_ANNOYED_BASE);
  });

  test('娇羞上界永远在 4~6、生气点永远 9~12，且生气点至少比娇羞大 3', () => {
    for (const a of [0, 0.25, 0.5, 0.99, 1]) {
      for (const b of [0, 0.25, 0.5, 0.99, 1]) {
        const plan = planPats(rolls([a, b]));
        assert.ok(plan.shyUntil >= 2 && plan.shyUntil <= 6, `shyUntil=${plan.shyUntil}`);
        assert.ok(plan.annoyedUntil >= 9 && plan.annoyedUntil <= 12, `annoyedUntil=${plan.annoyedUntil}`);
        assert.ok(plan.annoyedUntil >= plan.shyUntil + 3, '中间那档必须留得下');
      }
    }
  });
});

describe('patTier —— 第 N 次落在哪一档', () => {
  const plan: PatPlan = { shyUntil: 5, annoyedUntil: 10 };

  test('上界含在档内，越过才升档', () => {
    assert.equal(patTier(1, plan), 'shy');
    assert.equal(patTier(5, plan), 'shy');
    assert.equal(patTier(6, plan), 'annoyed');
    assert.equal(patTier(10, plan), 'annoyed');
    assert.equal(patTier(11, plan), 'angry');
  });
});

describe('hideDuration —— 1~5 分钟，偏短', () => {
  test('落在区间内且两端可达', () => {
    assert.equal(
      hideDuration(() => 0),
      PAT_HIDE_MIN_MS,
    );
    assert.equal(
      hideDuration(() => 1),
      PAT_HIDE_MAX_MS,
    );
    for (const r of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const ms = hideDuration(() => r);
      assert.ok(ms >= PAT_HIDE_MIN_MS && ms <= PAT_HIDE_MAX_MS, `ms=${ms}`);
    }
  });

  test('同样中点靠前的随机值偏短（roll^1.6 不是均匀分布）', () => {
    const uniform = (PAT_HIDE_MIN_MS + PAT_HIDE_MAX_MS) / 2;
    assert.ok(hideDuration(() => 0.5) < uniform, '一半概率对应不到一半时长');
  });
});

describe('pickPatText —— 尽量不连着说同一句', () => {
  test('池空返回 undefined，单句池只能重复', () => {
    assert.equal(pickPatText([]), undefined);
    assert.equal(pickPatText(['只有一句'], '只有一句'), '只有一句');
  });

  test('多句池会排除上一句', () => {
    const pool = ['A', 'B', 'C'];
    // 随便抽多少次，都不会等于 last
    for (const r of [0, 0.34, 0.67, 0.99]) {
      assert.notEqual(
        pickPatText(pool, 'A', () => r),
        'A',
      );
    }
  });

  test('随机值贴近 1 时取池子最后一句而不是越界', () => {
    assert.equal(
      pickPatText(['A', 'B', 'C'], '', () => 1),
      'C',
    );
  });
});

describe('patTextsOf —— 条目配置收窄', () => {
  test('五组都读出来，非字符串项被丢掉', () => {
    const texts = patTextsOf({
      patShyTexts: ['呀', 3, '', '别戳'],
      patAnnoyedTexts: ['哼'],
      patAngryTexts: ['生气了'],
      patBackTexts: ['我回来了'],
      patBusyTexts: ['我在忙'],
    });
    assert.deepEqual(texts, {
      shy: ['呀', '别戳'],
      annoyed: ['哼'],
      angry: ['生气了'],
      back: ['我回来了'],
      busy: ['我在忙'],
    });
  });

  test('整段缺失就是空池（代码里不抄默认文案，默认值在 assets/config.jsonc）', () => {
    assert.deepEqual(patTextsOf({}), {
      shy: [],
      annoyed: [],
      angry: [],
      back: [],
      busy: [],
    });
  });
});

describe('常量口径', () => {
  test('气泡停留时间随生气程度递增，计数的作废时间是一段安静的时长', () => {
    assert.ok(PAT_SAY_MS.shy < PAT_SAY_MS.annoyed);
    assert.ok(PAT_SAY_MS.annoyed < PAT_SAY_MS.angry);
    assert.equal(PAT_RESET_MS, 3 * 60 * 1000);
  });

  test('先说再消失：消失前留一段空档，干活时那句更短', () => {
    assert.ok(PAT_HIDE_GAP_MS > 0);
    assert.ok(PAT_BUSY_SAY_MS < PAT_SAY_MS.angry, '忙的时候别把台词挂太久');
  });
});
