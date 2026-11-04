/**
 * 对话提醒的解析测试：指令怎么拼、标记怎么剥、哪些写法算合法。
 *
 * 钉住四条：两种分隔符与四种单位都认、非法标记照样剥掉但不产生提醒、
 * 多条标记只取第一条（模型偶尔会多写）、剥完压掉空行。
 *
 * 跑法：node --experimental-strip-types --test src/host/chat-reminder.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractChatReminder,
  REMINDER_MIN_SECONDS,
  REMINDER_TITLE_MAX,
  reminderInstruction,
  reminderNowText,
} from './chat-reminder.ts';

describe('extractChatReminder —— 从回复里取提醒', () => {
  test('秒数写法：剥掉标记、留下正文', () => {
    const out = extractChatReminder('好，我去提醒你。\n[提醒:120|开会]');
    assert.equal(out.text, '好，我去提醒你。');
    assert.deepEqual(out.reminder, { seconds: 120, title: '开会' });
  });

  test('分钟 / 小时 / 天 / 全角分隔符都认', () => {
    assert.deepEqual(extractChatReminder('[提醒:2分钟|开会]').reminder, { seconds: 120, title: '开会' });
    assert.deepEqual(extractChatReminder('[提醒:1小时｜喝水]').reminder, { seconds: 3600, title: '喝水' });
    assert.deepEqual(extractChatReminder('[提醒:1天|交周报]').reminder, { seconds: 86400, title: '交周报' });
    assert.deepEqual(extractChatReminder('[提醒:1.5分钟|热身]').reminder, { seconds: 90, title: '热身' });
  });

  test('没有标记：正文原样返回', () => {
    const out = extractChatReminder('在的，你说吧。');
    assert.equal(out.text, '在的，你说吧。');
    assert.equal(out.reminder, undefined);
  });

  test('标记不合法（缺分隔符 / 太短 / 太长 / 没事项）：剥掉但不当真', () => {
    assert.equal(extractChatReminder('好的\n[提醒:120]').reminder, undefined);
    assert.equal(extractChatReminder(`好的\n[提醒:${REMINDER_MIN_SECONDS - 1}|太短了]`).reminder, undefined);
    assert.equal(extractChatReminder('好的\n[提醒:30天|太久]').reminder, undefined);
    assert.equal(extractChatReminder('好的\n[提醒:120|  ]').reminder, undefined);
    assert.equal(extractChatReminder(`好的\n[提醒:120|${'长'.repeat(REMINDER_TITLE_MAX + 1)}]`).reminder, undefined);
    // 但正文都被清干净了，不留方括号标记
    assert.equal(extractChatReminder('好的\n[提醒:120]').text, '好的');
  });

  test('多条标记：都剥掉，只取第一条合法提醒', () => {
    const out = extractChatReminder('[提醒:60|甲]\n[提醒:120|乙]');
    assert.equal(out.reminder?.seconds, 60);
    assert.equal(out.text, '');
  });

  test('标记后面跟着正文：只压掉多余空行，不吞正文', () => {
    const out = extractChatReminder('第一句\n[提醒:60|甲]\n\n第二句');
    assert.equal(out.text, '第一句\n第二句');
    assert.equal(out.reminder?.title, '甲');
  });
});

describe('reminderInstruction —— 给模型的指令', () => {
  test('带上标记格式、上限与当前时间', () => {
    const now = new Date(2026, 10, 4, 14, 5); // 2026-11-04 14:05（周三）
    const text = reminderInstruction(now);
    assert.ok(text.includes('[提醒:秒数|事项]'), '要写清标记格式');
    assert.ok(text.includes('604800'), '要写出最长的秒数，模型才知道上限');
    assert.ok(text.includes('2026-11-04 14:05'), '要给出时间基准');
    assert.ok(text.includes('周三'), '要带星期，模型才能算「明天」');
  });

  test('时间串格式', () => {
    assert.equal(reminderNowText(new Date(2026, 0, 1, 9, 0)), '2026-01-01 09:00（周四）');
  });
});
