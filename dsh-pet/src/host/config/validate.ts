/**
 * 字段校验：每个字段一个 `xValid`，只管形状与取值范围。
 *
 * 校验失败只记一次告警并返回 false，由调用方回退默认值。
 * 必须始终成立：校验规则与读取侧同一套，写回时不得放宽。
 * @module dsh-pet/src/host/config/validate
 */
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/fonts.ts';
import { isKnownVoice } from '../voice/voices.ts';
import { FONT_FAMILY_SET } from './constants.ts';

/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const anims = a as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (!Array.isArray(anims[key])) return false;
  }
  const moves = anims.moves;
  if (
    !moves ||
    typeof moves !== 'object' ||
    typeof (moves as Record<string, unknown>).default !== 'object' ||
    (moves as Record<string, unknown>).default === null ||
    !Array.isArray((moves as Record<string, unknown>).actions)
  ) {
    return false;
  }
  if (!Array.isArray(anims.categories)) return false;
  const ev = anims.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  const evEntries = ev as Record<string, unknown>;
  for (const pool of Object.values(evEntries)) {
    if (!Array.isArray(pool) || pool.length === 0) return false;
    for (const slot of pool) {
      // 档位槽位：单个动画名或候选数组（档内随机抽 1，见 shared/pickers pickSlot）；
      // 空字符串 / 空数组 / 成员为空串的数组均非法
      if (typeof slot === 'string') {
        if (slot.length === 0) return false;
      } else if (Array.isArray(slot)) {
        if (slot.length === 0) return false;
        for (const name of slot) {
          if (typeof name !== 'string' || name.length === 0) return false;
        }
      } else {
        return false;
      }
    }
  }
  const balance = evEntries.balance;
  if (!Array.isArray(balance) || balance.length === 0) return false;
  // sleep 可选：pet pack 不写也合法（不同角色的睡觉素材不一样，不能强求）。
  // 写了才校验形状——一个空套或空段会让状态机「进去了但没动画播」，比不配更难解释。
  return anims.sleep === undefined || sleepValid(anims.sleep);
}

/** sleep 段校验：非空套数组，每套都必须有非空的 start / loop / end 字符串数组。
 *  未写由调用方放行（可选字段）；这里只处理「写了」的形态。 */
function sleepValid(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const set of value) {
    if (!set || typeof set !== 'object' || Array.isArray(set)) return false;
    const entry = set as Record<string, unknown>;
    for (const phase of ['start', 'loop', 'end']) {
      const pool = entry[phase];
      if (!Array.isArray(pool) || pool.length === 0) return false;
      for (const name of pool) {
        if (typeof name !== 'string' || name.length === 0) return false;
      }
    }
  }
  return true;
}

/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w: unknown): boolean {
  if (!w || typeof w !== 'object') return false;
  const weights = w as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'move']) {
    const v = Number(weights[key]);
    if (!Number.isFinite(v) || v < 0) return false;
  }
  return true;
}

/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
 *  ceilingBounce / petCollision 为布尔、throwPower > 0（有限数字）。
 *  hapticEnabled / tiltGravity / shakeThrow 为可选布尔（旧配置没有这几个键）。 */
export function physicsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const g = Number(p.gravity);
  const r = Number(p.restitution);
  const f = Number(p.groundFriction);
  const tp = Number(p.throwPower);
  return (
    Number.isFinite(g) &&
    g >= 0 &&
    Number.isFinite(r) &&
    r >= 0 &&
    r <= 1 &&
    Number.isFinite(f) &&
    f >= 0 &&
    typeof p.ceilingBounce === 'boolean' &&
    Number.isFinite(tp) &&
    tp > 0 &&
    typeof p.petCollision === 'boolean' &&
    // 可选：旧配置（与手写配置）没有这三个键，各按默认处理（三个都按开处理），
    // 缺键不算整段非法。
    (p.hapticEnabled === undefined || typeof p.hapticEnabled === 'boolean') &&
    (p.tiltGravity === undefined || typeof p.tiltGravity === 'boolean') &&
    (p.shakeThrow === undefined || typeof p.shakeThrow === 'boolean')
  );
}

/** font 段校验：family ∈ 预设白名单、size 为区间内的有限数字、followPet 为布尔。
 *  与 physics 同口径：整段校验——任一子键缺失/非法即整段非法（告警 + 取默认），
 *  不做「缺子键逐个补默认」；对象字段一律整段替换。 */
export function fontValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.family !== 'string' || !FONT_FAMILY_SET.has(f.family)) return false;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
  return typeof f.followPet === 'boolean';
}

/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
 *  要么都留空（= 跟随当前对话的模型）要么都非空——只填一半会拼出「用 A 家的模型名去问 B 家」
 *  这种必然失败的组合，按非法处理（告警 + 取默认）。 */
export function modelSelectionValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== 'string' || typeof m.model !== 'string') return false;
  return (m.provider.trim() === '') === (m.model.trim() === '');
}

/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const group of value) {
    if (!Array.isArray(group) || group.length === 0) return false;
    for (const text of group) {
      if (typeof text !== 'string' || text.length === 0) return false;
    }
  }
  return true;
}

/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
export function topFieldValid(key: string, value: unknown): boolean {
  switch (key) {
    case 'whisperPrompt':
      return typeof value === 'string' && value.length > 0;
    case 'chatMemoryRounds': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case 'chatImageLimit': {
      // 对话配图张数上限：非负数字（0 = 不限制）；小数按消费者 Math.floor 取整
      const n = Number(value);
      return Number.isFinite(n) && n >= 0;
    }
    case 'notificationsEnabled':
      return typeof value === 'boolean';
    case 'clickSoundEnabled':
      // 点击音效开关（全局布尔，只读 main 条目）：与 notificationsEnabled 同一套校验
      return typeof value === 'boolean';
    case 'whisperImageEnabled':
      return typeof value === 'boolean';
    case 'voiceEnabled':
      // 语音播报开关（全局布尔）：只决定念不念，不影响气泡与记忆
      return typeof value === 'boolean';
    case 'voiceName':
      // 音色必须是白名单内的 id；写错即非法，读取侧回落到默认音色并告警
      return typeof value === 'string' && isKnownVoice(value);
    case 'voiceVolume':
      // 播放音量系数：0–1 的有限数，与 Audio.volume 同量纲；越界即非法（不夹取，读取侧回落默认）
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    case 'voiceWhisperEnabled':
      // 周期碎碎念的语音开关（全局布尔）：只决定念不念，不影响气泡与记忆
      return typeof value === 'boolean';
    case 'voiceTodoEnabled':
      // 待办提醒的语音开关（全局布尔）：同上
      return typeof value === 'boolean';
    case 'voiceEngine':
      // 语音引擎（全局枚举）：edge = 内置微软语音，breeze = 用户自己的 Breeze 在线 Key。
      // 只认这两个值——写错即非法，读取侧回落到 edge 并告警（宁可念不出，也不乱连第三方）。
      return value === 'edge' || value === 'breeze';
    case 'breezeApiKey':
      // Breeze API Key（`brz_` 开头）：空串合法（= 还没填，引擎回落到 edge）；
      // 上限 200 字符，防止把整段文本误贴进这个字段。
      return typeof value === 'string' && value.length <= 200 && !/[\r\n\t]/.test(value);
    case 'breezeVoice':
      // Breeze 音色 id：由账号决定，不能做白名单，只验形状；空串合法（= 还没选，读取侧取列表第一个）。
      return typeof value === 'string' && value.length <= 100 && !/[\r\n\t]/.test(value);
    case 'breezeSpeed':
      // Breeze 语速倍率：0.5–2.0，与设置页滑条同量纲；越界即非法，读取侧回落 1.0。
      return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2;
    case 'chatImageEnabled':
      return typeof value === 'boolean';
    case 'chatAnimationEnabled':
      return typeof value === 'boolean';
    case 'confineToScreen':
      return typeof value === 'boolean';
    case 'trayEnabled':
      // 桌面模式系统托盘开关（main 条目顶层；helper 读它决定建不建托盘图标）
      return typeof value === 'boolean';
    case 'requestBubbleEnabled':
      // 审批 / 提问的交互气泡开关（全局布尔）：关掉就全部回落 DSH 自己的面板
      return typeof value === 'boolean';
    case 'scheduleRemindersEnabled':
      // 定时任务到点的宠物提醒开关（全局布尔）
      return typeof value === 'boolean';
    case 'menuOrder':
    case 'menuHidden':
      // 右键菜单的顺序 / 隐藏项（全局字符串数组）：这里只验形状，认不认得那些动作名
      // 由 shared/menu/layout 在渲染时判断——未知项丢弃、空数组 = 用默认顺序，
      // 所以写错一个名字不该让整份配置被拒（那会把用户别的设置一起挡掉）。
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'animations':
      return animationsValid(value);
    case 'animationWeights':
      return weightsValid(value);
    case 'eventsRefreshSec':
      return eventsRefreshSecValid(value);
    case 'physics':
      return physicsValid(value);
    case 'font':
      return fontValid(value);
    case 'whisperModel':
    case 'chatModel':
      return modelSelectionValid(value);
    case 'workStatusTexts':
      return workStatusTextsValid(value);
    case 'sleepRefuseTexts':
    case 'sleepStartTexts':
    case 'sleepEndTexts':
    case 'patShyTexts':
    case 'patAnnoyedTexts':
    case 'patAngryTexts':
    case 'patBackTexts': {
      // 睡觉三组台词（条目级）：非空字符串数组，随机挑一句；空数组/空串会让「说话」变成静默失败
      if (!Array.isArray(value) || value.length === 0) return false;
      return value.every((text) => typeof text === 'string' && text.length > 0);
    }
    default:
      return true;
  }
}

/**
 * eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
 * 这是整段替换字段：缺的键由消费端各自兜底（1800 / 300），多写的键原样保留；空对象合法。
 */
function eventsRefreshSecValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return false;
  }
  return true;
}
