/**
 * 对话里的「真去做事」标记：改名、记住、改大小、换角落。
 *
 * 与动作/配图/提醒同一套机制——模型在回复末尾附一个方括号标记，宿主剥掉它并真的执行。
 * 这里只做纯文本解析与指令拼装，不碰配置、不写文件：
 * - 改名 / 大小 / 角落由 ./plugin/chat-memory 调 `renamePet` / `configurePet`
 *   （走 `saveUserConfig`，与设置页同一条写盘路径）；
 * - 「记住」由 ./soul 追加进 `growth.md`。
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
/** 一条「记住」的长度上限（字）。 */
export declare const ACT_REMEMBER_MAX = 200;
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
 * 「能真正做事」的指令：告诉模型它不只会说话，还能改名、记事、改大小与换角落。
 *
 * 与提醒指令一样总是注入——不依赖任何清单，是用户「让她做点事」的唯一途径。
 * 措辞强调「只在主人明确要求时」：否则模型会把普通闲聊也变成一串标记。
 */
export declare function actInstruction(): string;
