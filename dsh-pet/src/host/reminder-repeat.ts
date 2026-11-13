/**
 * 重复提醒的纯逻辑：认出「每个工作日 11 点」这种周期说法、算出下一次、写成人话。
 *
 * 对话里答应下来的提醒原先只有一次性（`[提醒:秒数|事项]`），说出来的是
 * 「每个工作日提醒我点外卖」，实际只会在下一个工作日响一次就消失。这里补上周期，
 * 让模型能写 `[提醒:秒数|事项|每工作日]`，也在用户原话里兜底识别——
 * 模型漏写第三段时，按用户自己说的「每个工作日 11 点」重算到点时刻。
 *
 * 纯函数、不碰文件也不碰时钟：`now` 一律由调用方传入，测试里固定它。
 * @module dsh-pet/src/host/reminder-repeat
 */

/** 周期种类：每天 / 每个工作日 / 每周某天。 */
export type RepeatKind = 'daily' | 'weekday' | 'weekly';

/** 一条重复规则：什么时候、几点几分。 */
export interface ReminderRepeat {
  /** 周期种类。 */
  readonly kind: RepeatKind;
  /** 几点（0-23）。 */
  readonly hour: number;
  /** 几分（0-59）。 */
  readonly minute: number;
  /** `kind === 'weekly'` 时的星期（0 = 周日，1 = 周一 … 6 = 周六）。 */
  readonly weekday?: number;
}

/** 星期汉字 → 数字（与 `Date#getDay` 同一口径）。 */
const WEEKDAY_NUM: Readonly<Record<string, number>> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 每周某天的说法：`每周三`、`每星期三`、`每个礼拜天`。 */
const WEEKLY_RE = /每(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u;

/** 每个工作日的说法。 */
const WEEKDAY_RE = /每(?:个)?工作日|工作日每(?:天|日)|周一到周五|周一至周五/u;

/** 每天的说法（避开「每天」只是陈述的习惯，靠调用方的提醒动词闸门把关）。 */
const DAILY_RE = /每(?:天|日|晚|早|个晚上|个早上)/u;

/** 单个汉字的数字。 */
const DIGIT: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 把 `11` / `十一` / `两` 这种读数换成数字；认不出返回 null。 */
function numberOf(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  const ten = /^([零一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(raw);
  if (ten !== null) {
    const high = ten[1] === undefined ? 1 : (DIGIT[ten[1]] ?? 0);
    const low = ten[2] === undefined ? 0 : (DIGIT[ten[2]] ?? 0);
    return high * 10 + low;
  }
  if (raw.length === 1) return DIGIT[raw] ?? null;
  return null;
}

/** 从一句话里取「几点几分」；取不到返回 null。 */
function clockOf(text: string): { hour: number; minute: number } | null {
  const colon = /(\d{1,2})[:：](\d{1,2})/u.exec(text);
  if (colon !== null) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  const dot =
    /(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*点(半|\s*(?:[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*分?)?/u.exec(
      text,
    );
  if (dot === null) return null;
  const hour = numberOf(dot[1]);
  if (hour === null || hour < 0 || hour > 23) return null;
  let minute = 0;
  if (dot[2] !== undefined) {
    const tail = dot[2].trim();
    if (tail === '半') minute = 30;
    else {
      const parsed = numberOf(tail.replace(/分$/u, ''));
      if (parsed !== null && parsed >= 0 && parsed <= 59) minute = parsed;
    }
  }
  // 下午 / 晚上 说 1-11 点时按 12 小时制换算；说 13 点就不再动
  const period = /(下午|晚上|傍晚|夜里|凌晨|中午|上午|早上|早晨)/u.exec(text);
  if (period !== null && hour < 12) {
    const word = period[1] ?? '';
    if (/下午|晚上|傍晚|夜里/u.test(word)) {
      if (hour === 12) return { hour: 12, minute };
      return { hour: hour + 12, minute };
    }
    if (word === '中午' && hour < 6) return { hour: hour + 12, minute };
  }
  return { hour, minute };
}

/**
 * 认出用户/模型说的周期。
 *
 * @param text - 一句话（用户原话或标记里的第三段）。
 * @returns 周期种类与（每周时的）星期；没有周期说法返回 null。
 */
export function repeatKindOf(text: string): { kind: RepeatKind; weekday?: number } | null {
  const weekly = WEEKLY_RE.exec(text);
  if (weekly !== null) {
    const weekday = WEEKDAY_NUM[weekly[1] ?? ''];
    if (weekday !== undefined) return { kind: 'weekly', weekday };
  }
  if (WEEKDAY_RE.test(text)) return { kind: 'weekday' };
  if (DAILY_RE.test(text)) return { kind: 'daily' };
  return null;
}

/**
 * 从用户原话里读出完整的重复规则（周期 + 几点）。
 *
 * 周期与钟点必须同时出现：只说「每天」没有「几点」时没法排期，交给下一次对话确认。
 *
 * @param text - 用户这一句原话。
 * @returns 规则；缺周期或钟点返回 null。
 */
export function repeatOf(text: string): ReminderRepeat | null {
  const kind = repeatKindOf(text);
  if (kind === null) return null;
  const clock = clockOf(text);
  if (clock === null) return null;
  return kind.weekday === undefined
    ? { kind: kind.kind, hour: clock.hour, minute: clock.minute }
    : { kind: kind.kind, hour: clock.hour, minute: clock.minute, weekday: kind.weekday };
}

/**
 * 下一次触发时刻（严格晚于 `nowMs`）。
 *
 * 以本地时间对齐到整分：提醒说的是「11 点」，就不该在 11:00:31 响。
 *
 * @param repeat - 重复规则。
 * @param nowMs - 现在（毫秒时间戳）。
 * @returns 下一次的毫秒时间戳。
 */
export function nextOccurrence(repeat: ReminderRepeat, nowMs: number): number {
  const base = new Date(nowMs);
  for (let offset = 0; offset <= 8; offset += 1) {
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, repeat.hour, repeat.minute, 0, 0);
    if (at.getTime() <= nowMs) continue;
    const day = at.getDay();
    if (repeat.kind === 'weekday' && (day === 0 || day === 6)) continue;
    if (repeat.kind === 'weekly' && repeat.weekday !== undefined && day !== repeat.weekday) continue;
    return at.getTime();
  }
  // 8 天内一定能撞上一个符合规则的整分；真走到这里说明规则本身是坏的，退回一天后
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, repeat.hour, repeat.minute, 0, 0).getTime();
}

/**
 * 按某个时刻的钟点补出完整规则：标记里只有「每工作日」没有「几点」时用它。
 *
 * @param kind - 周期种类（可带 weekly 的星期）。
 * @param atMs - 已经算好的到点时刻；取它的本地时分。
 * @returns 带时分的完整规则。
 */
export function repeatAt(kind: { kind: RepeatKind; weekday?: number }, atMs: number): ReminderRepeat {
  const when = new Date(atMs);
  return kind.weekday === undefined
    ? { kind: kind.kind, hour: when.getHours(), minute: when.getMinutes() }
    : { kind: kind.kind, hour: when.getHours(), minute: when.getMinutes(), weekday: kind.weekday };
}

/** 把规则写成人话：`每个工作日 11:00`。 */
export function repeatLabel(repeat: ReminderRepeat): string {
  const clock = `${String(repeat.hour).padStart(2, '0')}:${String(repeat.minute).padStart(2, '0')}`;
  if (repeat.kind === 'daily') return `每天 ${clock}`;
  if (repeat.kind === 'weekday') return `每个工作日 ${clock}`;
  const name = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][repeat.weekday ?? 1] ?? '每周';
  return `${name} ${clock}`;
}

/** 用户话里像「让我提醒」的动词：没有它就不当成排提醒的请求。 */
const ASK_RE = /(提醒|叫我|喊我|记得|别忘|记着)/u;

/** 从原话里截事项：`每个工作日 11 点提醒我点外卖` → `点外卖`。 */
function titleOfSentence(text: string): string {
  const at = text.search(ASK_RE);
  if (at < 0) return '';
  const tail = text
    .slice(at)
    .replace(/^(?:提醒我一下|提醒我|提醒一下|提醒下|叫我|喊我|记得|别忘|记着)/u, '')
    .replace(/^[^，,。.；;：:]*?[，,。.；;：:]/u, '')
    .trim();
  const cleaned = tail.replace(/[。．.！!？?，,、；;：:]+$/u, '').trim();
  return cleaned.slice(0, 40);
}

/**
 * 模型漏写提醒标记时的兜底：用户话里同时有「周期 + 钟点 + 提醒动词」就替它排上。
 *
 * 只认完整的三件套，宁可漏也不要凭空造一条提醒——说「每天这个点我都点外卖」
 * 不是请求，写成提醒就成了打扰。
 *
 * @param userText - 用户这一句原话。
 * @param nowMs - 现在（毫秒时间戳）。
 * @returns 相对秒数与规则；不满足条件返回 null。
 */
export function inferRepeatReminder(
  userText: string,
  nowMs: number,
): { seconds: number; title: string; repeat: ReminderRepeat } | null {
  const repeat = repeatOf(userText);
  if (repeat === null) return null;
  if (!ASK_RE.test(userText)) return null;
  const title = titleOfSentence(userText);
  if (title === '') return null;
  const seconds = Math.round((nextOccurrence(repeat, nowMs) - nowMs) / 1000);
  return { seconds, title, repeat };
}

/**
 * 把一次提醒与用户原话对齐：原话里说了周期，就以原话的规则为准。
 *
 * 模型算的秒数可能差几十秒（「下周一的 11 点」算成 11:00:31），而用户原话里的「11 点」
 * 是精确的；能读出规则时一律用规则重算，读不出才保留模型的秒数。
 *
 * @param title - 已经解析出来的提醒事项（模型写的）。
 * @param seconds - 模型算出的秒数。
 * @param userText - 用户这一句原话。
 * @param nowMs - 现在（毫秒时间戳）。
 * @returns 对齐后的秒数与规则；原话没提周期时原样返回。
 */
export function applyRepeat(
  title: string,
  seconds: number,
  userText: string,
  nowMs: number,
): { seconds: number; title: string; repeat?: ReminderRepeat } {
  const repeat = repeatOf(userText);
  if (repeat === null) return { seconds, title };
  const next = nextOccurrence(repeat, nowMs);
  return { seconds: Math.round((next - nowMs) / 1000), title, repeat };
}
