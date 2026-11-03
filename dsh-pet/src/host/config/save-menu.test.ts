/**
 * 菜单布局在用户层保存路径上的三种情况：合法透传、形状非法整包拒、没传则保留磁盘旧值。
 * @module dsh-pet/src/host/config/save-menu.test
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { saveUserConfig } from './save.ts';

const pet = {
  id: 'fish',
  name: '大肥鱼',
  size: 260,
  balanceEnabled: false,
  display: 'web',
  position: { corner: 'bottom-right', marginX: 40, marginY: 40 },
};

describe('saveUserConfig —— 右键菜单布局', () => {
  test('合法数组原样进白名单', () => {
    const out = saveUserConfig({ pets: [pet], menuOrder: ['chat', 'todo'], menuHidden: ['whisper'] });
    assert.deepEqual(out?.menuOrder, ['chat', 'todo']);
    assert.deepEqual(out?.menuHidden, ['whisper']);
  });

  test('空数组合法（= 用默认顺序），不被当成「没传」', () => {
    const out = saveUserConfig({ pets: [pet], menuOrder: [], menuHidden: [] });
    assert.deepEqual(out?.menuOrder, []);
    assert.deepEqual(out?.menuHidden, []);
  });

  test('形状非法（不是数组 / 含非字符串）→ 整包拒绝', () => {
    assert.equal(saveUserConfig({ pets: [pet], menuOrder: 'chat' }), null);
    assert.equal(saveUserConfig({ pets: [pet], menuOrder: ['chat', 3] }), null);
    assert.equal(saveUserConfig({ pets: [pet], menuHidden: { chat: true } }), null);
  });

  test('没传则透传磁盘旧值，不凭空造空数组覆盖用户设置', () => {
    const out = saveUserConfig({ pets: [pet] }, { menuOrder: ['todo'], menuHidden: [] });
    assert.deepEqual(out?.menuOrder, ['todo']);
    assert.deepEqual(out?.menuHidden, []);
  });
});
