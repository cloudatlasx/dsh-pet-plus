/**
 * 拍一拍（host 半侧）：连拍计数、分级反应、气够了躲起来一阵再回来。
 *
 * 状态是内存态（重启即清），和占用锁、睡觉是同一层：它描述的只是「这只宠物此刻的心情」，
 * 不是用户的配置。心情对外体现为两个叶子：`say`（台词气泡）与 `hidden`（躲起来了）。
 *
 * 阈值每一轮重抽、台词从条目配置里挑，代码里不写死任何一句——人设怎么写它就怎么气。
 * 计时器只负责「过一会儿露面」，丢了也不会卡死：`hiddenUntil` 是唯一真相，渲染端与这里都按它判。
 * @module dsh-pet/src/host/pat
 */

import {
  PAT_BACK_SAY_MS,
  PAT_RESET_MS,
  PAT_SAY_MS,
  hideDuration,
  patTextsOf,
  patTier,
  pickPatText,
  planPats,
  type PatTexts,
  type PatTier,
} from '../shared/pat.ts';

/** 写进 `pets.<id>.hidden` 的载荷：躲起来了（带解除时刻）或已经回来。 */
export type HiddenLeafData = { hidden: true; until: number } | { hidden: false };

/** 一次拍一拍的结果（路由据此回执，渲染端不需要它）。 */
export interface PatDecision {
  /** 这一拍落在哪一档。 */
  readonly tier: PatTier;
  /** 当前连拍次数（含这一拍）。 */
  readonly count: number;
  /** 这一轮重新抽过的阈值。 */
  readonly plan: { shyUntil: number; annoyedUntil: number };
  /** 要说的话；`undefined` = 不说话（没配台词，或这会儿正躲着）。 */
  readonly text: string | undefined;
  /** 真的躲起来了才非 0：躲多久（毫秒）。 */
  readonly hideMs: number;
  /** 正躲着时又来一拍：受理但什么也不做（窗口本来就看不见它）。 */
  readonly ignored: boolean;
}

/** 单只宠物的心情状态。 */
interface Mood {
  count: number;
  lastAt: number;
  plan: { shyUntil: number; annoyedUntil: number };
  lastText: string;
  /** 躲到什么时候（毫秒时间戳）；0 = 没躲。 */
  hiddenUntil: number;
  /** 等它回来的计时器（可能为 null：计时器丢了也能靠 hiddenUntil 判）。 */
  timer: { stop: () => void } | null;
}

/** 构造输入：全部依赖显式传入，模块内不读全局、不建单例。 */
export interface PatStoreInput {
  /** 该宠物所属条目的四组台词。 */
  readonly textsOf: (petId: string) => PatTexts;
  /** 写 `hidden` 叶子。 */
  readonly onChange: (petId: string, data: HiddenLeafData) => void;
  /** 让它说一句（写 `say` 叶子）。 */
  readonly onSay: (petId: string, text: string, duration: number) => void;
  /** 时钟，测试注入；缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 随机源，测试注入；缺省 `Math.random`。 */
  readonly roll?: () => number;
  /** 躲多久，测试注入；缺省 `hideDuration`。 */
  readonly hideMs?: (roll: () => number) => number;
}

/** 拍一拍状态机。 */
export class PatStore {
  private readonly moods = new Map<string, Mood>();
  private readonly deps: PatStoreInput;
  private readonly now: () => number;
  private readonly roll: () => number;
  private readonly hideMs: (roll: () => number) => number;

  constructor(deps: PatStoreInput) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.roll = deps.roll ?? Math.random;
    this.hideMs = deps.hideMs ?? hideDuration;
  }

  /** 这只宠物此刻是否躲着（懒判，只看 hiddenUntil）。 */
  hidden(petId: string): boolean {
    const mood = this.moods.get(petId);
    return mood !== undefined && mood.hiddenUntil > this.now();
  }

  /** 拍一下。 */
  pat(petId: string): PatDecision {
    const mood = this.moodOf(petId);
    const now = this.now();
    // 正躲着：受理但不反应。它的窗口/卡片这会儿根本不在，属于重复上报。
    if (mood.hiddenUntil > now) {
      return { tier: 'angry', count: mood.count, plan: mood.plan, text: undefined, hideMs: 0, ignored: true };
    }
    // 安静够久了：气消了，重新从娇羞数起（这也是「次数不固定」的一部分）。
    if (now - mood.lastAt > PAT_RESET_MS) {
      mood.count = 0;
      mood.plan = planPats(this.roll);
      mood.lastText = '';
    }
    mood.count += 1;
    mood.lastAt = now;
    const tier = patTier(mood.count, mood.plan);
    const texts = this.deps.textsOf(petId);
    const text = pickPatText(texts[tier], mood.lastText, this.roll);
    if (text !== undefined) {
      mood.lastText = text;
      this.deps.onSay(petId, text, PAT_SAY_MS[tier]);
    }
    if (tier !== 'angry') {
      return { tier, count: mood.count, plan: mood.plan, text, hideMs: 0, ignored: false };
    }
    // 生气了：躲起来。躲的时长每次都重抽，回来时补一句台词，并把计数清零
    // ——它「消气」了，下一次被戳应该重新害羞，而不是永远在生气档。
    const ms = this.hideMs(this.roll);
    mood.hiddenUntil = now + ms;
    this.deps.onChange(petId, { hidden: true, until: mood.hiddenUntil });
    this.scheduleReturn(petId, mood, ms);
    return { tier, count: mood.count, plan: mood.plan, text, hideMs: ms, ignored: false };
  }

  /** 忘掉一只宠物的心情（宠物被删/重载时用）。 */
  forget(petId: string): void {
    const mood = this.moods.get(petId);
    if (mood?.timer) mood.timer.stop();
    this.moods.delete(petId);
  }

  /** 插件卸载：清掉所有计时器，免得重载后旧实例还在写叶子。 */
  dispose(): void {
    for (const mood of this.moods.values()) if (mood.timer) mood.timer.stop();
    this.moods.clear();
  }

  /** 取（并在必要时新建）一只宠物的心情。 */
  private moodOf(petId: string): Mood {
    const found = this.moods.get(petId);
    if (found) return found;
    const fresh: Mood = { count: 0, lastAt: 0, plan: planPats(this.roll), lastText: '', hiddenUntil: 0, timer: null };
    this.moods.set(petId, fresh);
    return fresh;
  }

  /** 安排「过一会儿露面」。令牌比对：中途被 forget/dispose 掉就不再写叶子。 */
  private scheduleReturn(petId: string, mood: Mood, ms: number): void {
    if (mood.timer) mood.timer.stop();
    const timer = setTimeout(() => {
      mood.timer = null;
      if (mood.hiddenUntil === 0) return; // 已经被 forget 或新一轮接管
      mood.hiddenUntil = 0;
      mood.count = 0;
      mood.plan = planPats(this.roll);
      mood.lastText = '';
      this.deps.onChange(petId, { hidden: false });
      const back = pickPatText(this.deps.textsOf(petId).back, '', this.roll);
      if (back !== undefined) {
        mood.lastText = back;
        this.deps.onSay(petId, back, PAT_BACK_SAY_MS);
      }
    }, ms);
    // 不拖住进程退出：宠物躲着的时候用户可以随时关掉 DSH。
    (timer as unknown as { unref?: () => void }).unref?.();
    mood.timer = { stop: () => clearTimeout(timer) };
  }
}

/** 条目级四组台词的类型收窄再导出，路由与测试都从这里取。 */
export { patTextsOf };
