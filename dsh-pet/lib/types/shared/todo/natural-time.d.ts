/**
 * 解析一句话里的时间。
 *
 * @param input - 用户输入，如「5分钟后」「明天9点」「周五下午3点」。
 * @param now - 参照时刻；缺省为当前时间（测试里固定它）。
 * @returns 时间戳；看不懂时返回 null。
 */
export declare function parseNaturalTime(input: string, now?: Date): number | null;
