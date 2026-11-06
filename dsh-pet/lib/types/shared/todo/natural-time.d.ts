/**
 * 解析一句话里的时间。
 *
 * @param input - 用户输入，如「5分钟后」「明天9点」「周五下午3点」。
 * @param now - 参照时刻；缺省为当前时间（测试里固定它）。
 * @returns 时间戳；看不懂时返回 null。
 */
export declare function parseNaturalTime(input: string, now?: Date): number | null;
/** 一句话里解析出来的时间与正文：待办面板只要一个输入框就靠它。 */
export interface SentenceTime {
    /** 到期时刻（毫秒时间戳）。 */
    dueAt: number;
    /** 去掉时间短语、清掉前后语气词之后剩下的正文；可能为空串。 */
    text: string;
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
export declare function parseNaturalTimeInSentence(input: string, now?: Date): SentenceTime | null;
