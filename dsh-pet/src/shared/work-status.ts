/**
 * 工作状态联动：档位常量与快照解析。
 * 宿主半侧有自包含的实现（DSH 单文件加载约束，宿主不 import 本目录），负责监听 DSH 会话事件
 * 聚合成快照并写进 /state 的 sections.workStatus；本模块只有档位常量与叶子解析。
 * 气泡文案不在代码里：浏览器半侧直接读配置的 events.workStatusTexts。纯函数无副作用，不依赖 React / DOM。
 * @module dsh-pet/src/shared/work-status
 */

/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档）。 */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];

/** 档位 → workStatus 数组索引（与 events.workStatus 的顺序严格一致）。 */
export const WORK_STATUS_INDEX: Record<WorkStatusState, number> = {
  thinking: 0, // turn/start → 思考
  working: 1, // tool/call → 工作
  result: 2, // tool/result → 整理
  waiting: 3, // approval/asked → 等待
  success: 4, // turn/end completed → 完成
  error: 5, // turn/end error/max-tokens → 出错
};

/** 工作状态快照（= /state 里 sections.workStatus 的 data，与宿主半侧的同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担；text 不在此——气泡文案由客户端读配置，宿主不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
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
export function toWorkStatus(raw: unknown): WorkStatusSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    state?: unknown;
    task?: unknown;
    sessionId?: unknown;
    steps?: unknown;
    startedAt?: unknown;
    todoDone?: unknown;
    todoTotal?: unknown;
  };
  const state: WorkStatusState | null =
    r.state === null || (typeof r.state === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(r.state))
      ? (r.state as WorkStatusState | null)
      : null;
  const sessionId =
    typeof r.sessionId === 'string' && r.sessionId !== '' && r.sessionId !== 'unknown' ? r.sessionId : null;
  const steps = typeof r.steps === 'number' && Number.isFinite(r.steps) && r.steps > 0 ? Math.floor(r.steps) : 0;
  const startedAt =
    typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) && r.startedAt > 0 ? r.startedAt : null;
  const todoTotal =
    typeof r.todoTotal === 'number' && Number.isFinite(r.todoTotal) && r.todoTotal > 0 ? Math.floor(r.todoTotal) : 0;
  const rawDone =
    typeof r.todoDone === 'number' && Number.isFinite(r.todoDone) && r.todoDone > 0 ? Math.floor(r.todoDone) : 0;
  const todoDone = todoTotal > 0 ? Math.min(rawDone, todoTotal) : 0;
  return { state, task: typeof r.task === 'string' ? r.task : null, sessionId, steps, startedAt, todoDone, todoTotal };
}

/**
 * 是否处在「正在干活」的档位：思考 / 工作 / 整理 / 等审批。
 *
 * 成功与出错是终态——那一刻宠物该抬头报喜或报错，本来就允许走动，所以不算。
 * 随机链用它决定「这一拍该不该自己走开」（`rollKind` 的 `still`），两端共用一份判断。
 */
export function isWorkingState(state: WorkStatusState | null | undefined): boolean {
  return state === 'thinking' || state === 'working' || state === 'result' || state === 'waiting';
}

/**
 * 气泡第二行的进度文案：「第 3 步 · 已用 2 分钟」。
 *
 * 只给能确认的数：步数不知道就不显示；起点不知道就只显示步数。**不编百分比**——总步数只有
 * 模型自己知道，硬凑一个进度条会比没有更误导（NN/g 的 determinate 前提是「真的可确定」）。
 */
export function progressLabel(snap: WorkStatusSnapshot | null, now = Date.now()): string | null {
  if (!snap || snap.state === null) return null;
  const steps = snap.steps ?? 0;
  const startedAt = snap.startedAt ?? null;
  const minutes = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (steps <= 0 && minutes <= 0) return null;
  const parts: string[] = [];
  if (steps > 0) parts.push(`第 ${steps} 步`);
  if (minutes > 0) parts.push(`已用 ${minutes} 分钟`);
  return parts.join(' · ');
}

/**
 * 清单进度百分比（0–100 的整数）；没有清单（`todoTotal` 为 0）返回 null。
 *
 * 这是**唯一**能诚实画成条子的进度：todo 清单的条数是真的，工具总步数则只有模型知道。
 */
export function todoPercent(snap: WorkStatusSnapshot | null): number | null {
  const total = snap?.todoTotal ?? 0;
  if (total <= 0) return null;
  const done = Math.min(Math.max(snap?.todoDone ?? 0, 0), total);
  return Math.round((done / total) * 100);
}

/** 清单进度文案「4/7 项」；没有清单返回 null。 */
export function todoProgressLabel(snap: WorkStatusSnapshot | null): string | null {
  const total = snap?.todoTotal ?? 0;
  if (total <= 0) return null;
  const done = Math.min(Math.max(snap?.todoDone ?? 0, 0), total);
  return `${done}/${total} 项`;
}
