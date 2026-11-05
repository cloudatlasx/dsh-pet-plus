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
export declare const REMINDER_MIN_SECONDS = 5;
/** 最长提醒（秒）：7 天。再长用户多半该用 DSH 的定时任务，而不是让桌宠挂着。 */
export declare const REMINDER_MAX_SECONDS: number;
/** 标题最多几个字：气泡标题一行放得下。 */
export declare const REMINDER_TITLE_MAX = 40;
/**
 * 把当前时刻写成模型能读懂的一行（本地时间 + 时区偏移）。
 *
 * 模型要自己算「现在到 9 点还有多少秒」，不给它当前时间就只能瞎猜。
 *
 * @param now - 参考时刻。
 * @returns 形如 `2026-11-04 14:05（周三）` 的本地时间串。
 */
export declare function reminderNowText(now: Date): string;
/**
 * 提醒指令：附在 user 正文之后（与配图、动作指令并列）。
 *
 * 只给「怎么写标记」和「什么时候该写」；把换算说清楚（秒数）比给两个日期格式更不容易出错。
 *
 * @param now - 当前时刻，用来告诉模型时间基准。
 * @returns 追加到用户正文后的指令文本。
 */
export declare function reminderInstruction(now: Date): string;
/**
 * 从模型回复里取提醒标记，并把本体剥掉。
 *
 * 宽容解析：模型可能写 `[提醒:120|开会]`，也可能写 `[提醒:2分钟|开会]`，两种都收；
 * 无法解析的标记照样剥掉（标记不属于用户可见文本），但不产生提醒。
 *
 * @param text - 模型回复原文。
 * @returns 剥掉标记后的正文，以及第一条合法提醒（没有就是 undefined）。
 */
export declare function extractChatReminder(text: string): {
    text: string;
    reminder?: ChatReminder;
};
