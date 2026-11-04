/**
 * 对话里的「定时提醒」：注入给模型的指令与回复里提醒标记的解析。
 *
 * 模型本身没有定时能力，它能做的只有把「几秒后提醒什么」写成一行标记；
 * 真正挂计时器、到点弹气泡的是 ./plugin/pet-reminders。
 * 所以这里只管两件纯逻辑的事：告诉模型怎么写、把标记从正文里剥出来。
 * @module dsh-pet/src/host/chat-reminder
 */

/** 一条解析出来的提醒：几秒后、提醒什么。 */
export interface ChatReminder {
  /** 相对现在多少秒后提醒（已换算成秒）。 */
  readonly seconds: number;
  /** 提醒事项（放在气泡标题里，所以要求短）。 */
  readonly title: string;
}

/** 最短提醒（秒）：再短就没有「提醒」的意义了，多半是模型把秒数算错。 */
export const REMINDER_MIN_SECONDS = 5;

/** 最长提醒（秒）：7 天。再长用户多半该用 DSH 的定时任务，而不是让桌宠挂着。 */
export const REMINDER_MAX_SECONDS = 7 * 24 * 60 * 60;

/** 标题最多几个字：气泡标题一行放得下。 */
export const REMINDER_TITLE_MAX = 40;

/** 时间单位的秒数换算。 */
const UNIT_SECONDS: Record<string, number> = {
  秒: 1,
  s: 1,
  分: 60,
  分钟: 60,
  m: 60,
  小时: 3600,
  h: 3600,
  天: 86400,
  d: 86400,
};

/**
 * 把当前时刻写成模型能读懂的一行（本地时间 + 时区偏移）。
 *
 * 模型要自己算「现在到 9 点还有多少秒」，不给它当前时间就只能瞎猜。
 *
 * @param now - 参考时刻。
 * @returns 形如 `2026-11-04 14:05（周三）` 的本地时间串。
 */
export function reminderNowText(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()] ?? '';
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}${week === '' ? '' : '（' + week + '）'}`;
}

/**
 * 提醒指令：附在 user 正文之后（与配图、动作指令并列）。
 *
 * 只给「怎么写标记」和「什么时候该写」；把换算说清楚（秒数）比给两个日期格式更不容易出错。
 *
 * @param now - 当前时刻，用来告诉模型时间基准。
 * @returns 追加到用户正文后的指令文本。
 */
export function reminderInstruction(now: Date): string {
  return (
    '\n\n[提醒] 用户让你在某个时间点提醒他做某件事时（例如「两分钟后提醒我开会」「明天 9 点叫我起床」），' +
    '先算出现在到那一刻还有多少秒，然后在回复最后另起一行写 [提醒:秒数|事项]。' +
    `秒数是 1 到 ${REMINDER_MAX_SECONDS} 之间的整数（最长 7 天），事项不超过 ${REMINDER_TITLE_MAX} 个字、只说做什么；` +
    '正文里先用一句话确认「好，几点提醒你做什么」。只写一条；用户没让你提醒时绝对不要写这个标记。' +
    `现在是 ${reminderNowText(now)}。`
  );
}

/**
 * 从模型回复里取提醒标记，并把本体剥掉。
 *
 * 宽容解析：模型可能写 `[提醒:120|开会]`，也可能写 `[提醒:2分钟|开会]`，两种都收；
 * 无法解析的标记照样剥掉（标记不属于用户可见文本），但不产生提醒。
 *
 * @param text - 模型回复原文。
 * @returns 剥掉标记后的正文，以及第一条合法提醒（没有就是 undefined）。
 */
export function extractChatReminder(text: string): { text: string; reminder?: ChatReminder } {
  const tag = /\[提醒[:：]\s*([^\]\n]{1,120})\]/g;
  let reminder: ChatReminder | undefined;
  let tagged = false;
  const cleaned = text.replace(tag, (_tag, raw: string) => {
    tagged = true;
    if (reminder === undefined) {
      const parsed = parseTagBody(raw);
      if (parsed !== null) reminder = parsed;
    }
    return '';
  });
  if (!tagged) return { text };
  // 与动作标记同一处理：剥完常留空行，压掉，否则气泡顶部多一截空白。
  const body = cleaned
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return reminder === undefined ? { text: body } : { text: body, reminder };
}

/**
 * 解析标记体：`秒数[单位]|事项`。
 *
 * @param raw - 方括号里的内容（已去掉 `[提醒:` 与 `]`）。
 * @returns 合法提醒；秒数不合法、缺分隔符或事项为空时返回 null。
 */
function parseTagBody(raw: string): ChatReminder | null {
  const cut = raw.search(/[|｜]/);
  if (cut < 0) return null;
  const delayText = raw.slice(0, cut).trim();
  const title = raw
    .slice(cut + 1)
    .trim()
    .replace(/[。．.]+$/, '');
  if (title === '' || title.length > REMINDER_TITLE_MAX) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(秒|分钟|分|小时|天|s|m|h|d)?$/i.exec(delayText);
  if (m === null) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2] === undefined ? 1 : (UNIT_SECONDS[m[2].toLowerCase()] ?? UNIT_SECONDS[m[2]]);
  if (unit === undefined) return null;
  const seconds = Math.round(amount * unit);
  if (seconds < REMINDER_MIN_SECONDS || seconds > REMINDER_MAX_SECONDS) return null;
  return { seconds, title };
}
