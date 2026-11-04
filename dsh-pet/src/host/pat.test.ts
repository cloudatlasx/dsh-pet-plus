/**
 * 拍一拍状态机单测：钉住「连拍升档、气到躲起来写 hidden 叶子、到点自己回来补一句、
 * 躲着时迟到上报不重复反应、安静够久重新从娇羞数起」。
 *
 * 计时器用很短的注入值（20ms）真实等待，不 mock setTimeout。
 * 跑法：node --experimental-strip-types --test src/host/pat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PatStore, type HiddenLeafData } from './pat.ts';
import type { PatTexts } from '../shared/pat.ts';

const TEXTS: PatTexts = {
  shy: ['呀…！', '别戳我啦…'],
  annoyed: ['有完没完呀。'],
  angry: ['我真的生气了！'],
  back: ['我回来了。'],
};

/** 造一个可观察的 store：叶子与台词都收集起来，阈值固定成 2/4 便于断言。 */
function makeStore(opts: { hideMs?: number; now?: () => number; texts?: PatTexts } = {}) {
  const hidden: Array<[string, HiddenLeafData]> = [];
  const said: Array<[string, string, number]> = [];
  const store = new PatStore({
    textsOf: () => opts.texts ?? TEXTS,
    onChange: (petId, data) => hidden.push([petId, data]),
    onSay: (petId, text, duration) => said.push([petId, text, duration]),
    now: opts.now,
    // 固定阈值：娇羞到 2，不高兴到 4，第 5 次生气
    roll: (() => {
      const values = [0.5, 0.5];
      let i = 0;
      return () => values[Math.min(i++, values.length - 1)];
    })(),
    hideMs: () => opts.hideMs ?? 20,
  });
  return { store, hidden, said };
}

describe('PatStore —— 分级与躲起来', () => {
  test('前几次只说娇羞台词，不躲', () => {
    const { store, hidden, said } = makeStore();
    const first = store.pat('a');
    assert.equal(first.tier, 'shy');
    assert.equal(first.count, 1);
    assert.ok(TEXTS.shy.includes(first.text ?? ''), '说的是娇羞档台词');
    assert.equal(first.hideMs, 0);
    assert.equal(hidden.length, 0, '没生气不写 hidden 叶子');
    assert.equal(said.length, 1);
  });

  test('越过娇羞上界进不高兴档，再越过就生气并写 hidden', () => {
    const { store, hidden } = makeStore();
    const plan = store.pat('a').plan;
    // 走到不高兴档
    for (let i = 1; i < plan.shyUntil; i += 1) assert.equal(store.pat('a').tier, 'shy');
    assert.equal(store.pat('a').tier, 'annoyed');
    // 走到生气档
    while (!store.hidden('a')) {
      const d = store.pat('a');
      if (d.tier !== 'angry') continue;
      assert.ok(d.hideMs > 0, '生气必须真的躲起来');
      assert.equal(hidden.length, 1);
      assert.deepEqual(hidden[0][1].hidden, true);
    }
    assert.equal(store.hidden('a'), true);
  });

  test('躲着时又上报：受理但不反应（不重复写叶子、不再说话）', () => {
    const { store, hidden, said } = makeStore({ hideMs: 5000 });
    while (!store.hidden('a')) store.pat('a');
    const before = { hidden: hidden.length, said: said.length };
    const late = store.pat('a');
    assert.equal(late.ignored, true);
    assert.equal(late.text, undefined);
    assert.equal(hidden.length, before.hidden);
    assert.equal(said.length, before.said);
  });

  test('到点自己回来：写 hidden:false 并补一句回来的台词', async () => {
    const { store, hidden, said } = makeStore({ hideMs: 20 });
    while (!store.hidden('a')) store.pat('a');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const lastHidden = hidden[hidden.length - 1][1];
    assert.deepEqual(lastHidden, { hidden: false });
    assert.equal(store.hidden('a'), false);
    const back = said[said.length - 1];
    assert.equal(back[1], TEXTS.back[0]);
    assert.equal(back[0], 'a');
  });

  test('回来之后计数清零：下一次被戳重新从娇羞档开始', async () => {
    const { store } = makeStore({ hideMs: 20 });
    while (!store.hidden('a')) store.pat('a');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const again = store.pat('a');
    assert.equal(again.count, 1);
    assert.equal(again.tier, 'shy');
  });

  test('安静超过重置时间：气消了，计数从头数', () => {
    let clock = 1_000_000;
    const { store } = makeStore({ now: () => clock });
    store.pat('a');
    store.pat('a');
    assert.equal(store.pat('a').count, 3);
    clock += 3 * 60 * 1000 + 1; // 超过 PAT_RESET_MS
    assert.equal(store.pat('a').count, 1);
  });

  test('没有配台词时只躲不说话（不静默失败成「什么也没发生」）', () => {
    const { store, said } = makeStore({ texts: { shy: [], annoyed: [], angry: [], back: [] } });
    const d = store.pat('a');
    assert.equal(d.text, undefined);
    assert.equal(said.length, 0);
    assert.equal(d.tier, 'shy');
  });

  test('forget / dispose 之后计时器不再写叶子', async () => {
    const { store, hidden } = makeStore({ hideMs: 30 });
    while (!store.hidden('a')) store.pat('a');
    const before = hidden.length;
    store.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(hidden.length, before, 'dispose 后不再写 hidden:false');
  });
});
