/**
 * 右键菜单布局：默认顺序、未知项丢弃、缺失项补末尾、隐藏项保留位置。
 * @module dsh-pet/src/shared/menu/layout.test
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MENU_ORDER, MENU_TOOL_ACTIONS, resolveMenuLayout } from './layout.ts';

describe('resolveMenuLayout —— 顺序', () => {
  test('没配过 = 默认顺序，且对话在最前', () => {
    const layout = resolveMenuLayout(undefined, undefined);
    assert.deepEqual(layout.order, [...DEFAULT_MENU_ORDER]);
    assert.equal(layout.order[0], 'chat');
    assert.deepEqual(layout.hidden, []);
  });

  test('空数组与缺省同义，绝不解成「全部隐藏」', () => {
    const layout = resolveMenuLayout([], []);
    assert.deepEqual(layout.order, [...DEFAULT_MENU_ORDER]);
    assert.equal(layout.hidden.length, 0);
  });

  test('按配置的顺序走，缺的项补在末尾', () => {
    const layout = resolveMenuLayout(['whisper', 'chat'], undefined);
    assert.deepEqual(layout.order.slice(0, 2), ['whisper', 'chat']);
    assert.equal(layout.order.length, DEFAULT_MENU_ORDER.length);
    // 补在末尾的项按默认顺序排列，不含已提到前面的两项
    assert.deepEqual(
      layout.order.slice(2),
      DEFAULT_MENU_ORDER.filter((a) => a !== 'whisper' && a !== 'chat'),
    );
  });

  test('未知动作与重复项被丢掉，非字符串跳过', () => {
    const layout = resolveMenuLayout(['chat', 'nope', 'chat', 42, ' todo '], undefined);
    assert.deepEqual(layout.order.slice(0, 2), ['chat', 'todo']);
    assert.equal(layout.order.includes('nope'), false);
    assert.equal(layout.order.filter((a) => a === 'chat').length, 1);
  });

  test('隐藏项只记名字，不影响顺序里的位置', () => {
    const layout = resolveMenuLayout(['chat', 'todo'], ['todo', 'bogus']);
    assert.deepEqual(layout.hidden, ['todo']);
    assert.equal(layout.order.includes('todo'), true);
    assert.equal(layout.order.indexOf('todo') < layout.order.indexOf('whisper'), true);
  });
});

describe('MENU_TOOL_ACTIONS —— 清单', () => {
  test('动作名唯一，且默认顺序与清单同序', () => {
    const names = MENU_TOOL_ACTIONS.map((item) => item.action);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, [...DEFAULT_MENU_ORDER]);
  });
});
