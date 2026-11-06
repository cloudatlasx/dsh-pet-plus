/**
 * 把一句话说的时间解析成时间戳：待办的「提醒时间」用它，不用先点日历再挑数字。
 *
 * 支持的说法（去掉空白后匹配，全角数字与冒号会先归一）：
 * - 相对：`5分钟后`、`半个小时之后`、`一个半小时后`、`两小时`、`三天后`、`两周后`、`一个月后`；
 * - 日子：`今天`、`明天`、`后天`、`大后天`、`周五`、`星期五`、`下周一`、`周三下午`；
 * - 时刻：`9点`、`9点半`、`9点20`、`21:30`、`下午3点`、`晚上八点`、`早上七点一刻`；
 * - 组合：`明天早上九点`、`下周一上午10点半`、`今晚8点`、`8月20日 14:00`。
 *
 * 只给日子不给时刻时，默认当天早上九点（与日历选择器的默认值一致）；只给时刻且今天已经过了，
 * 就顺延到明天。解析不出来返回 null——调用方自己决定提示什么，这里不猜。
 * @module dsh-pet/src/shared/todo/natural-time
 */
/** 只说了日子、没说时刻时的默认钟点（与日历选择器的 `DEFAULT_HOUR` 一致）。 */
const DEFAULT_DUE_HOUR = 9;

/** 相对时间的单位（毫秒）。`个月` 按 30 天算：只用于「一个月后」这类粗粒度说法。 */
const UNIT_MS: Readonly<Record<string, number>> = {
  秒: 1000,
  秒钟: 1000,
  分: 60 * 1000,
  分钟: 60 * 1000,
  小时: 60 * 60 * 1000,
  钟头: 60 * 60 * 1000,
  天: 24 * 60 * 60 * 1000,
  日: 24 * 60 * 60 * 1000,
  周: 7 * 24 * 60 * 60 * 1000,
  星期: 7 * 24 * 60 * 60 * 1000,
  礼拜: 7 * 24 * 60 * 60 * 1000,
  个月: 30 * 24 * 60 * 60 * 1000,
  月: 30 * 24 * 60 * 60 * 1000,
};

/** 时刻前的时段词与它带来的偏移（下午 3 点 = 15 点）。 */
const PERIODS: ReadonlyArray<readonly [string, number]> = [
  ['凌晨', 0],
  ['清晨', 0],
  ['早上', 0],
  ['早晨', 0],
  ['上午', 0],
  ['中午', 12],
  ['下午', 12],
  ['傍晚', 12],
  ['傍晚', 12],
  ['晚上', 12],
  ['夜里', 12],
  ['夜间', 12],
];

/** 日子词与相对今天的天数；长的写在前面，先匹配「大后天」再匹配「后天」。 */
const DAY_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['大后天', 3],
  ['后天', 2],
  ['明天', 1],
  ['明日', 1],
  ['今天', 0],
  ['今日', 0],
];

/** 「今晚 / 明晚 / 昨晚」这类把日子和晚上连在一起的说法。 */
const EVENING_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['明晚', 1],
  ['今晚', 0],
  ['今儿晚上', 0],
];

/** 周几：周一为 1，周日为 7。 */
const WEEK_DAYS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

/** 中文数字（含「十」「十二」「二十」这类组合），解析不了返回 null。 */
function chineseNumber(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === '半') return 0.5;
  // 一个半 / 两个半
  const half = /^(.+)个半$/.exec(raw);
  if (half) {
    const base = chineseNumber(half[1]);
    return base === null ? null : base + 0.5;
  }
  const trimmed = raw.endsWith('个') ? raw.slice(0, -1) : raw;
  const digits: Readonly<Record<string, number>> = {
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
  const ten = /^([零一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(trimmed);
  if (ten) {
    const high = ten[1] ? digits[ten[1]] : 1;
    const low = ten[2] ? digits[ten[2]] : 0;
    return high * 10 + low;
  }
  if (trimmed.length === 1 && trimmed in digits) return digits[trimmed];
  return null;
}

/** 当天零点。 */
function startOfDay(base: Date): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate());
}

/** 加天数（跨月由 Date 自己处理）。 */
function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/** 本周一（周一为一周首日）。 */
function mondayOf(base: Date): Date {
  const day = base.getDay(); // 0 = 周日
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(startOfDay(base), offset);
}

/** 全角转半角 + 去掉空白，让后续正则只面对一种写法。 */
function normalize(input: string): string {
  return input
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uFF1A/g, ':')
    .replace(/\s+/g, '');
}

/** 相对时间：`5分钟后`、`一个半小时后`、`两小时`。 */
function matchRelative(text: string, now: Date): number | null {
  const m = /^(.+?)(?:个)?(秒钟|秒|分钟|分|小时|钟头|天|日|周|星期|礼拜|个月|月)(?:之后|以后|后|内)?$/.exec(text);
  if (!m) return null;
  const unit = UNIT_MS[m[2]];
  if (unit === undefined) return null;
  const amount = chineseNumber(m[1]);
  if (amount === null || amount <= 0) return null;
  return now.getTime() + Math.round(amount * unit);
}

/** 解析「9点」「9点半」「9点20」「21:30」「七点一刻」「八点半」；返回时刻与剩下的文本。 */
function parseClock(text: string): { hour: number; minute: number; rest: string } | null {
  const colon = /^(\d{1,2}):(\d{2})/.exec(text);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, rest: text.slice(colon[0].length) };
  }
  const m = /^(\d{1,2}|[零一二两三四五六七八九十]{1,3})[点时]/.exec(text);
  if (!m) return null;
  const hour = chineseNumber(m[1]);
  if (hour === null || hour > 24) return null;
  let rest = text.slice(m[0].length);
  let minute = 0;
  if (rest.startsWith('半')) {
    minute = 30;
    rest = rest.slice(1);
  } else if (rest.startsWith('一刻')) {
    minute = 15;
    rest = rest.slice(2);
  } else if (rest.startsWith('三刻')) {
    minute = 45;
    rest = rest.slice(2);
  } else {
    const mm = /^(\d{1,2}|[零一二两三四五六七八九十]{1,3})分?/.exec(rest);
    const parsed = mm ? chineseNumber(mm[1]) : null;
    if (mm && parsed !== null) {
      minute = parsed;
      rest = rest.slice(mm[0].length);
    }
  }
  if (minute > 59) return null;
  return { hour, minute, rest };
}

/**
 * 把开头的时间短语解析出来，并告诉调用方它吃掉了几个字。
 *
 * @param text - 已归一化的文本（去空白、全角转半角）。
 * @param now - 参照时刻。
 * @returns 时刻与消耗的字符数；解析不出来返回 null。
 */
function matchTime(text: string, now: Date): { ms: number; consumed: number } | null {
  if (!text) return null;

  const relative = matchRelative(text, now);
  if (relative !== null) return { ms: relative, consumed: text.length };

  let rest = text;
  let day: Date | null = null;
  // 时段带来的钟点偏移：今晚 / 晚上 的 8 点 = 20 点
  let shift = 0;

  // 今晚 / 明晚：日子与「晚上」一次说完
  for (const [word, offset] of EVENING_WORDS) {
    if (rest.startsWith(word)) {
      day = addDays(startOfDay(now), offset);
      shift = 12;
      rest = rest.slice(word.length);
      break;
    }
  }

  // 今天 / 明天 / 后天 / 大后天
  if (day === null) {
    for (const [word, offset] of DAY_WORDS) {
      if (rest.startsWith(word)) {
        day = addDays(startOfDay(now), offset);
        rest = rest.slice(word.length);
        break;
      }
    }
  }

  // 周五 / 星期五 / 下周一 / 这周三
  if (day === null) {
    const week = /^(下下|下|这|本|上)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(rest);
    if (week) {
      const target = WEEK_DAYS[week[2]];
      const monday = mondayOf(now);
      let offset = target - 1;
      if (week[1] === '下') offset += 7;
      else if (week[1] === '下下') offset += 14;
      else if (week[1] === '上') offset -= 7;
      else if (week[1] === undefined && offset < now.getDay() - 1) offset += 7; // 本周的这天已经过了 → 指下周
      day = addDays(monday, offset);
      rest = rest.slice(week[0].length);
    }
  }

  // 8月20日 / 8-20 / 8/20（没有年份，落在今天之后最近的那一次）
  if (day === null) {
    const md = /^(\d{1,2})[月\-/](\d{1,2})日?/.exec(rest);
    if (md) {
      const month = Number(md[1]) - 1;
      const date = Number(md[2]);
      if (month >= 0 && month <= 11 && date >= 1 && date <= 31) {
        const thisYear = new Date(now.getFullYear(), month, date);
        day = thisYear.getTime() < startOfDay(now).getTime() ? new Date(now.getFullYear() + 1, month, date) : thisYear;
        rest = rest.slice(md[0].length);
      }
    }
  }

  // 时段词：下午 / 晚上 / 早上 …
  for (const [word, offset] of PERIODS) {
    if (rest.startsWith(word)) {
      shift = offset;
      rest = rest.slice(word.length);
      break;
    }
  }

  // 时刻
  const clock = parseClock(rest);
  if (clock) {
    let { hour } = clock;
    const { minute } = clock;
    // 下午/晚上/傍晚 的 1~11 点顺延 12 小时；中午 12 点就是 12 点
    if (shift === 12 && hour < 12) hour += 12;
    if (hour === 24) hour = 0;
    if (hour > 23) return null;
    const base = day ?? startOfDay(now);
    let ms = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
    // 只给时刻、且今天这一刻已经过了 → 顺延到明天同一时刻（「9点」在下午说，指明天九点）
    if (day === null && ms <= now.getTime()) {
      ms = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime();
    }
    return { ms, consumed: text.length - clock.rest.length };
  }

  // 只说了日子、没说时刻：默认早上九点（与日历选择器的默认值一致）
  if (day === null) return null;
  const ms = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DEFAULT_DUE_HOUR, 0, 0, 0).getTime();
  return { ms, consumed: text.length - rest.length };
}

/**
 * 解析一句话里的时间。
 *
 * @param input - 用户输入，如「5分钟后」「明天9点」「周五下午3点」。
 * @param now - 参照时刻；缺省为当前时间（测试里固定它）。
 * @returns 时间戳；看不懂时返回 null。
 */
export function parseNaturalTime(input: string, now: Date = new Date()): number | null {
  const matched = matchTime(normalize(input), now);
  return matched === null ? null : matched.ms;
}

/** 一句话里解析出来的时间与正文：待办面板只要一个输入框就靠它。 */
export interface SentenceTime {
  /** 到期时刻（毫秒时间戳）。 */
  dueAt: number;
  /** 去掉时间短语、清掉前后语气词之后剩下的正文；可能为空串。 */
  text: string;
}

/** 一句话里找时间短语时最多扫多少字：`下下周一上午十点半` 也就十来字。 */
const PHRASE_SCAN_MAX = 16;

/** 粗筛：先看有没有像时间的字，再逐个跑完整语法，省得每个子串都解析一遍。 */
const TIME_HINT =
  /[0-9零一二两三四五六七八九十百半今明后大点时秒分天日周月年下这本上]|星期|礼拜|上午|下午|晚上|早上|中午|傍晚|凌晨|夜/u;

/** 句首常见的口头语，剥掉它们剩下才是「要做什么」。 */
const LEADING_FILLERS = /^(?:记得|提醒我一下|提醒我|提醒一下|提醒下|到时候|到点|帮我记一下|帮我|麻烦你|麻烦|请)/u;

/** 句尾常见的口头语。 */
const TRAILING_FILLERS = /(?:的时候|时|别忘了|记得|提醒我)$/u;

/** 把归一化后的字符数换算回原始字符串里的下标终点。 */
function sourceEnd(source: string, normalizedCount: number): number {
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/.test(source[index])) continue;
    count += 1;
    if (count >= normalizedCount) return index + 1;
  }
  return source.length;
}

/** 剥掉句首句尾的口头语与标点。 */
function trimFillers(raw: string): string {
  let text = raw.replace(/^[\s，,。.、；;：:！!？?]+/u, '').replace(/[\s，,。.、；;：:！!？?]+$/u, '');
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(LEADING_FILLERS, '').replace(TRAILING_FILLERS, '').trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * 从一句完整的话里挑出时间短语：`五分钟后提醒我拿快递` → 5 分钟后 + `拿快递`。
 *
 * 先整句试一次（输入本身就是时间短语），再按「最早出现、且整段都能被解析成时间」的规则扫子串，
 * 这样 `明天早上九点开会` 只会吃掉 `明天早上九点`，不会把 `开会` 也当成时间。
 * 找不到时间就返回 null，由调用方决定怎么提示——这里不猜。
 *
 * @param input - 用户输入的一句话。
 * @param now - 参照时刻；缺省为当前时间（测试里固定它）。
 * @returns 到期时刻与剩下的正文；没听出时间时返回 null。
 */
export function parseNaturalTimeInSentence(input: string, now: Date = new Date()): SentenceTime | null {
  const text = input.trim();
  if (!text) return null;
  const whole = normalize(text);
  const wholeMatch = matchTime(whole, now);
  if (wholeMatch !== null && wholeMatch.consumed === whole.length) return { dueAt: wholeMatch.ms, text: '' };

  let best: { dueAt: number; start: number; end: number } | null = null;
  for (let start = 0; start < text.length; start += 1) {
    if (!TIME_HINT.test(text[start])) continue;
    const maxSpan = Math.min(PHRASE_SCAN_MAX, text.length - start);
    for (let span = maxSpan; span >= 2; span -= 1) {
      const chunk = text.slice(start, start + span);
      const normalized = normalize(chunk);
      if (!normalized) continue;
      const matched = matchTime(normalized, now);
      // 只认「整段都是时间」的子串：半截匹配会把后面的正文一起当成时间吃掉。
      if (matched === null || matched.consumed !== normalized.length) continue;
      const end = start + sourceEnd(chunk, matched.consumed);
      if (best === null || end - start > best.end - best.start) best = { dueAt: matched.ms, start, end };
      break;
    }
  }
  if (best === null) return null;
  return { dueAt: best.dueAt, text: trimFillers(text.slice(0, best.start) + ' ' + text.slice(best.end)) };
}
