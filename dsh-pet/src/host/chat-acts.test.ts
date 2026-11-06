/**
 * 对话标记（改名 / 记住）的契约测试。
 *
 * 跑法：node --experimental-strip-types --test src/host/chat-acts.test.ts
 * 覆盖：标记剥离、同类多次只认最后一个、空内容丢弃、名字清洗与限长、指令文案含两个标记。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACT_NAME_MAX,
  ACT_REMEMBER_MAX,
  ACT_SIZE_MAX,
  ACT_SIZE_MIN,
  actInstruction,
  extractChatActs,
  wantsCenter,
} from './chat-acts.ts';

describe('extractChatActs —— 剥标记', () => {
  test('没有标记时原样返回，且不带任何动作', () => {
    const result = extractChatActs('今天天气不错。');
    assert.equal(result.text, '今天天气不错。');
    assert.equal(result.rename, undefined);
    assert.equal(result.remember, undefined);
  });

  test('改名标记：剥掉标记、名字去掉引号', () => {
    const result = extractChatActs('好呀，我记住了。\n[改名:「小灰」]');
    assert.equal(result.text, '好呀，我记住了。');
    assert.equal(result.rename, '小灰');
  });

  test('记住标记：正文空格归一、限长', () => {
    const result = extractChatActs('嗯嗯。\n[记住:主人   周三要交周报]');
    assert.equal(result.text, '嗯嗯。');
    assert.equal(result.remember, '主人 周三要交周报');
  });

  test('同类多次只认最后一个（模型先写错再改口）', () => {
    const result = extractChatActs('[改名:小蓝] [改名:小灰]');
    assert.equal(result.text, '');
    assert.equal(result.rename, '小灰');
  });

  test('两类标记同时出现：都能落地，正文干净', () => {
    const result = extractChatActs('知道啦。\n[改名:小灰]\n[记住:周报周三交]');
    assert.equal(result.text, '知道啦。');
    assert.equal(result.rename, '小灰');
    assert.equal(result.remember, '周报周三交');
  });

  test('空内容 / 纯标点：整条丢弃，但标记仍要剥掉', () => {
    const result = extractChatActs('好的。[改名: ][记住:。。。]');
    assert.equal(result.text, '好的。');
    assert.equal(result.rename, undefined);
    assert.equal(result.remember, undefined);
  });

  test('大小标记：夹到 0.5–3，正文干净', () => {
    const small = extractChatActs('好呀。[大小:0.2]');
    assert.equal(small.text, '好呀。');
    assert.equal(small.size, ACT_SIZE_MIN);
    const huge = extractChatActs('好呀。[大小:9]');
    assert.equal(huge.size, ACT_SIZE_MAX);
    const normal = extractChatActs('好呀。[大小：1.3]');
    assert.equal(normal.size, 1.3);
  });

  test('位置标记：中文与英文落点都认，非法值丢弃', () => {
    assert.equal(extractChatActs('好。[位置:左上]').corner, 'top-left');
    assert.equal(extractChatActs('好。[位置:bottom-right]').corner, 'bottom-right');
    assert.equal(extractChatActs('好。[位置:右上]').text, '好。');
    const bad = extractChatActs('好。[位置:中间]');
    assert.equal(bad.text, '好。');
    assert.equal(bad.corner, undefined);
  });

  test('「中间」类说法走 center，不写配置也不丢正文', () => {
    for (const word of ['中间', '中央', '屏幕中间', '桌面中间']) {
      const result = extractChatActs(`好呀。[位置:${word}]`);
      assert.equal(result.center, true);
      assert.equal(result.corner, undefined);
      assert.equal(result.text, '好呀。');
    }
    // 位置词之外的非法值仍然只剥标记、不产生动作
    const unknown = extractChatActs('好呀。[位置:随便哪]');
    assert.equal(unknown.center, undefined);
    assert.equal(unknown.corner, undefined);
    assert.equal(unknown.text, '好呀。');
  });

  test('超长名字截到上限，超长「记住」也截断', () => {
    const result = extractChatActs(`[改名:${'名'.repeat(40)}][记住:${'字'.repeat(ACT_REMEMBER_MAX + 50)}]`);
    assert.equal(result.rename?.length, ACT_NAME_MAX);
    assert.equal(result.remember?.length, ACT_REMEMBER_MAX);
  });
});

describe('wantsCenter —— 模型漏标记时的确定性兜底', () => {
  test('明说要过去才认，普通聊天不误判', () => {
    for (const text of ['到桌面中间去', '去屏幕中央待着', '游到中间来', '挪到正中', '中间一点']) {
      assert.equal(wantsCenter(text), true, text);
    }
    for (const text of ['把待办放中间吧', '我喜欢中间那个颜色', '今天好累', '帮我记一下待办']) {
      assert.equal(wantsCenter(text), false, text);
    }
  });
});

describe('actInstruction —— 告诉模型它能真的做事', () => {
  test('两个标记都写明，并强调只在明确要求时用', () => {
    const text = actInstruction();
    assert.match(text, /\[改名:新名字\]/);
    assert.match(text, /\[记住:一句话\]/);
    assert.match(text, /\[大小:倍率\]/);
    assert.match(text, /\[位置:左上\|右上\|左下\|右下\]/);
    assert.match(text, /\[位置:中间\]/);
    assert.match(text, /必须附标记/);
    assert.match(text, /闲聊不要加/);
  });
});
