/**
 * 「位置指令的过渡动画 = 移动池里的随机动作」这条链路的源码守卫。
 *
 * 背景：位置指令原本走的是「直线补间 + 盖一层小鱼」——不管池子里有几个移动动作，
 * 位移都按固定的 duration 补间完，画面永远是同一条鱼。用户要的是每个移动动作都能当过渡，
 * 且位移时长跟着该动作的片长走（螃蟹 10s、鲸鱼 1.68s 各按自己的节奏）。
 *
 * 这条链路横跨三份只能读源码断言的运行时文件（宿主不加载它们），所以用 node:test +
 * 文本断言把关键接线钉住；行为本身另由真机探针验证（helper 窗口位置采样）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const motion = (): string => read('../../runtime/electron-helper/sprite/motion.js');
const playback = (): string => read('../../runtime/electron-helper/sprite/playback.js');
const events = (): string => read('../../runtime/electron-helper/events.js');
const config = (): string => read('../../assets/config.jsonc');

describe('位置指令的过渡动作', () => {
  test('位置叶子带 action=random，两条路（去程 / 归位）都要给', () => {
    const src = events();
    const hits = src.match(/action:\s*'random'/g) ?? [];
    assert.ok(hits.length >= 2, `events.js 里应有 ≥2 处 action: 'random'，实际 ${hits.length}`);
  });

  test('moveToCenter 只在池子为空时退回直线补间', () => {
    const src = motion();
    assert.match(src, /startActionMove\(c\.x,\s*c\.y,\s*opts\.action\)\s*!==\s*false/);
  });

  test('过渡动作按动画片长插值：lead/tail 从动作参数来', () => {
    const src = motion();
    // 动作参数要能被动作覆盖：Object.assign 到 moves.default 之上
    assert.match(src, /Object\.assign\(\{\},\s*moves\.default,\s*chosen\.params/);
    // 位移窗口 = 片长 - 首 - 尾，超出就夹到 0.1s
    assert.match(src, /Math\.max\(0\.1,\s*duration\s*-\s*leadSec\s*-\s*tailSec\)/);
  });

  test('走位过渡不盖小鱼：动作自己的视频负责画面', () => {
    const src = motion();
    assert.match(src, /startGlide\(withSwim = true\)/);
    assert.match(src, /if \(withSwim === false\) return;/);
  });

  test('归位意图写在 moveToCenter 之后（它会 cancelReturnHome，顺序反了就回不去）', () => {
    const src = motion();
    const call = src.indexOf('this.moveToCenter(rx, ry, mode, duration, frame, opts);');
    const setAfter = src.indexOf('this.returnHomeAfter = returnAfter > 0 ? returnAfter : 0;');
    assert.ok(call >= 0 && setAfter >= 0, 'moveToCenterAndReturn 的两处关键语句必须存在');
    assert.ok(call < setAfter, 'returnHomeAfter 必须在 moveToCenter 调用之后写入');
  });

  test('移动动作可带播放倍率：倍率改变时「动画时长」与「走完这段的时间」一起缩放', () => {
    const src = playback();
    assert.match(src, /el\.playbackRate = Number\.isFinite\(this\.moveRate\)/);
  });

  test('鲸鱼在配置里标了 swim，并缩短了首尾静止（否则 1.68s 里只有 0.48s 在动）', () => {
    const src = config();
    const at = src.indexOf('"鲸鱼游动"');
    assert.ok(at > 0, 'config.jsonc 里应有「鲸鱼游动」这一项');
    const block = src.slice(at, at + 220);
    assert.match(block, /"swim"\s*:\s*true/);
    const lead = block.match(/"leadSec"\s*:\s*([0-9.]+)/);
    assert.ok(lead, '鲸鱼项应显式给 leadSec');
    assert.ok(Number(lead[1]) <= 0.3, `鲸鱼的 leadSec 应 ≤0.3，实际 ${lead[1]}`);
  });
});
