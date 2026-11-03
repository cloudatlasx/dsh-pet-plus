/**
 * 折叠台账气泡：最近弹过的通知摘要，点一条能回到它所属的会话。
 *
 * 只负责读快照与发两条请求（清空、跳会话），条目内容由宿主在推送时就裁好；
 * 这里不再做截断，靠 CSS 限高滚动——与提醒气泡同一口径。
 * @module dsh-pet/src/client/history-bubble
 */
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import { postAction } from '../shared/state.ts';
import { ROUTE_PATH } from '../shared/constants.ts';
import type { HistoryEntry, HistorySnapshot } from '../shared/request.ts';
import { injectBubbleCss } from './bubble.ts';

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

/** 把毫秒时间戳格式化成「今天 HH:MM」或「M/D HH:MM」。 */
function stampText(ms: number): string {
  const d = new Date(ms);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 一条摘要：优先用第一条明细，其次正文，再次省略号。 */
function summaryOf(entry: HistoryEntry): string {
  const line = entry.lines?.[0];
  if (line !== undefined && line !== '') return line;
  if (entry.prompt !== undefined && entry.prompt !== '') return entry.prompt;
  return '';
}

/**
 * 造台账气泡。
 *
 * @param rt - 注入的 react 能力。
 * @returns 台账气泡组件；点条目跳会话走宿主的 `/focus-session`，与桌面端同一通路。
 */
export function makeHistoryBubble(rt: HistoryBubbleRuntime) {
  const { h } = rt;
  injectBubbleCss();

  return function HistoryBubble({ snapshot, on, onClose }: HistoryBubbleProps) {
    const entries = snapshot?.entries ?? [];
    const clear = (): void => {
      void postAction(ROUTE_PATH + '/history', { clear: true }).catch(() => undefined);
    };
    const jump = (entry: HistoryEntry): void => {
      if (entry.sessionId === undefined) return;
      void postAction(ROUTE_PATH + '/focus-session', { sessionId: entry.sessionId }).catch(() => undefined);
      onClose();
    };
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-request dsh-pet-history' + (on ? ' is-on is-clickable' : ''),
      onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
      children: [
        h('div', {
          key: 'head',
          className: 'dsh-pet-request__actions dsh-pet-history__head',
          children: [
            h('span', {
              key: 'badge',
              className: 'dsh-pet-request__badge is-history',
              children: entries.length > 0 ? `记录 · ${entries.length}` : '记录',
            }),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dsh-pet-request__btn is-ghost',
              title: '收起',
              children: '收起',
              onClick: onClose,
            }),
          ],
        }),
        entries.length === 0
          ? h('div', {
              key: 'empty',
              className: 'dsh-pet-history__empty',
              children: '还没有记录。到点的提醒和推送过一会儿就会出现在这里。',
            })
          : h('div', {
              key: 'list',
              className: 'dsh-pet-history__list',
              children: entries.map((entry, i) => {
                const summary = summaryOf(entry);
                const clickable = entry.sessionId !== undefined;
                return h('div', {
                  key: entry.id + ':' + String(i),
                  className: 'dsh-pet-history__row' + (clickable ? ' is-clickable' : ''),
                  title: clickable ? '点一下回到这个会话' : undefined,
                  onClick: clickable ? () => jump(entry) : undefined,
                  children: [
                    h('span', {
                      key: 'time',
                      className: 'dsh-pet-history__time',
                      children: stampText(entry.ts),
                    }),
                    h('div', {
                      key: 'body',
                      className: 'dsh-pet-history__body',
                      children: [
                        h('span', { key: 'title', className: 'dsh-pet-history__title', children: entry.title }),
                        summary === ''
                          ? null
                          : h('span', { key: 'sum', className: 'dsh-pet-history__sum', children: summary }),
                      ].filter((node) => node !== null),
                    }),
                  ],
                });
              }),
            }),
        h('div', {
          key: 'foot',
          className: 'dsh-pet-request__actions dsh-pet-history__foot',
          children: [
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'dsh-pet-request__btn is-ghost',
              children: '清空',
              onClick: clear,
            }),
            h('span', {
              key: 'note',
              className: 'dsh-pet-history__note',
              children: '只记最近 20 条，重启 DSH 就清空。',
            }),
          ],
        }),
      ],
    });
  };
}
