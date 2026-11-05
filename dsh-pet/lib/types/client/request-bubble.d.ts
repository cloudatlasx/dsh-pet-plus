/**
 * 交互请求与定时提醒的气泡：审批按钮、提问选项，以及一条到点提醒。
 *
 * 只负责显示与收集点击：答案通过 `POST /request/answer` 回传，是否合法、是否过期都由
 * 宿主侧的请求中转站判定；这里不做乐观更新，等宿主把 `closed` 信封推回来才收起。
 * @module dsh-pet/src/client/request-bubble
 */
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { ReminderEnvelope, RequestEnvelope } from '../shared/request.ts';
/** 注入的 react 能力。 */
export interface RequestBubbleRuntime {
    /** 创建元素。 */
    h: typeof jsx;
    /** 本地状态（草稿与多选）。 */
    useState: <T>(initial: T) => [T, (next: T | ((prev: T) => T)) => void];
    /** 副作用。 */
    useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}
/** 审批气泡的 props。 */
export interface ApprovalBubbleProps {
    /** 待处理的请求。 */
    request: RequestEnvelope;
    /** 可视（槽位选中且未收起）。 */
    on: boolean;
}
/** 提醒气泡的 props。 */
export interface ReminderBubbleProps {
    /** 到点的任务。 */
    reminder: ReminderEnvelope;
    /** 可视。 */
    on: boolean;
}
/**
 * 造审批气泡：允许一次 / 本会话都允许 / 拒绝 / 去 DSH 面板。
 *
 * 「本会话都允许」只影响本插件这一层：记住当前会话后，同会话后续审批直接放行、不再弹气泡；
 * DSH 自己的策略（policy=never 时连瀑布都不进）不受影响，所以它只对「会问人」的那些请求有效。
 *
 * @param rt - 注入的 react 能力。
 * @returns 审批气泡组件。
 */
export declare function makeApprovalBubble(rt: RequestBubbleRuntime): ({ request, on }: ApprovalBubbleProps) => ReactNS.ReactElement<any, string | ReactNS.JSXElementConstructor<any>>;
/**
 * 造提问气泡：选项按钮 + 自由输入 + 发送。
 *
 * 一次回答全部问题；只有每道题都选了选项或写了答案才允许发送。
 *
 * @param rt - 注入的 react 能力。
 * @returns 提问气泡组件。
 */
export declare function makeQuestionBubble(rt: RequestBubbleRuntime): ({ request, on }: ApprovalBubbleProps) => ReactNS.ReactElement<any, string | ReactNS.JSXElementConstructor<any>>;
/**
 * 造定时提醒 / 主动推送气泡：标题、分条明细、正文、尾注，外加「知道了」「去会话」两个动作。
 *
 * 长内容不再截成一句话塞在气泡里：明细逐行列出，正文与明细各自滚动（`.dsh-pet-request__body`
 * 与 `.dsh-pet-reminder__lines` 都有高度上限），所以一次推 10 条待办也读得完。
 *
 * @param rt - 注入的 react 能力。
 * @returns 提醒气泡组件。
 */
export declare function makeReminderBubble(rt: RequestBubbleRuntime): ({ reminder, on }: ReminderBubbleProps) => ReactNS.ReactElement<any, string | ReactNS.JSXElementConstructor<any>>;
