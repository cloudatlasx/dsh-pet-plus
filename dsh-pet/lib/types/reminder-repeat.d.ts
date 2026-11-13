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
/**
 * 认出用户/模型说的周期。
 *
 * @param text - 一句话（用户原话或标记里的第三段）。
 * @returns 周期种类与（每周时的）星期；没有周期说法返回 null。
 */
export declare function repeatKindOf(text: string): {
    kind: RepeatKind;
    weekday?: number;
} | null;
/**
 * 从用户原话里读出完整的重复规则（周期 + 几点）。
 *
 * 周期与钟点必须同时出现：只说「每天」没有「几点」时没法排期，交给下一次对话确认。
 *
 * @param text - 用户这一句原话。
 * @returns 规则；缺周期或钟点返回 null。
 */
export declare function repeatOf(text: string): ReminderRepeat | null;
/**
 * 下一次触发时刻（严格晚于 `nowMs`）。
 *
 * 以本地时间对齐到整分：提醒说的是「11 点」，就不该在 11:00:31 响。
 *
 * @param repeat - 重复规则。
 * @param nowMs - 现在（毫秒时间戳）。
 * @returns 下一次的毫秒时间戳。
 */
export declare function nextOccurrence(repeat: ReminderRepeat, nowMs: number): number;
/**
 * 按某个时刻的钟点补出完整规则：标记里只有「每工作日」没有「几点」时用它。
 *
 * @param kind - 周期种类（可带 weekly 的星期）。
 * @param atMs - 已经算好的到点时刻；取它的本地时分。
 * @returns 带时分的完整规则。
 */
export declare function repeatAt(kind: {
    kind: RepeatKind;
    weekday?: number;
}, atMs: number): ReminderRepeat;
/** 把规则写成人话：`每个工作日 11:00`。 */
export declare function repeatLabel(repeat: ReminderRepeat): string;
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
export declare function inferRepeatReminder(userText: string, nowMs: number): {
    seconds: number;
    title: string;
    repeat: ReminderRepeat;
} | null;
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
export declare function applyRepeat(title: string, seconds: number, userText: string, nowMs: number): {
    seconds: number;
    title: string;
    repeat?: ReminderRepeat;
};
