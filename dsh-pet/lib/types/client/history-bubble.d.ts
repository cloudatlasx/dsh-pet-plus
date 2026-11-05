/**
 * 折叠台账气泡：最近弹过的通知摘要，点一条能回到它所属的会话。
 *
 * 只负责读快照与发两条请求（清空、跳会话），条目内容由宿主在推送时就裁好；
 * 这里不再做截断，靠 CSS 限高滚动——与提醒气泡同一口径。
 * @module dsh-pet/src/client/history-bubble
 */
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { HistorySnapshot } from '../shared/request.ts';
/** 注入的 react 能力。 */
export interface HistoryBubbleRuntime {
    /** 创建元素。 */
    h: typeof jsx;
    /** 本地状态。 */
    useState: <T>(initial: T) => [T, (next: T | ((prev: T) => T)) => void];
}
/** 台账气泡的 props。 */
export interface HistoryBubbleProps {
    /** 台账快照；null 表示还没读到。 */
    snapshot: HistorySnapshot | null;
    /** 可视（槽位选中且用户没关）。 */
    on: boolean;
    /** 收起面板。 */
    onClose: () => void;
}
/**
 * 造台账气泡。
 *
 * @param rt - 注入的 react 能力。
 * @returns 台账气泡组件；点条目跳会话走宿主的 `/focus-session`，与桌面端同一通路。
 */
export declare function makeHistoryBubble(rt: HistoryBubbleRuntime): ({ snapshot, on, onClose }: HistoryBubbleProps) => ReactNS.ReactElement<any, string | ReactNS.JSXElementConstructor<any>>;
