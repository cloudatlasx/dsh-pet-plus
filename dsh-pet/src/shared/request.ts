/**
 * 交互请求（审批 / 提问）与定时提醒的气泡载荷：两端共用的形状与读取口径。
 *
 * 宿主把要用户拍板的事写进 `sections.request`，把到点的定时任务写进 `sections.reminder`；
 * 页面轮询读到后在宠物气泡里给出按钮，用户点完 POST 回宿主，宿主再把结论交给 DSH。
 * 叶子只有一份槽位：同一时刻最多一条请求，新请求覆盖旧请求（宿主侧保证不会并发写）。
 *
 * 结束态用 `closed: true` 的同一 id 信封表达，而不是把 data 写回 null——轮询比对会跳过
 * null 叶子（见 shared/state 的 takeChanged），写 null 客户端永远收不到「收起」这一拍。
 * @module dsh-pet/src/shared/request
 */
import type { StateLeaf } from './state.ts';

/** 审批结论（与 DSH ApprovalService 的结果词表一致，另加两个只在本插件内部使用的词）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'delegate';

/**
 * 用户对审批气泡的选择。
 *
 * `allow-session` 不进 DSH 词表：它表示「这个会话后面别再问了」，由本插件自己记账，
 * 后续同会话的审批直接以 `allowed-once` 放行，DSH 侧看不到这个中间态。
 */
export type ApprovalChoice = ApprovalOutcome | 'allow-session';

/** 一个可选项。 */
export interface QuestionOption {
  /** 选项文案，也是回传答案里的 selected 值。 */
  label: string;
  /** 补充说明。 */
  description?: string;
}

/** 一道问题；字段与 DSH user-questions 的 request 对齐。 */
export interface QuestionPrompt {
  /** 问题 id，回传答案时原样带回。 */
  id: string;
  /** 问题正文。 */
  question: string;
  /** 细节（如方案全文）。 */
  detail?: string;
  /** 短标题。 */
  header?: string;
  /** 选项；缺省表示自由回答。 */
  options?: QuestionOption[];
  /** 是否多选。 */
  multiSelect?: boolean;
}

/** 一条待用户处理的请求。 */
export interface RequestEnvelope {
  /** 本次请求 id；回答时原样带回，宿主据此丢弃过期回答。 */
  id: string;
  /** 请求类型。 */
  kind: 'approval' | 'question';
  /** 写入时刻（ms）。 */
  ts: number;
  /** 到这里还没人回答，宿主就撤掉气泡回落到 DSH 面板（ms）。 */
  expiresAt: number;
  /** kind = approval 时的工具名。 */
  toolName?: string;
  /** kind = approval 时的理由。 */
  reason?: string;
  /** kind = question 时的问题列表。 */
  questions?: QuestionPrompt[];
  /** 预览（设置页「试一下」）：不等待真实回答，点任意按钮只收起。 */
  preview?: boolean;
  /** 结束标记：读到它即视为没有待处理请求。 */
  closed?: boolean;
}

/** 一道题的答案。 */
export interface QuestionAnswer {
  /** 对应 QuestionPrompt.id。 */
  id: string;
  /** 选中的选项文案；自由回答时为空数组。 */
  selected: string[];
  /** 用户自己写的答案，覆盖或补充选项。 */
  custom?: string;
}

/** 回答请求的请求体。 */
export type RequestAnswerPayload =
  | { id: string; kind: 'approval'; outcome: ApprovalChoice }
  | { id: string; kind: 'question'; answers: QuestionAnswer[] }
  | { id: string; kind: 'approval' | 'question'; cancel: true };

/**
 * 一条到点的定时任务提醒，或一段会话主动推给宠物的内容。
 *
 * `kind` 只影响徽标与默认停留时长：`schedule` 是调度器到点，`announce` 是会话里的 agent
 * 用 `POST /announce` 推过来的结论（日报、待办清单之类），`chat` 是对话里答应了
 * 「两分钟后提醒我」由宠物自己的闹钟弹出来的。
 */
export interface ReminderEnvelope {
  /** 提醒 id（由任务 id + 计划时刻拼成，同一条任务的不同次提醒不同）。 */
  id: string;
  /** 来源：`schedule` = 调度器到点；`announce` = 会话主动推送；`chat` = 对话里约好的提醒。 */
  kind: 'schedule' | 'announce' | 'chat';
  /** 写入时刻（ms）。 */
  ts: number;
  /** 任务标题。 */
  title: string;
  /** 任务提示词摘要。 */
  prompt?: string;
  /** 分条明细：每项一行，气泡里滚动显示（长清单比一整段好读）。 */
  lines?: string[];
  /** 尾注：告诉用户接下来能做什么（如「在下面选一项，我就去填工时」）。 */
  hint?: string;
  /** 相关会话 id：给了就在气泡上多一个「去会话」按钮。 */
  sessionId?: string;
  /** 停留时长（ms）；缺省按 kind 取默认值。 */
  ttlMs?: number;
  /** 计划时刻（RFC 3339 UTC）。 */
  scheduledAt?: string;
  /** 快捷动作：气泡底部一排按钮，点一下就把 `text` 作为用户消息投回 `sessionId` 那个会话。 */
  actions?: ReminderAction[];
  /** 结束标记。 */
  closed?: boolean;
}

/**
 * 快捷动作：把「点一下」变成一次真实的用户发言。
 *
 * `label` 是按钮上的字（要短），`text` 是真正投给 agent 的话——两者故意分开：
 * 按钮写给人看（「记 2h」），投喂给人背后的模型看（「47161 记 2 小时工时，work 写…」）。
 */
export interface ReminderAction {
  /** 按钮文案（≤ 12 个汉字左右）。 */
  label: string;
  /** 点击后投回会话的用户消息正文。 */
  text: string;
}

/**
 * 一条进过台账的通知。
 *
 * 台账是「折叠的历史」：气泡关掉之后用户还想回看，就不必去翻聊天记录。只留摘要字段，
 * 不留 actions（按钮点一次就过期，回看时再点只会投到会话里一句莫名其妙的话）。
 */
export interface HistoryEntry {
  /** 原始提醒 id。 */
  id: string;
  /** 来源。 */
  kind: 'schedule' | 'announce' | 'chat';
  /** 弹出时刻（ms）。 */
  ts: number;
  /** 标题。 */
  title: string;
  /** 分条明细。 */
  lines?: string[];
  /** 正文摘要。 */
  prompt?: string;
  /** 相关会话：点条目可以跳过去。 */
  sessionId?: string;
}

/** 台账叶子：总条数 + 最近的条目（新的在前）。 */
export interface HistorySnapshot {
  /** 累计条数（含已滚出列表的）。 */
  count: number;
  /** 最近若干条，新的在前。 */
  entries: HistoryEntry[];
}

/** 类型收窄：台账叶子 → 快照；坏形状 → null（空台账返回 entries 为空的对象）。 */
export function readHistory(leaf: StateLeaf): HistorySnapshot | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as Record<string, unknown>;
  const raw = Array.isArray(d.entries) ? d.entries : [];
  const entries: HistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') continue;
    if (e.kind !== 'schedule' && e.kind !== 'announce' && e.kind !== 'chat') continue;
    if (typeof e.title !== 'string' || e.title.trim() === '') continue;
    const lines = labelsOf(e.lines);
    entries.push({
      id: e.id,
      kind: e.kind,
      ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now(),
      title: e.title,
      lines: lines.length > 0 ? lines : undefined,
      prompt: typeof e.prompt === 'string' && e.prompt.trim() !== '' ? e.prompt : undefined,
      sessionId: typeof e.sessionId === 'string' && e.sessionId.trim() !== '' ? e.sessionId : undefined,
    });
  }
  const count =
    typeof d.count === 'number' && Number.isFinite(d.count) && d.count >= 0 ? Math.floor(d.count) : entries.length;
  return { count, entries };
}

/** 从字符串数组里挑出非空字符串。 */
function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item);
  }
  return out;
}

/** 类型收窄：请求叶子 → 请求信封；形状非法或已结束 → null。 */
export function readRequest(leaf: StateLeaf): RequestEnvelope | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as Record<string, unknown>;
  if (d.closed === true) return null;
  if (typeof d.id !== 'string' || d.id === '') return null;
  if (d.kind !== 'approval' && d.kind !== 'question') return null;
  if (typeof d.ts !== 'number' || !Number.isFinite(d.ts)) return null;
  const expiresAt = typeof d.expiresAt === 'number' && Number.isFinite(d.expiresAt) ? d.expiresAt : d.ts;
  const out: RequestEnvelope = {
    id: d.id,
    kind: d.kind,
    ts: d.ts,
    expiresAt,
    ...(d.preview === true ? { preview: true } : {}),
  };
  if (d.kind === 'approval') {
    out.toolName = typeof d.toolName === 'string' ? d.toolName : '';
    out.reason = typeof d.reason === 'string' ? d.reason : undefined;
    return out;
  }
  const rawQuestions = Array.isArray(d.questions) ? d.questions : [];
  const questions: QuestionPrompt[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    if (typeof q.id !== 'string' || q.id === '' || typeof q.question !== 'string') continue;
    const opts: QuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (!o || typeof o !== 'object') continue;
        const opt = o as Record<string, unknown>;
        if (typeof opt.label !== 'string' || opt.label === '') continue;
        opts.push({
          label: opt.label,
          description: typeof opt.description === 'string' ? opt.description : undefined,
        });
      }
    }
    questions.push({
      id: q.id,
      question: q.question,
      detail: typeof q.detail === 'string' ? q.detail : undefined,
      header: typeof q.header === 'string' ? q.header : undefined,
      options: opts.length > 0 ? opts : undefined,
      multiSelect: q.multiSelect === true,
    });
  }
  // 一道题都没读出来 = 坏形状：吞掉它，免得用户面对一个没有内容的空面板。
  if (questions.length === 0) return null;
  out.questions = questions;
  return out;
}

/** 类型收窄：提醒叶子 → 提醒信封；形状非法或已结束 → null。 */
export function readReminder(leaf: StateLeaf): ReminderEnvelope | null {
  if (!leaf.data || typeof leaf.data !== 'object') return null;
  const d = leaf.data as Record<string, unknown>;
  if (d.closed === true) return null;
  if (typeof d.id !== 'string' || d.id === '') return null;
  if (d.kind !== 'schedule' && d.kind !== 'announce' && d.kind !== 'chat') return null;
  if (typeof d.title !== 'string' || d.title.trim() === '') return null;
  const lines = labelsOf(d.lines);
  const actions = actionsOf(d.actions);
  return {
    id: d.id,
    kind: d.kind,
    ts: typeof d.ts === 'number' && Number.isFinite(d.ts) ? d.ts : Date.now(),
    title: d.title,
    prompt: typeof d.prompt === 'string' && d.prompt.trim() !== '' ? d.prompt : undefined,
    lines: lines.length > 0 ? lines : undefined,
    hint: typeof d.hint === 'string' && d.hint.trim() !== '' ? d.hint : undefined,
    sessionId: typeof d.sessionId === 'string' && d.sessionId.trim() !== '' ? d.sessionId : undefined,
    ttlMs: typeof d.ttlMs === 'number' && Number.isFinite(d.ttlMs) && d.ttlMs > 0 ? d.ttlMs : undefined,
    scheduledAt: typeof d.scheduledAt === 'string' ? d.scheduledAt : undefined,
    actions: actions.length > 0 ? actions : undefined,
  };
}

/** 收窄快捷动作数组：跳过坏形状，`label` 与 `text` 都得非空。 */
function actionsOf(value: unknown): ReminderAction[] {
  if (!Array.isArray(value)) return [];
  const out: ReminderAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (label === '' || text === '') continue;
    out.push({ label, text });
  }
  return out;
}

/** 收窄答案里的选项：非空字符串数组。 */
export function answerLabels(value: unknown): string[] {
  return labelsOf(value);
}
