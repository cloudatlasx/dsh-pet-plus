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
import { patTextsOf, type PatTexts, type PatTier } from '../shared/pat.ts';
/** 写进 `pets.<id>.hidden` 的载荷：躲起来了（带解除时刻）或已经回来。 */
export type HiddenLeafData = {
    hidden: true;
    until: number;
} | {
    hidden: false;
};
/** 一次拍一拍的结果（路由据此回执，渲染端不需要它）。 */
export interface PatDecision {
    /** 这一拍落在哪一档。 */
    readonly tier: PatTier;
    /** 当前连拍次数（含这一拍）。 */
    readonly count: number;
    /** 这一轮重新抽过的阈值。 */
    readonly plan: {
        shyUntil: number;
        annoyedUntil: number;
    };
    /** 要说的话；`undefined` = 不说话（没配台词，或这会儿正躲着）。 */
    readonly text: string | undefined;
    /** 真的躲起来了才非 0：躲多久（毫秒）。 */
    readonly hideMs: number;
    /** 正躲着（或马上就要消失）时又来一拍：受理但什么也不做。 */
    readonly ignored: boolean;
    /** 这一拍正好赶上它在干活：工作优先，不躲，继续做手上的事。 */
    readonly busy: boolean;
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
    /** 这只宠物现在还允不允许躲起来消失（主人在对话里说过「以后别消失」）。缺省 = 允许。 */
    readonly hideEnabledOf?: (petId: string) => boolean;
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
export declare class PatStore {
    private readonly moods;
    private readonly deps;
    private readonly now;
    private readonly roll;
    private readonly hideMs;
    private readonly hideDelayMs;
    constructor(deps: PatStoreInput);
    /** 这只宠物此刻是否躲着（懒判：真正消失了才算，光说还没躲不算）。 */
    hidden(petId: string): boolean;
    /** 拍一下。 */
    pat(petId: string): PatDecision;
    /** 忘掉一只宠物的心情（宠物被删/重载时用）。 */
    forget(petId: string): void;
    /** 插件卸载：清掉所有计时器，免得重载后旧实例还在写叶子。 */
    dispose(): void;
    /** 它现在是不是在干活；没注入就当不忙（老调用方行为不变）。 */
    private isBusy;
    /** 取（并在必要时新建）一只宠物的心情。 */
    private moodOf;
    /** 安排「过一会儿真正消失」。到点前一刻发现它在干活就作废——工作优先。 */
    private scheduleHide;
    /** 安排「过一会儿露面」。令牌比对：中途被 forget/dispose 掉就不再写叶子。 */
    private scheduleReturn;
    /** 停掉一只宠物身上的两种计时器。 */
    private stopTimers;
}
/** 条目级五组台词的类型收窄再导出，路由与测试都从这里取。 */
export { patTextsOf };
