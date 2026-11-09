/**
 * 「不要自己乱跑 + 走完要回来」这条链路的源码守卫。
 *
 * 背景：随机链的移动档默认是开着的（5%），宠物会自己走开两三百像素然后停在那儿，
 * 久了屏幕上的位置越漂越远，用户看到的就是「一直自己乱跑」。现在两件事：
 *   1) `animations.moves.roam` 默认 false —— 随机链不再掷出移动档（菜单点播、位置指令、
 *      提醒游动都照旧能动）；
 *   2) 任何一次自主走位都是往返 —— 到位后换**另一个**移动动作走回出发点。
 *
 * 运行时 JS 宿主不加载（桌面 helper 由 Electron 载入），所以和行为测试一样用 node:test +
 * 源码文本断言把接线钉住；真实位移由真机探针（窗口位置采样）验证。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const motion = (): string => read('../../runtime/electron-helper/sprite/motion.js');
const playback = (): string => read('../../runtime/electron-helper/sprite/playback.js');
const input = (): string => read('../../runtime/electron-helper/sprite/input.js');
const init = (): string => read('../../runtime/electron-helper/sprite/init.js');
const config = (): string => read('../../assets/config.jsonc');
const animationFlow = (): string => read('../client/pet/card/animation-flow.ts');

describe('自主走位默认关闭', () => {
  test('配置里 roam 默认 false', () => {
    assert.match(config(), /"roam":\s*false/);
  });

  test('随机链两端的 move 档都受 roam 门控', () => {
    assert.match(playback(), /moves\.roam === true/);
    assert.match(playback(), /still:\s*working \|\| !roam/);
    assert.match(animationFlow(), /moves\.roam === true/);
    assert.match(animationFlow(), /still:\s*working \|\| !roam/);
  });
});

describe('走位往返', () => {
  test('自主走位带 roundTrip，并在出发前记下原点', () => {
    const src = playback();
    assert.match(src, /this\.roamHome = \{ rx: cx \/ W, ry: cy \/ H \}/);
    assert.match(src, /roundTrip: true/);
  });

  test('每趟都重记原点（旧原点会让它越漂越远）', () => {
    // 回归：曾经写成 `if (!this.roamHome)`，第二趟起还在往十几分钟前的旧位置回，
    // 屏幕上表现为「走回来了但没回原处」。现在无条件以当前所在为原点。
    const src = playback();
    assert.ok(!/if \(!this\.roamHome\) this\.roamHome =/.test(src), '出发时不能沿用上一次的原点');
  });

  test('到位后换一个动作走回原点', () => {
    const src = motion();
    assert.match(src, /if \(pm\.roundTrip\) this\.scheduleRoamReturn\(\);/);
    assert.match(src, /scheduleRoamReturn\(\)\s*\{/);
    // 回程换动作：过滤掉刚播完的那个
    assert.match(src, /actions\.filter\(\(a\) => a && a\.name !== this\.anim\)/);
    // 回程用同一个驱动走到原点（比例 × 视口）
    assert.match(src, /this\.startActionMove\(target\.rx \* VIEW\.w, target\.ry \* VIEW\.h, pick\.name\)/);
  });

  test('用户按着 / 另有移动时不回程，位置指令与拖拽会作废回程', () => {
    const src = motion();
    assert.match(src, /this\.dragState\.active \|\| this\.moveRef !== null \|\| this\.pendingMove/);
    // moveToCenter 开头（明确要去某处，不该再折返）就作废回程
    const start = src.indexOf('moveToCenter(rx, ry, mode, duration, frame, opts) {');
    assert.ok(start > 0, 'moveToCenter 定义必须存在');
    assert.match(src.slice(start, start + 700), /this\.cancelRoamReturn\(\);/);
    assert.match(input(), /this\.cancelRoamReturn\(\)/);
  });

  test('回程计时器与提醒归位计时器分开，互不作废', () => {
    const src = init();
    assert.match(src, /this\.roamReturnTimer = null;/);
    assert.match(src, /this\.roamHome = null;/);
    // cancelReturnHome 只清提醒那条，不回程那条
    const cancelReturnHome = motion().slice(
      motion().indexOf('cancelReturnHome() {'),
      motion().indexOf('scheduleRoamReturn() {'),
    );
    assert.ok(!cancelReturnHome.includes('roamHome = null'), 'cancelReturnHome 不应清掉走位回程原点');
  });
});
