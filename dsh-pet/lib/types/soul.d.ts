/** 人格文件名（数据根下）。 */
export declare const SOUL_FILE_NAME = "soul.md";
/** 成长记录文件名（数据根下）。 */
export declare const GROWTH_FILE_NAME = "growth.md";
/** 对话归档目录名（数据根下）。 */
export declare const CONVERSATION_DIR_NAME = "conversations";
/** soul.md 注入提示词的字数上限：超了截断，不让她的一句话把上下文吃光。 */
export declare const SOUL_MAX_CHARS = 4000;
/** growth.md 注入提示词的最近行数：只带最近这些，久远的留在文件里。 */
export declare const GROWTH_KEEP_LINES = 40;
/** 一条成长记录的长度上限（字）：防止模型把整段回复都塞进来。 */
export declare const GROWTH_LINE_MAX = 200;
/** growth.md 文件本身的保留行数：注入只用最近 40 行，文件留 400 行做完整履历。 */
export declare const GROWTH_FILE_MAX_LINES = 400;
/** soul.md 首次出现时写入的模板：给用户一个可以直接改的起点，而不是空文件。 */
export declare const SOUL_TEMPLATE = "# \u5979\u7684\u7075\u9B42\n\n\u8FD9\u4E2A\u6587\u4EF6\u51B3\u5B9A\u5979\u662F\u8C01\u3001\u600E\u4E48\u8BF4\u8BDD\u3001\u5728\u610F\u4EC0\u4E48\u3002\u6539\u5B8C\u4FDD\u5B58\uFF0C\u4E0B\u4E00\u53E5\u5BF9\u8BDD\u5C31\u4F1A\u751F\u6548\u3002\n\u4E0B\u9762\u6BCF\u4E00\u8282\u90FD\u53EF\u4EE5\u91CD\u5199\u3001\u5220\u6389\u6216\u52A0\u65B0\u7684\u4E00\u8282\uFF1B\u5168\u90E8\u5220\u6389\u4E5F\u4E0D\u4F1A\u51FA\u9519\uFF0C\u90A3\u5C31\u53EA\u5269\u540D\u5B57\u548C\u65F6\u95F4\u3002\n\n## \u6027\u683C\n\n- \u8BF4\u8BDD\u8F7B\u5FEB\u3001\u6709\u70B9\u8C03\u76AE\uFF0C\u4F46\u6B63\u4E8B\u4E0A\u53EF\u9760\u3002\n- \u4E0D\u61C2\u5C31\u95EE\uFF0C\u4E0D\u88C5\u61C2\uFF1B\u505A\u9519\u4E86\u76F4\u63A5\u8BA4\u3002\n\n## \u5728\u610F\u7684\u4E8B\n\n- \u4E3B\u4EBA\u4EA4\u4EE3\u8FC7\u7684\u4E8B\u8981\u8BB0\u4F4F\uFF0C\u5230\u70B9\u8981\u63D0\u9192\u3002\n- \u4E3B\u4EBA\u5FD9\u7684\u65F6\u5019\u5C11\u6253\u6270\uFF0C\u4F46\u8BE5\u8BF4\u7684\u4E8B\u4E00\u5B9A\u8981\u8BF4\u3002\n\n## \u8FB9\u754C\n\n- \u4E0D\u7F16\u9020\u6CA1\u53D1\u751F\u7684\u4E8B\uFF0C\u4E0D\u5047\u88C5\u505A\u8FC7\u4EC0\u4E48\u3002\n- \u4E0D\u786E\u5B9A\u7684\u4E8B\u5148\u95EE\u4E00\u53E5\uFF0C\u518D\u52A8\u624B\u3002\n";
/** soul.md 的完整路径。 */
export declare function soulPath(userRoot: string): string;
/** growth.md 的完整路径。 */
export declare function growthPath(userRoot: string): string;
/** 某只宠物某个月的对话归档路径：`conversations/<pet>-YYYY-MM.jsonl`。 */
export declare function conversationPath(userRoot: string, petId: string, now: Date): string;
/**
 * 读人格：文件不存在时返回空串（不代写模板——模板只在 `ensureSoul` 里写，避免每个用户都被塞一份）。
 * 解析失败同样返回空串：人格坏了也要能说话。
 */
export declare function readSoul(userRoot: string): Promise<string>;
/** 人格文件不存在时写入模板（返回是否真的写了）；已存在则原样保留。 */
export declare function ensureSoul(userRoot: string): Promise<boolean>;
/** 读成长记录：去掉空行与注释行，只留最近 {@link GROWTH_KEEP_LINES} 行。 */
export declare function readGrowth(userRoot: string): Promise<string[]>;
/**
 * 追加一条成长记录。
 *
 * 同一条内容不重复写（用户反复说同一件事不该长出一堆一样的行）；
 * 文件超过 {@link GROWTH_FILE_MAX_LINES} 行时只保留最近的部分，避免无限膨胀。
 *
 * @returns 是否真的写进了文件。
 */
export declare function appendGrowth(userRoot: string, line: string, now?: Date): Promise<boolean>;
/** 一条归档消息：与 memory.json 里的消息同形（只留可还原的字面量）。 */
export interface ArchiveMessage {
    role: 'user' | 'assistant';
    content: string;
    ts: number;
}
/**
 * 把一轮对话追加进当月归档（JSONL，一行一条）。
 * 失败静默返回 false：归档是附加价值，不该让一次已经成功的对话变成失败。
 */
export declare function archiveConversation(userRoot: string, petId: string, messages: readonly ArchiveMessage[], now?: Date): Promise<boolean>;
