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

/** 改名标记：`[改名:新名字]` */
const RENAME_RE = /\[改名[:：]\s*([^[\]\n]{1,40})\]/gu;

/** 大小标记：`[大小:1.2]`（倍率，0.5–3） */
const SIZE_RE = /\[大小[:：]\s*([^[\]\n]{1,12})\]/gu;

/** 位置标记：`[位置:右下]`（也可写 top-left 等） */
const CORNER_RE = /\[位置[:：]\s*([^[\]\n]{1,20})\]/gu;

/** 记住标记：`[记住:一句话]` */
const REMEMBER_RE = /\[记住[:：]\s*([^[\]\n]{1,300})\]/gu;

/** 名字长度上限（字）：太长的名字在气泡与菜单里都放不下。 */
export const ACT_NAME_MAX = 20;

/** 缩放倍率的上下限：太小看不见，太大挡屏。 */
export const ACT_SIZE_MIN = 0.5;
export const ACT_SIZE_MAX = 3;

/** 一只宠物的落点。 */
export type PetCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 中文落点 → 配置里的 corner 值。 */
const CORNERS: Record<string, PetCorner> = {
  左上: 'top-left',
  右上: 'top-right',
  左下: 'bottom-left',
  右下: 'bottom-right',
  'top-left': 'top-left',
  'top-right': 'top-right',
  'bottom-left': 'bottom-left',
  'bottom-right': 'bottom-right',
};

/**
 * 「去屏幕中间」的说法。中间不是一个 corner——它不写进配置（下次启动仍回原来的角落），
 * 只是一次性的位置指令：游过去、待在那儿，等下一次位置指令或重启再回角落。
 */
const CENTER_WORDS = new Set(['中间', '中央', '正中', '中心', '屏幕中间', '桌面中间', '屏幕中央', '中间一点']);

/** 一条「记住」的长度上限（字）。 */
export const ACT_REMEMBER_MAX = 200;

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
}

/** 把模型写出来的名字整理成能落盘的形式：去引号/空白/句末标点，限长。 */
function cleanName(raw: string): string {
  const name = raw
    .trim()
    .replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/gu, '')
    .replace(/[。！？!?,，、\s]+$/u, '')
    .trim()
    .slice(0, ACT_NAME_MAX);
  return name;
}

/** 把「记住」的内容整理成一行；全是标点/空白时返回空串（没有可记的东西）。 */
function cleanRemember(raw: string): string {
  const body = raw.trim().replace(/\s+/gu, ' ').slice(0, ACT_REMEMBER_MAX);
  return /[\p{L}\p{N}]/u.test(body) ? body : '';
}

/**
 * 从模型回复里剥出「改名 / 记住」标记。
 *
 * 同一类标记出现多次时只认最后一个（模型偶尔会先写错再改口）；
 * 无效内容（空、全是标点）整条丢弃，标记照样剥掉——不能让它留在气泡里。
 *
 * @param text - 模型回复原文（已剥过动作/配图/提醒）。
 */
export function extractChatActs(text: string): ChatActs {
  let rename: string | undefined;
  let remember: string | undefined;
  let size: number | undefined;
  let corner: PetCorner | undefined;
  let center: true | undefined;
  const stripped = text
    .replace(RENAME_RE, (_match, raw: string) => {
      const name = cleanName(raw);
      if (name !== '') rename = name;
      return '';
    })
    .replace(REMEMBER_RE, (_match, raw: string) => {
      const body = cleanRemember(raw);
      if (body !== '') remember = body;
      return '';
    })
    .replace(SIZE_RE, (_match, raw: string) => {
      const value = Number(raw.trim());
      if (Number.isFinite(value) && value > 0) {
        size = Math.min(ACT_SIZE_MAX, Math.max(ACT_SIZE_MIN, value));
      }
      return '';
    })
    .replace(CORNER_RE, (_match, raw: string) => {
      const value = raw.trim();
      const mapped = CORNERS[value];
      if (mapped !== undefined) corner = mapped;
      else if (CENTER_WORDS.has(value)) center = true;
      return '';
    })
    .trim();
  return {
    text: stripped,
    ...(rename !== undefined ? { rename } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(corner !== undefined ? { corner } : {}),
    ...(center !== undefined ? { center } : {}),
  };
}

/**
 * 「能真正做事」的指令：告诉模型它不只会说话，还能改名、记事、改大小与换角落。
 *
 * 与提醒指令一样总是注入——不依赖任何清单，是用户「让她做点事」的唯一途径。
 * 措辞强调「只在主人明确要求时」：否则模型会把普通闲聊也变成一串标记。
 */
export function actInstruction(): string {
  return (
    '\n\n【你能真的做事】你不只会说话，还能真的改变自己（写了标记就会立刻生效，主人看得见）：\n' +
    '- 主人给你取新名字 → 回复末尾附 [改名:新名字]\n' +
    '- 主人要你长久记住一件事 → 回复末尾附 [记住:一句话]\n' +
    '- 主人说你太大/太小、让你变大变小 → 回复末尾附 [大小:倍率]（相对现在，0.5 到 3；「一点」约 1.2，「很多」约 1.5）\n' +
    '- 主人让你换个角落待着 → 回复末尾附 [位置:左上|右上|左下|右下]\n' +
    '- 主人让你到屏幕中间 / 桌面中间 → 回复末尾附 [位置:中间]\n' +
    '「变大一点」「挪到左上角」这类就是明确要求，必须附标记——只嘴上答应、不附标记，等于没做。\n' +
    '标记写在回复最后一行，正文照常自然地说，不要向主人解释标记本身。闲聊不要加。'
  );
}
