/**
 * 工作状态联动：档位常量与快照解析。
 * 宿主半侧有自包含的实现（DSH 单文件加载约束，宿主不 import 本目录），负责监听 DSH 会话事件
 * 聚合成快照并写进 /state 的 sections.workStatus；本模块只有档位常量与叶子解析。
 * 气泡文案不在代码里：浏览器半侧直接读配置的 events.workStatusTexts。纯函数无副作用，不依赖 React / DOM。
 * @module dsh-pet/src/shared/work-status
 */
/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档）。 */
export declare const WORK_STATUS_STATES: readonly ["thinking", "working", "result", "waiting", "success", "error"];
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];
/** 档位 → workStatus 数组索引（与 events.workStatus 的顺序严格一致）。 */
export declare const WORK_STATUS_INDEX: Record<WorkStatusState, number>;
/** 工作状态快照（= /state 里 sections.workStatus 的 data，与宿主半侧的同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担；text 不在此——气泡文案由客户端读配置，宿主不生成。 */
export interface WorkStatusSnapshot {
    state: WorkStatusState | null;
    task: string | null;
    /** 本轮已跑的工具步数；空闲或无该字段（老版本宿主）时 0。 */
    steps?: number;
    /** 本轮开始时间（毫秒）；空闲或无该字段时 null。 */
    startedAt?: number | null;
    /** 当前展示条目所属会话；空闲 / 外部槽 / 老版本宿主缺该字段时都不出现，气泡因此不可点。 */
    sessionId?: string | null;
    /** 清单里已完成的条数；没有清单或老版本宿主时 0。 */
    todoDone?: number;
    /** 清单总条数；0 = 没有清单，客户端据此不画进度条。 */
    todoTotal?: number;
}
/** 快照解析：档位不认识 → 归一成 null（空闲）；形状非法 → null，消费端跳过这一拍。 */
export declare function toWorkStatus(raw: unknown): WorkStatusSnapshot | null;
/**
 * 是否处在「正在干活」的档位：思考 / 工作 / 整理 / 等审批。
 *
 * 成功与出错是终态——那一刻宠物该抬头报喜或报错，本来就允许走动，所以不算。
 * 随机链用它决定「这一拍该不该自己走开」（`rollKind` 的 `still`），两端共用一份判断。
 */
export declare function isWorkingState(state: WorkStatusState | null | undefined): boolean;
/**
 * 气泡第二行的进度文案：「第 3 步 · 已用 2 分钟」。
 *
 * 只给能确认的数：步数不知道就不显示；起点不知道就只显示步数。**不编百分比**——总步数只有
 * 模型自己知道，硬凑一个进度条会比没有更误导（NN/g 的 determinate 前提是「真的可确定」）。
 */
export declare function progressLabel(snap: WorkStatusSnapshot | null, now?: number): string | null;
/**
 * 清单进度百分比（0–100 的整数）；没有清单（`todoTotal` 为 0）返回 null。
 *
 * 这是**唯一**能诚实画成条子的进度：todo 清单的条数是真的，工具总步数则只有模型知道。
 */
export declare function todoPercent(snap: WorkStatusSnapshot | null): number | null;
/** 清单进度文案「4/7 项」；没有清单返回 null。 */
export declare function todoProgressLabel(snap: WorkStatusSnapshot | null): string | null;
