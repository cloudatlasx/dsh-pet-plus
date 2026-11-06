/**
 * 拍一拍状态机单测：钉住「连拍升档、气到先说一句再躲、到点自己回来补一句、
 * 躲着时迟到上报不重复反应、干活时不躲（工作优先）、安静够久重新从娇羞数起」。
 *
 * 计时器用很短的注入值（20/30ms）真实等待，不 mock setTimeout。
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
  busy: ['我在忙呢。'],
};

/** 造一个可观察的 store：叶子与台词都收集起来，阈值固定便于断言。 */
function makeStore(
  opts: {
    hideMs?: number;
    hideDelayMs?: number;
    now?: () => number;
    texts?: PatTexts;
    busyOf?: () => boolean;
    hideEnabledOf?: () => boolean;
  } = {},
) {
  const hidden: Array<[string, HiddenLeafData]> = [];
  const said: Array<[string, string, number]> = [];
  const store = new PatStore({
    textsOf: () => opts.texts ?? TEXTS,
    onChange: (petId, data) => hidden.push([petId, data]),
    onSay: (petId, text, duration) => said.push([petId, text, duration]),
    now: opts.now,
    busyOf: opts.busyOf,
    hideEnabledOf: opts.hideEnabledOf,
    // roll 固定 0.5：娇羞上界 5、不高兴上界 11，第 12 次生气。
    roll: () => 0.5,
    hideMs: () => opts.hideMs ?? 20,
    hideDelayMs: opts.hideDelayMs ?? 10,
  });
  return { store, hidden, said };
}

/** 一直拍到生气档，返回最后那一拍的决定。 */
function patUntilAngry(store: PatStore) {
  for (let i = 0; i < 40; i += 1) {
    const d = store.pat('a');
    if (d.tier === 'angry') return d;
  }
  throw new Error('拍不到生气档');
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PatStore —— 分级、先说再躲、工作优先', () => {
  test('前几次只说娇羞台词，不躲', () => {
    const { store, hidden, said } = makeStore();
    const first = store.pat('a');
    assert.equal(first.tier, 'shy');
    assert.equal(first.count, 1);
    assert.equal(first.busy, false);
    assert.ok(TEXTS.shy.includes(first.text ?? ''), '说的是娇羞档台词');
    assert.equal(first.hideMs, 0);
    assert.equal(hidden.length, 0, '没生气不写 hidden 叶子');
    assert.equal(said.length, 1);
  });

  test('越过娇羞上界进不高兴档', () => {
    const { store } = makeStore();
    const plan = store.pat('a').plan;
    for (let i = 1; i < plan.shyUntil; i += 1) assert.equal(store.pat('a').tier, 'shy');
    assert.equal(store.pat('a').tier, 'annoyed');
  });

  test('生气时先把那句说完：立刻不写 hidden，等 hideDelayMs 之后才消失', async () => {
    const { store, hidden, said } = makeStore({ hideDelayMs: 40, hideMs: 500 });
    const angry = patUntilAngry(store);
    assert.ok(angry.hideMs > 0, '生气要真的安排躲起来');
    assert.equal(hidden.length, 0, '话还没说完，窗口不能先没了');
    assert.equal(store.hidden('a'), false, '还没消失就不算躲着');
    assert.equal(said[said.length - 1][1], TEXTS.angry[0]);

    await wait(20);
    assert.equal(hidden.length, 0, '延迟没到，仍然看得见');

    await wait(50);
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0][1].hidden, true);
    assert.equal(store.hidden('a'), true);
  });

  test('躲着时又上报：受理但不反应（不重复写叶子、不再说话）', async () => {
    const { store, hidden, said } = makeStore({ hideDelayMs: 5, hideMs: 5000 });
    patUntilAngry(store);
    await wait(40);
    assert.equal(store.hidden('a'), true);
    const before = { hidden: hidden.length, said: said.length };
    const late = store.pat('a');
    assert.equal(late.ignored, true);
    assert.equal(late.text, undefined);
    assert.equal(hidden.length, before.hidden);
    assert.equal(said.length, before.said);
  });

  test('到点自己回来：写 hidden:false 并补一句回来的台词', async () => {
    const { store, hidden, said } = makeStore({ hideDelayMs: 5, hideMs: 20 });
    patUntilAngry(store);
    await wait(80);
    const lastHidden = hidden[hidden.length - 1][1];
    assert.deepEqual(lastHidden, { hidden: false });
    assert.equal(store.hidden('a'), false);
    const back = said[said.length - 1];
    assert.equal(back[1], TEXTS.back[0]);
    assert.equal(back[0], 'a');
  });

  test('回来之后计数清零：下一次被戳重新从娇羞档开始', async () => {
    const { store } = makeStore({ hideDelayMs: 5, hideMs: 20 });
    patUntilAngry(store);
    await wait(80);
    const again = store.pat('a');
    assert.equal(again.count, 1);
    assert.equal(again.tier, 'shy');
  });

  test('干活时被拍：走「我在忙」，不躲也不消失（工作第一优先级）', async () => {
    let busy = false;
    const { store, hidden } = makeStore({ busyOf: () => busy, hideDelayMs: 5, hideMs: 20 });
    busy = true;
    const angry = patUntilAngry(store);
    assert.equal(angry.busy, true);
    assert.equal(angry.hideMs, 0, '忙的时候不该安排躲藏');
    assert.equal(angry.text, TEXTS.busy[0]);
    await wait(60);
    assert.equal(hidden.length, 0, '一刻都不该消失');
    assert.equal(store.hidden('a'), false);
  });

  test('说完最后一句、还没消失就开工了：这次躲藏作废', async () => {
    let busy = false;
    const { store, hidden } = makeStore({ busyOf: () => busy, hideDelayMs: 30, hideMs: 40 });
    patUntilAngry(store);
    busy = true; // 台词说完之前它开始干活
    await wait(80);
    assert.equal(hidden.length, 0, '干活了就不躲了');
    assert.equal(store.hidden('a'), false);
    // 作废之后还能正常说话（不是永久卡在生气档）
    busy = false;
    const after = store.pat('a');
    assert.equal(after.ignored, false);
  });

  test('主人说过「以后别消失」：气话照说，但绝不躲', async () => {
    const { store, hidden, said } = makeStore({
      hideEnabledOf: () => false,
      hideDelayMs: 5,
      hideMs: 20,
    });
    const angry = patUntilAngry(store);
    assert.equal(angry.tier, 'angry');
    assert.equal(angry.hideMs, 0, '偏好在就不安排躲藏');
    assert.equal(angry.text, TEXTS.angry[0]);
    assert.equal(said[said.length - 1]?.[1], TEXTS.angry[0]);
    await wait(60);
    assert.equal(hidden.length, 0, '一刻都不该消失');
    assert.equal(store.hidden('a'), false);
  });

  test('偏好是「可以躲」时行为不变（缺省允许）', async () => {
    const { store } = makeStore({ hideEnabledOf: () => true, hideDelayMs: 5, hideMs: 20 });
    const angry = patUntilAngry(store);
    assert.ok(angry.hideMs > 0, '允许躲的时候照旧安排躲藏');
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
    const { store, said } = makeStore({
      texts: { shy: [], annoyed: [], angry: [], back: [], busy: [] },
    });
    const d = store.pat('a');
    assert.equal(d.text, undefined);
    assert.equal(said.length, 0);
    assert.equal(d.tier, 'shy');
  });

  test('forget / dispose 之后计时器不再写叶子', async () => {
    const { store, hidden } = makeStore({ hideDelayMs: 5, hideMs: 5000 });
    patUntilAngry(store);
    await wait(40);
    const before = hidden.length;
    store.dispose();
    await wait(60);
    assert.equal(hidden.length, before, 'dispose 后不再写 hidden:false');
  });
});
