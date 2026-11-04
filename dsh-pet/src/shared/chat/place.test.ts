/**
 * 对话弹窗落点：贴边的宠物弹出弹窗时别盖住自己、也别掉到屏幕外。
 * @module dsh-pet/src/shared/chat/place.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { placeBeside, type PlaceRect } from './place.ts';

const bounds: PlaceRect = { x: 0, y: 0, w: 1440, h: 900 };
const tip = { w: 320, h: 380 };

/** 一只 220×220 的宠物，右下角留 24 的边距。 */
const bottomRight: PlaceRect = { x: 1440 - 24 - 220, y: 900 - 24 - 220, w: 220, h: 220 };
/** 同一只宠物摆在左下角。 */
const bottomLeft: PlaceRect = { x: 24, y: 900 - 24 - 220, w: 220, h: 220 };

test('宠物在右下：弹窗长在左侧，整块落在视口内，且不压住宠物', () => {
  const r = placeBeside(bottomRight, tip, bounds);
  assert.equal(r.side, 'left');
  assert.ok(r.x + tip.w <= bottomRight.x, `右边缘 ${r.x + tip.w} 应不超过宠物左边缘 ${bottomRight.x}`);
  assert.ok(r.x >= 0 && r.y >= 0);
  assert.ok(r.y + tip.h <= bounds.h);
});

test('宠物在左下：弹窗长在右侧', () => {
  const r = placeBeside(bottomLeft, tip, bounds);
  assert.equal(r.side, 'right');
  assert.ok(r.x >= bottomLeft.x + bottomLeft.w);
  assert.ok(r.x + tip.w <= bounds.w);
});

test('宠物在上半屏：弹窗顶边对齐宠物，向下长', () => {
  const topLeft: PlaceRect = { x: 24, y: 24, w: 220, h: 220 };
  const r = placeBeside(topLeft, tip, bounds);
  assert.equal(r.y, 24);
});

test('宠物在下半屏：弹窗底边对齐宠物脚底，向上长', () => {
  const r = placeBeside(bottomLeft, tip, bounds);
  assert.equal(r.y + tip.h, bottomLeft.y + bottomLeft.h);
});

test('宠物在左半屏（但明显偏左）时弹窗一律朝右长', () => {
  const narrow: PlaceRect = { x: 0, y: 0, w: 640, h: 900 };
  const pet: PlaceRect = { x: 120, y: 300, w: 200, h: 200 };
  const r = placeBeside(pet, { w: 300, h: 200 }, narrow);
  assert.equal(r.side, 'right');
  assert.ok(r.x >= pet.x + pet.w);
});

test('两侧都塞不下：夹回视口内，不吐负数也不出屏', () => {
  const narrow: PlaceRect = { x: 0, y: 0, w: 500, h: 400 };
  const pet: PlaceRect = { x: 200, y: 150, w: 120, h: 120 };
  const r = placeBeside(pet, { w: 460, h: 380 }, narrow);
  assert.ok(r.x >= 0 && r.x + 460 <= 500);
  assert.ok(r.y >= 0 && r.y + 380 <= 400);
});

test('弹窗比视口还大：退到左上边界，不产生负坐标', () => {
  const tiny: PlaceRect = { x: 0, y: 0, w: 200, h: 200 };
  const r = placeBeside({ x: 150, y: 150, w: 40, h: 40 }, { w: 600, h: 600 }, tiny);
  assert.equal(r.x, 4);
  assert.equal(r.y, 4);
});

test('bounds 带偏移（桌面窗口局部坐标）时同样成立', () => {
  const winBounds: PlaceRect = { x: 100, y: 50, w: 900, h: 700 };
  const pet: PlaceRect = { x: 100 + 900 - 40 - 200, y: 50 + 700 - 40 - 200, w: 200, h: 200 };
  const r = placeBeside(pet, tip, winBounds);
  assert.equal(r.side, 'left');
  assert.ok(r.x >= winBounds.x && r.x + tip.w <= winBounds.x + winBounds.w);
  assert.ok(r.y >= winBounds.y && r.y + tip.h <= winBounds.y + winBounds.h);
});
