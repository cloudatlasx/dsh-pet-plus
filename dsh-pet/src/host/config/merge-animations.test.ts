/**
 * animations 局部合并：用户只想加自己的动作时，不该被迫抄整段默认池。
 * 覆盖 extra 增量、分类按 id 追加/改权重、单池替换、events 按 key 覆盖、非法回退默认。
 * @module dsh-pet/src/host/config/merge-animations.test
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAnimations, mergeEntry } from './merge.ts';

/** 一份能通过 animationsValid 的最小默认池（形状与 assets/config.jsonc 同构） */
const base = {
  idle: ['待机呼吸休闲'],
  turn: ['东张西望'],
  drag: ['被鼠标拖拽悬空反馈'],
  clicks: ['点击回应-开心跃动'],
  moves: {
    default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 },
    actions: [{ name: '螃蟹走路' }],
  },
  categories: [
    { id: '小动作', weight: 20, actions: ['悠闲哼歌', '写代码'] },
    { id: '文字', weight: 10, noMirror: true, actions: ['深度思考碎碎念'] },
  ],
  events: {
    balance: ['余额-钱袋满溢'],
    sleepEnter: ['打瞌睡被惊醒'],
  },
  sleep: [{ start: ['躺下'], loop: ['呼呼大睡'], end: ['爬起来'] }],
};

const cloned = () => JSON.parse(JSON.stringify(base)) as typeof base;
const animsOf = (own: unknown) => mergeAnimations(cloned(), own, 'main-config.jsonc') as typeof base;

describe('mergeAnimations —— 只加自己的动作', () => {
  test('没写 animations：原样返回默认池', () => {
    assert.deepEqual(animsOf(undefined), base);
  });

  test('extra 新分类：追加到末尾、权重缺省 0（只菜单点播），默认池不受影响', () => {
    const out = animsOf({ extra: [{ category: '我加的', actions: ['打招呼', '挥手'] }] });
    assert.equal(out.categories.length, 3);
    assert.deepEqual(out.categories[2], { id: '我加的', weight: 0, actions: ['打招呼', '挥手'] });
    assert.deepEqual(out.categories[0].actions, ['悠闲哼歌', '写代码']);
  });

  test('extra 写已有分类：动作追加进去，权重不动', () => {
    const out = animsOf({ extra: [{ category: '小动作', actions: ['新动作'] }] });
    assert.deepEqual(out.categories[0].actions, ['悠闲哼歌', '写代码', '新动作']);
    assert.equal(out.categories[0].weight, 20);
  });

  test('extra 写了 weight：新分类按写的权重进随机池', () => {
    const out = animsOf({ extra: [{ category: '我加的', actions: ['打招呼'], weight: 3 }] });
    assert.deepEqual(out.categories[2], { id: '我加的', weight: 3, actions: ['打招呼'] });
  });

  test('categories 按 id 合并：权重可改、动作去重', () => {
    const out = animsOf({
      categories: [{ id: '小动作', weight: 5, actions: ['悠闲哼歌', '新动作'] }],
    });
    assert.equal(out.categories[0].weight, 5);
    assert.deepEqual(out.categories[0].actions, ['悠闲哼歌', '写代码', '新动作']);
    assert.equal(out.categories.length, 2);
  });

  test('categories 写新 id：与 extra 同样追加', () => {
    const out = animsOf({ categories: [{ id: '节日限定', actions: ['放烟花'] }] });
    assert.deepEqual(out.categories[2], { id: '节日限定', weight: 0, actions: ['放烟花'] });
  });

  test('单池（idle）：写了非空数组就整池替换，其余沿用默认', () => {
    const out = animsOf({ idle: ['新待机'] });
    assert.deepEqual(out.idle, ['新待机']);
    assert.deepEqual(out.turn, ['东张西望']);
    assert.deepEqual(out.clicks, ['点击回应-开心跃动']);
  });

  test('单池写空数组：视为「没写」，沿用默认（不把待机池清空）', () => {
    assert.deepEqual(animsOf({ idle: [] }).idle, ['待机呼吸休闲']);
  });

  test('moves：default 参数浅合并，不写 actions 时沿用默认', () => {
    const out = animsOf({ moves: { default: { minDist: 100 } } });
    assert.deepEqual(out.moves.default, { minDist: 100, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 });
    assert.deepEqual(out.moves.actions, [{ name: '螃蟹走路' }]);
  });

  test('events：按键覆盖，没写的键（balance）沿用默认', () => {
    const out = animsOf({ events: { sleepEnter: ['新入眠动作'] } });
    assert.deepEqual(out.events.sleepEnter, ['新入眠动作']);
    assert.deepEqual(out.events.balance, ['余额-钱袋满溢']);
  });

  test('合并后不合法（balance 被清空）：整段回退默认，不返回半残结构', () => {
    assert.deepEqual(animsOf({ events: { balance: [] } }), base);
  });

  test('animations 不是对象：回退默认', () => {
    assert.deepEqual(animsOf('乱写'), base);
  });

  test('不改默认池（入参被深拷贝，原地不动）', () => {
    const src = cloned();
    mergeAnimations(src, { extra: [{ category: '我加的', actions: ['打招呼'] }] }, 'x');
    assert.deepEqual(src.categories.length, 2);
    assert.deepEqual(src.categories[0].actions, ['悠闲哼歌', '写代码']);
  });
});

describe('mergeEntry —— animations 走局部合并', () => {
  test('用户层只写 extra 也能生效（不再被 topFieldValid 整段拒掉）', () => {
    const entryBase = { animations: cloned(), pets: [] };
    const out = mergeEntry(
      entryBase,
      { animations: { extra: [{ category: '我加的', actions: ['打招呼'] }] } },
      'main-config.jsonc',
      [],
      new Set(),
    );
    const anims = out.animations as typeof base;
    assert.equal(anims.categories.length, 3);
    assert.deepEqual(anims.categories[2].actions, ['打招呼']);
    // 默认池的其它字段还在
    assert.deepEqual(anims.events.balance, ['余额-钱袋满溢']);
  });

  test('用户层没写 animations：整段沿用默认', () => {
    const entryBase = { animations: cloned(), pets: [] };
    const out = mergeEntry(entryBase, { voiceEnabled: true }, 'main-config.jsonc', [], new Set());
    assert.deepEqual(out.animations, base);
  });
});
