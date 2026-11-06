/**
 * 对话里的「真去做事」标记：改名、记住、改大小、换角落、别消失。
 *
 * 与动作/配图/提醒同一套机制——模型在回复末尾附一个方括号标记，宿主剥掉它并真的执行。
 * 这里只做纯文本解析与指令拼装，不碰配置、不写文件：
 * - 改名 / 大小 / 角落由 ./plugin/chat-memory 调 `renamePet` / `configurePet`
 *   （走 `saveUserConfig`，与设置页同一条写盘路径）；
 * - 「记住」由 ./soul 追加进 `growth.md`；
 * - 「别消失」写 ./prefs 的 `preferences.json`（立即可读，不重启 Helper）。
 *
 * 标记故意用中文且与正文区分明显：模型照抄过一次也不会被误当成玩笑话。
 * @module dsh-pet/src/host/chat-acts
 */
/** 名字长度上限（字）：太长的名字在气泡与菜单里都放不下。 */
export declare const ACT_NAME_MAX = 20;
/** 缩放倍率的上下限：太小看不见，太大挡屏。 */
export declare const ACT_SIZE_MIN = 0.5;
export declare const ACT_SIZE_MAX = 3;
/** 一只宠物的落点。 */
export type PetCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/**
 * 主人明说要「去中间」的确定性兜底。
 *
 * 模型偶尔会漏写 `[位置:中间]`——嘴上答应了、位置没动，用户就会觉得「让她到中间她不会过去」。
 * 所以位置意图要有一次关键词兜底：同时出现「中间/中央」与一个移动词（或整句就以「中间」开头，
 * 例如「中间一点」）才算，避免把「把待办放中间」这类普通聊天误判成移动指令。
 */
export declare function wantsCenter(text: string): boolean;
/** 一条「记住」的长度上限（字）。 */
export declare const ACT_REMEMBER_MAX = 200;
/**
 * 「以后别消失」的确定性兜底。
 *
 * 这是**长期指令**（写偏好，不是一次性动作），但模型很容易把「别消失」「别躲了」当成
 * 一句撒娇的闲聊，于是嘴上答应、下次照样躲。关键词一旦命中就直接按指令执行：
 * 返回 `false` = 别再躲，`true` = 可以躲，`undefined` = 没听出来（交给模型标记决定）。
 */
export declare function wantsHide(text: string): boolean | undefined;
/** 解析结果：剥掉标记后的正文 + 要执行的动作用。 */
export interface ChatActs {
    /** 剥掉标记后的正文（可能为空串：模型只写了标记）。 */
    text: string;
    /** 新名字（已 trim、去引号、限长）。 */
    rename?: string;
    /** 要长久记住的一句话。 */
    remember?: string;
    /** 缩放倍率（已夹到 0.5–3）。 */
    size?: number;
    /** 换到的角落。 */
    corner?: PetCorner;
    /** 要游到屏幕中间（一次性位置指令，不写配置）。 */
    center?: true;
    /** 要不要允许躲起来消失（长期指令，写 preferences.json）。 */
    hide?: boolean;
}
/**
 * 从模型回复里剥出「改名 / 记住」标记。
 *
 * 同一类标记出现多次时只认最后一个（模型偶尔会先写错再改口）；
 * 无效内容（空、全是标点）整条丢弃，标记照样剥掉——不能让它留在气泡里。
 *
 * @param text - 模型回复原文（已剥过动作/配图/提醒）。
 */
export declare function extractChatActs(text: string): ChatActs;
/**
 * 「能真正做事」的指令：告诉模型它不只会说话，还能改名、记事、改大小、换角落、改变消失偏好。
 *
 * 与提醒指令一样总是注入——不依赖任何清单，是用户「让她做点事」的唯一途径。
 * 开头先要求「分清指令与闲聊」：用户抱怨过「我说让她别消失，她当聊天答应了却没做」，
 * 根因是模型把所有话都当闲聊。措辞强调「只在主人明确要求时」：否则模型会把普通闲聊变成一串标记。
 */
export declare function actInstruction(): string;
