/**
 * 拍一拍（host 半侧）：连拍计数、分级反应、气够了先说一句再躲起来。
 *
 * 状态是内存态（重启即清），和占用锁、睡觉是同一层：它描述的只是「这只宠物此刻的心情」，
 * 不是用户的配置。心情对外体现为两个叶子：`say`（台词气泡）与 `hidden`（躲起来了）。
 *
 * 两条规矩决定了这里的时间线：
 * 1. **先说再消失**：生气那句台词要说完（`PAT_SAY_MS.angry`）再隐窗口，否则用户只看到「啪一下没了」，
 *    话等于没说过。所以 `hiddenUntil` 记的是「回来时刻」，`hideAt` 记的是「消失时刻」——两个都得有。
 * 2. **工作优先**：它手上有回合在跑（thinking/working/result/waiting）时不躲，只回头说一句
 *    （`patBusyTexts`）继续做；消失前一刻开始干活的，也当场作废这次躲藏。
 *
 * 阈值每一轮重抽、台词从条目配置里挑，代码里不写死任何一句——人设怎么写它就怎么气。
 * 计时器只负责「到点消失/到点露面」，丢了也不会卡死：`hiddenUntil` 是唯一真相，渲染端与这里都按它判。
 * @module dsh-pet/src/host/pat
 */

import {
  PAT_BACK_SAY_MS,
  PAT_BUSY_SAY_MS,
  PAT_HIDE_GAP_MS,
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
  /** 正躲着（或马上就要消失）时又来一拍：受理但什么也不做。 */
  readonly ignored: boolean;
  /** 这一拍正好赶上它在干活：工作优先，不躲，继续做手上的事。 */
  readonly busy: boolean;
}

/** 单只宠物的心情状态。 */
interface Mood {
  count: number;
  lastAt: number;
  plan: { shyUntil: number; annoyedUntil: number };
  lastText: string;
  /** 什么时候回来（毫秒时间戳）；0 = 没在躲。 */
  hiddenUntil: number;
  /** 什么时候真正消失（毫秒时间戳）；0 = 还看得见（没躲，或正在说最后那句）。 */
  hideAt: number;
  /** 等它消失的计时器（先说再消失的那段延迟）。 */
  hideTimer: { stop: () => void } | null;
  /** 等它回来的计时器（可能为 null：计时器丢了也能靠 hiddenUntil 判）。 */
  returnTimer: { stop: () => void } | null;
}

/** 构造输入：全部依赖显式传入，模块内不读全局、不建单例。 */
export interface PatStoreInput {
  /** 该宠物所属条目的五组台词。 */
  readonly textsOf: (petId: string) => PatTexts;
  /** 写 `hidden` 叶子。 */
  readonly onChange: (petId: string, data: HiddenLeafData) => void;
  /** 让它说一句（写 `say` 叶子）。 */
  readonly onSay: (petId: string, text: string, duration: number) => void;
  /** 这只宠物此刻是不是在干活（有回合在跑）。缺省 = 永远不在忙。 */
  readonly busyOf?: (petId: string) => boolean;
  /** 时钟，测试注入；缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 随机源，测试注入；缺省 `Math.random`。 */
  readonly roll?: () => number;
  /** 躲多久，测试注入；缺省 `hideDuration`。 */
  readonly hideMs?: (roll: () => number) => number;
  /** 说完最后那句到真正消失之间等多久，测试注入；缺省 `PAT_SAY_MS.angry + PAT_HIDE_GAP_MS`。 */
  readonly hideDelayMs?: number;
}

/** 拍一拍状态机。 */
export class PatStore {
  private readonly moods = new Map<string, Mood>();
  private readonly deps: PatStoreInput;
  private readonly now: () => number;
  private readonly roll: () => number;
  private readonly hideMs: (roll: () => number) => number;
  private readonly hideDelayMs: number;

  constructor(deps: PatStoreInput) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.roll = deps.roll ?? Math.random;
    this.hideMs = deps.hideMs ?? hideDuration;
    this.hideDelayMs = deps.hideDelayMs ?? PAT_SAY_MS.angry + PAT_HIDE_GAP_MS;
  }

  /** 这只宠物此刻是否躲着（懒判：真正消失了才算，光说还没躲不算）。 */
  hidden(petId: string): boolean {
    const mood = this.moods.get(petId);
    return mood !== undefined && mood.hiddenUntil > this.now() && mood.hideAt > 0;
  }

  /** 拍一下。 */
  pat(petId: string): PatDecision {
    const mood = this.moodOf(petId);
    const now = this.now();
    // 正在躲、或正处在「说完就消失」的那几秒：受理但不反应。
    // 它的窗口/卡片这会儿要么不在，要么已经说完该说的了，重复上报不该再叠一句。
    if (mood.hiddenUntil > now) {
      return {
        tier: 'angry',
        count: mood.count,
        plan: mood.plan,
        text: undefined,
        hideMs: 0,
        ignored: true,
        busy: false,
      };
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
    // 干活时被拍：不走生气那条线，改成「我在忙」的口吻——工作第一优先级。
    const busy = tier === 'angry' && this.isBusy(petId);
    const pool = busy ? (texts.busy.length > 0 ? texts.busy : texts.angry) : texts[tier];
    const text = pickPatText(pool, mood.lastText, this.roll);
    const sayMs = busy ? PAT_BUSY_SAY_MS : PAT_SAY_MS[tier];
    if (text !== undefined) {
      mood.lastText = text;
      this.deps.onSay(petId, text, sayMs);
    }
    if (tier !== 'angry' || busy) {
      return { tier, count: mood.count, plan: mood.plan, text, hideMs: 0, ignored: false, busy };
    }
    // 生气了：先把这句话说完，再消失。躲的时长每次都重抽，回来时补一句台词，并把计数清零
    // ——它「消气」了，下一次被戳应该重新害羞，而不是永远在生气档。
    const ms = this.hideMs(this.roll);
    mood.hiddenUntil = now + this.hideDelayMs + ms;
    this.scheduleHide(petId, mood, this.hideDelayMs);
    return { tier, count: mood.count, plan: mood.plan, text, hideMs: ms, ignored: false, busy: false };
  }

  /** 忘掉一只宠物的心情（宠物被删/重载时用）。 */
  forget(petId: string): void {
    const mood = this.moods.get(petId);
    if (mood) this.stopTimers(mood);
    this.moods.delete(petId);
  }

  /** 插件卸载：清掉所有计时器，免得重载后旧实例还在写叶子。 */
  dispose(): void {
    for (const mood of this.moods.values()) this.stopTimers(mood);
    this.moods.clear();
  }

  /** 它现在是不是在干活；没注入就当不忙（老调用方行为不变）。 */
  private isBusy(petId: string): boolean {
    try {
      return this.deps.busyOf?.(petId) === true;
    } catch {
      return false;
    }
  }

  /** 取（并在必要时新建）一只宠物的心情。 */
  private moodOf(petId: string): Mood {
    const found = this.moods.get(petId);
    if (found) return found;
    const fresh: Mood = {
      count: 0,
      lastAt: 0,
      plan: planPats(this.roll),
      lastText: '',
      hiddenUntil: 0,
      hideAt: 0,
      hideTimer: null,
      returnTimer: null,
    };
    this.moods.set(petId, fresh);
    return fresh;
  }

  /** 安排「过一会儿真正消失」。到点前一刻发现它在干活就作废——工作优先。 */
  private scheduleHide(petId: string, mood: Mood, delay: number): void {
    if (mood.hideTimer) mood.hideTimer.stop();
    const timer = setTimeout(
      () => {
        mood.hideTimer = null;
        // 已经被 forget/接管，或这中间又发生了别的（回来/重置）
        if (mood.hiddenUntil === 0) return;
        if (this.isBusy(petId)) {
          // 正要说「我生气了」的时候它开始干活了：不躲了，留在原地继续做。
          mood.hiddenUntil = 0;
          mood.hideAt = 0;
          return;
        }
        mood.hideAt = this.now();
        this.deps.onChange(petId, { hidden: true, until: mood.hiddenUntil });
        this.scheduleReturn(petId, mood, Math.max(0, mood.hiddenUntil - this.now()));
      },
      Math.max(0, delay),
    );
    // 不拖住进程退出：宠物躲着的时候用户可以随时关掉 DSH。
    (timer as unknown as { unref?: () => void }).unref?.();
    mood.hideTimer = { stop: () => clearTimeout(timer) };
  }

  /** 安排「过一会儿露面」。令牌比对：中途被 forget/dispose 掉就不再写叶子。 */
  private scheduleReturn(petId: string, mood: Mood, ms: number): void {
    if (mood.returnTimer) mood.returnTimer.stop();
    const timer = setTimeout(() => {
      mood.returnTimer = null;
      if (mood.hiddenUntil === 0) return; // 已经被 forget 或新一轮接管
      mood.hiddenUntil = 0;
      mood.hideAt = 0;
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
    (timer as unknown as { unref?: () => void }).unref?.();
    mood.returnTimer = { stop: () => clearTimeout(timer) };
  }

  /** 停掉一只宠物身上的两种计时器。 */
  private stopTimers(mood: Mood): void {
    if (mood.hideTimer) mood.hideTimer.stop();
    if (mood.returnTimer) mood.returnTimer.stop();
    mood.hideTimer = null;
    mood.returnTimer = null;
  }
}

/** 条目级五组台词的类型收窄再导出，路由与测试都从这里取。 */
export { patTextsOf };
