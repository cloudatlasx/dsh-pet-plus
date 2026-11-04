/**
 * 共享层：「拍一拍」的分级反应规格（纯逻辑，无 IO、无 React）。
 *
 * 用户连点宠物 = 拍一拍。次数越多反应越差：前几次娇羞，再多有点不高兴，攒够了直接生气躲起来。
 * 阈值不写死——每一轮重新抽，且允许人设（条目级文案）自己定台词，这样同一个动作在不同人设下
 * 读起来是「这个角色被戳烦了」，而不是「程序走到第 10 次分支」。
 *
 * 这一层只回答三个问题：这轮阈值是多少、第 N 次算哪一档、躲多久。
 * 状态（连拍计数、计时器、写叶子）在宿主半侧 `host/pat.ts`。
 * @module dsh-pet/src/shared/pat
 */

/** 拍一拍的三档反应 + 躲起来之后回来的那一档。 */
export type PatTier = 'shy' | 'annoyed' | 'angry';

/** 一轮的阈值：`count <= shyUntil` 娇羞，`<= annoyedUntil` 不高兴，再多就生气。 */
export interface PatPlan {
  /** 娇羞的上界（含）。 */
  readonly shyUntil: number;
  /** 不高兴的上界（含）；超过就生气。 */
  readonly annoyedUntil: number;
}

/** 默认阈值基准：用户口述是「五次以内娇羞、五次以上不高兴、十次生气」，这里围绕它抖动。 */
export const PAT_SHY_BASE = 5;
export const PAT_ANNOYED_BASE = 10;

/** 抖动幅度：一次拍一到两次。每一轮重抽，让节奏不固定。 */
const pick = (roll: () => number, min: number, span: number): number =>
  min + Math.min(span, Math.floor(roll() * (span + 1)));

/**
 * 抽一轮阈值。
 *
 * 娇羞上界落在 4~6，生气点落在 9~12，且生气点至少比娇羞上界大 3——否则「有点生气」那一档会被挤没，
 * 用户永远看不到中间那层。
 *
 * @param roll - 随机源（0~1），测试注入固定值。
 */
export function planPats(roll: () => number = Math.random): PatPlan {
  const shyUntil = pick(roll, 4, 2);
  const annoyedUntil = Math.max(shyUntil + 3, pick(roll, 9, 3));
  return { shyUntil, annoyedUntil };
}

/** 第 `count` 次拍属于哪一档。 */
export function patTier(count: number, plan: PatPlan): PatTier {
  if (count <= plan.shyUntil) return 'shy';
  if (count <= plan.annoyedUntil) return 'annoyed';
  return 'angry';
}

/** 生完气躲起来的时长范围：一分钟到五分钟（用户要求「五分钟内随机」）。 */
export const PAT_HIDE_MIN_MS = 60 * 1000;
export const PAT_HIDE_MAX_MS = 5 * 60 * 1000;

/**
 * 抽一次躲起来的时长。
 *
 * 不用均匀分布：均匀会让「恰好五分钟」和「恰好一分钟」一样常见，读起来像定时器而不是情绪。
 * 这里偏向 1~3 分钟（`roll^1.6` 往小的一侧压），偶尔才会躲得久。
 *
 * @param roll - 随机源（0~1），测试注入固定值。
 */
export function hideDuration(roll: () => number = Math.random): number {
  const span = PAT_HIDE_MAX_MS - PAT_HIDE_MIN_MS;
  const skewed = Math.pow(roll(), 1.6);
  return Math.round(PAT_HIDE_MIN_MS + span * skewed);
}

/** 连拍计数多久之后作废（安静这么久 = 气消了、重新从娇羞数起）。 */
export const PAT_RESET_MS = 3 * 60 * 1000;

/** 每档台词的气泡停留时间：越生气留越久（短句也要让人看清）。 */
export const PAT_SAY_MS: Record<PatTier, number> = { shy: 4200, annoyed: 5200, angry: 7000 };

/** 回来那句的停留时间。 */
export const PAT_BACK_SAY_MS = 5200;

/**
 * 「说完再消失」之间留的间隔。
 *
 * 生气那条台词本身要占 `PAT_SAY_MS.angry`（7 秒）——把那句话先让人看见，再让窗口消失；
 * 这两个动作同时发生的话，用户只会看到「啪一下没了」，台词等于没说过。
 */
export const PAT_HIDE_GAP_MS = 900;

/** 干活时被拍的台词停留时间：短一点，别挡住它在做的事。 */
export const PAT_BUSY_SAY_MS = 4200;

/** 条目级台词池（人设的一部分，与睡觉三组台词同一套规则）。 */
export interface PatTexts {
  shy: string[];
  annoyed: string[];
  angry: string[];
  back: string[];
  /** 正在干活时被拍：不躲，只回头应一句（「我在忙，等我一下」）。 */
  busy: string[];
}

/** 池子收窄：非数组、非字符串项一律丢弃（配置已校验，这里只防手工改坏的文件）。 */
function pool(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/** 从条目配置里收窄出五组台词；空池 = 没配，调用方据此不说话。 */
export function patTextsOf(conf: Record<string, unknown>): PatTexts {
  return {
    shy: pool(conf.patShyTexts),
    annoyed: pool(conf.patAnnoyedTexts),
    angry: pool(conf.patAngryTexts),
    back: pool(conf.patBackTexts),
    busy: pool(conf.patBusyTexts),
  };
}

/**
 * 从池里挑一句，尽量不连续两次相同。
 *
 * 「尽量」指池里有多句时排除上一句；只有一句时只能重复（总比沉默好）。这样连拍时不会出现
 * 「别戳我啦」连着弹三遍的机械感。
 *
 * @param pool - 候选台词。
 * @param last - 上一次说的话（没有则空串）。
 * @param roll - 随机源（0~1），测试注入固定值。
 * @returns 选中的台词；池空返回 `undefined`。
 */
export function pickPatText(pool: readonly string[], last = '', roll: () => number = Math.random): string | undefined {
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];
  const candidates = pool.filter((text) => text !== last);
  const usable = candidates.length > 0 ? candidates : pool;
  return usable[Math.min(usable.length - 1, Math.floor(roll() * usable.length))];
}
