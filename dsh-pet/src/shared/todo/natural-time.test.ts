/**
 * 自然语言时间的解析测试：所有用例都固定参照时刻（2026-11-05 周四 10:20），
 * 否则「明天」「周五」这类说法会随跑测试的日子变。
 * @module dsh-pet/src/shared/todo/natural-time.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNaturalTime } from './natural-time.ts';

/** 参照时刻：2026-11-05（周四）10:20:00，本地时区。 */
const NOW = new Date(2026, 10, 5, 10, 20, 0);

/** 某天 hh:mm 的时间戳。 */
function at(month: number, date: number, hour: number, minute = 0): number {
  return new Date(2026, month - 1, date, hour, minute, 0).getTime();
}

test('相对时间：分钟、小时、天', () => {
  assert.equal(parseNaturalTime('5分钟后', NOW), NOW.getTime() + 5 * 60 * 1000);
  assert.equal(parseNaturalTime('五分钟后', NOW), NOW.getTime() + 5 * 60 * 1000);
  assert.equal(parseNaturalTime('半个小时之后', NOW), NOW.getTime() + 30 * 60 * 1000);
  assert.equal(parseNaturalTime('一个半小时后', NOW), NOW.getTime() + 90 * 60 * 1000);
  assert.equal(parseNaturalTime('两小时', NOW), NOW.getTime() + 2 * 60 * 60 * 1000);
  assert.equal(parseNaturalTime('三天后', NOW), NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
  assert.equal(parseNaturalTime('两周后', NOW), NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
});

test('只给日子：落在当天早上九点', () => {
  assert.equal(parseNaturalTime('今天', NOW), at(11, 5, 9));
  assert.equal(parseNaturalTime('明天', NOW), at(11, 6, 9));
  assert.equal(parseNaturalTime('后天', NOW), at(11, 7, 9));
  assert.equal(parseNaturalTime('大后天', NOW), at(11, 8, 9));
});

test('周几：本周已过就指下周，带「下」就再推一周', () => {
  assert.equal(parseNaturalTime('周五', NOW), at(11, 6, 9));
  assert.equal(parseNaturalTime('星期四', NOW), at(11, 5, 9));
  assert.equal(parseNaturalTime('下周一', NOW), at(11, 9, 9));
  assert.equal(parseNaturalTime('下周一上午10点半', NOW), at(11, 9, 10, 30));
});

test('时刻：点、点半、冒号、中文数字、时段词', () => {
  assert.equal(parseNaturalTime('21:30', NOW), at(11, 5, 21, 30));
  assert.equal(parseNaturalTime('今晚8点', NOW), at(11, 5, 20));
  assert.equal(parseNaturalTime('晚上八点', NOW), at(11, 5, 20));
  assert.equal(parseNaturalTime('明天早上九点', NOW), at(11, 6, 9));
  assert.equal(parseNaturalTime('周五下午3点', NOW), at(11, 6, 15));
  assert.equal(parseNaturalTime('明天9点20', NOW), at(11, 6, 9, 20));
  assert.equal(parseNaturalTime('明天七点一刻', NOW), at(11, 6, 7, 15));
});

test('只给时刻且今天已经过了：顺延到明天', () => {
  assert.equal(parseNaturalTime('9:30', NOW), at(11, 6, 9, 30));
  assert.equal(parseNaturalTime('八点', NOW), at(11, 6, 8));
});

test('月日：今年已过就落到明年', () => {
  assert.equal(parseNaturalTime('8月20日14:00', NOW), new Date(2027, 7, 20, 14, 0, 0).getTime());
  assert.equal(parseNaturalTime('11月20日', NOW), at(11, 20, 9));
});

test('看不懂就是 null，不瞎猜', () => {
  assert.equal(parseNaturalTime('', NOW), null);
  assert.equal(parseNaturalTime('   ', NOW), null);
  assert.equal(parseNaturalTime('随便', NOW), null);
  assert.equal(parseNaturalTime('0分钟后', NOW), null);
});
