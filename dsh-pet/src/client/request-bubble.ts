/**
 * 交互请求与定时提醒的气泡：审批按钮、提问选项，以及一条到点提醒。
 *
 * 只负责显示与收集点击：答案通过 `POST /request/answer` 回传，是否合法、是否过期都由
 * 宿主侧的请求中转站判定；这里不做乐观更新，等宿主把 `closed` 信封推回来才收起。
 * @module dsh-pet/src/client/request-bubble
 */
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import { postAction } from '../shared/state.ts';
import { ROUTE_PATH } from '../shared/constants.ts';
import type { QuestionAnswer, ReminderEnvelope, RequestEnvelope } from '../shared/request.ts';
import { injectBubbleCss } from './bubble.ts';

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

/** 把毫秒时间戳格式化成 HH:MM（本地时区）。 */
function clockText(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 截断长文本，避免方案正文把气泡撑满整屏。 */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** 发一条回答；网络失败静默——宿主超时后会自己回落到 DSH 面板。 */
function postAnswer(body: unknown): void {
  void postAction(ROUTE_PATH + '/request/answer', body).catch(() => undefined);
}

/**
 * 造审批气泡：允许一次 / 拒绝 / 去 DSH 面板。
 *
 * @param rt - 注入的 react 能力。
 * @returns 审批气泡组件。
 */
export function makeApprovalBubble(rt: RequestBubbleRuntime) {
  const { h } = rt;
  injectBubbleCss();

  return function ApprovalBubble({ request, on }: ApprovalBubbleProps) {
    const preview = request.preview === true;
    const answer = (outcome: 'allowed-once' | 'rejected' | 'delegate'): void => {
      if (preview) {
        // 预览不接真实请求：点一下只收起气泡（cancel 信封让宿主写 closed）。
        postAnswer({ id: request.id, kind: 'approval', cancel: true });
        return;
      }
      postAnswer({ id: request.id, kind: 'approval', outcome });
    };
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-request' + (on ? ' is-on is-clickable' : ''),
      onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
      children: [
        h('div', {
          key: 'head',
          className: 'dsh-pet-request__head',
          children: [
            h('span', { key: 'kind', className: 'dsh-pet-request__badge', children: '需要确认' }),
            h('span', {
              key: 'tool',
              className: 'dsh-pet-request__tool',
              children: request.toolName || '工具调用',
            }),
          ],
        }),
        h('div', {
          key: 'reason',
          className: 'dsh-pet-request__body',
          children: request.reason && request.reason.trim() !== '' ? clip(request.reason, 160) : '这一步要跑一个需要授权的操作。',
        }),
        h('div', {
          key: 'actions',
          className: 'dsh-pet-request__actions',
          children: [
            h('button', {
              key: 'allow',
              type: 'button',
              className: 'dsh-pet-request__btn is-primary',
              onClick: () => answer('allowed-once'),
              children: '允许一次',
            }),
            h('button', {
              key: 'reject',
              type: 'button',
              className: 'dsh-pet-request__btn',
              onClick: () => answer('rejected'),
              children: '拒绝',
            }),
            h('button', {
              key: 'ds',
              type: 'button',
              className: 'dsh-pet-request__btn is-ghost',
              onClick: () => answer('delegate'),
              children: '去 DSH',
            }),
          ],
        }),
      ],
    });
  };
}

/**
 * 造提问气泡：选项按钮 + 自由输入 + 发送。
 *
 * 一次回答全部问题；只有每道题都选了选项或写了答案才允许发送。
 *
 * @param rt - 注入的 react 能力。
 * @returns 提问气泡组件。
 */
export function makeQuestionBubble(rt: RequestBubbleRuntime) {
  const { h, useState, useEffect } = rt;
  injectBubbleCss();

  return function QuestionBubble({ request, on }: ApprovalBubbleProps) {
    const questions = request.questions ?? [];
    const [picked, setPicked] = useState<Record<string, string[]>>({});
    const [custom, setCustom] = useState<Record<string, string>>({});
    // 换了一条请求就清空草稿，避免把上一条的答案带过来。
    useEffect(() => {
      setPicked({});
      setCustom({});
    }, [request.id]);

    const toggle = (qid: string, label: string, multi: boolean): void => {
      setPicked((prev) => {
        const cur = prev[qid] ?? [];
        if (!multi) return { ...prev, [qid]: [label] };
        return { ...prev, [qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      });
    };

    const answers = (): QuestionAnswer[] =>
      questions.map((q) => {
        const selected = picked[q.id] ?? [];
        const text = (custom[q.id] ?? '').trim();
        return { id: q.id, selected, ...(text !== '' ? { custom: text } : {}) };
      });

    const ready = questions.every((q) => {
      const selected = picked[q.id] ?? [];
      return selected.length > 0 || (custom[q.id] ?? '').trim() !== '';
    });

    const submit = (): void => {
      if (!ready) return;
      if (request.preview === true) {
        postAnswer({ id: request.id, kind: 'question', cancel: true });
        return;
      }
      postAnswer({ id: request.id, kind: 'question', answers: answers() });
    };

    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-request is-question' + (on ? ' is-on is-clickable' : ''),
      onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
      children: [
        ...questions.map((q, index) =>
          h('div', {
            key: 'q' + q.id,
            className: 'dsh-pet-request__question',
            children: [
              h('div', {
                key: 'title',
                className: 'dsh-pet-request__title',
                children: (q.header && q.header.trim() !== '' ? q.header + '：' : '') + (index + 1) + '. ' + clip(q.question, 90),
              }),
              q.detail && q.detail.trim() !== ''
                ? h('div', { key: 'detail', className: 'dsh-pet-request__detail', children: clip(q.detail, 200) })
                : null,
              h('div', {
                key: 'opts',
                className: 'dsh-pet-request__options',
                children: [
                  ...(q.options ?? []).map((opt) =>
                    h('button', {
                      key: 'o' + opt.label,
                      type: 'button',
                      className:
                        'dsh-pet-request__opt' + ((picked[q.id] ?? []).includes(opt.label) ? ' is-picked' : ''),
                      onClick: () => toggle(q.id, opt.label, q.multiSelect === true),
                      children: opt.label,
                    }),
                  ),
                  h('input', {
                    key: 'custom',
                    type: 'text',
                    className: 'dsh-pet-request__input',
                    placeholder: (q.options ?? []).length > 0 ? '其他（选填）' : '输入回答…',
                    value: custom[q.id] ?? '',
                    onChange: (e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                      setCustom((prev) => ({ ...prev, [q.id]: e.target.value })),
                  }),
                ],
              }),
            ],
          }),
        ),
        h('div', {
          key: 'send',
          className: 'dsh-pet-request__actions',
          children: [
            h('button', {
              key: 'go',
              type: 'button',
              className: 'dsh-pet-request__btn is-primary',
              disabled: !ready,
              onClick: submit,
              children: request.preview === true ? '知道了' : '发送',
            }),
          ],
        }),
      ],
    });
  };
}

/**
 * 造定时提醒气泡：任务标题 + 提示词摘要 + 计划时刻。
 *
 * @param rt - 注入的 react 能力。
 * @returns 提醒气泡组件。
 */
export function makeReminderBubble(rt: RequestBubbleRuntime) {
  const { h } = rt;
  injectBubbleCss();

  return function ReminderBubble({ reminder, on }: ReminderBubbleProps) {
    const planned = typeof reminder.scheduledAt === 'string' ? Date.parse(reminder.scheduledAt) : NaN;
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-reminder' + (on ? ' is-on is-clickable' : ''),
      onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
      children: [
        h('div', {
          key: 'head',
          className: 'dsh-pet-request__head',
          children: [
            h('span', { key: 'kind', className: 'dsh-pet-request__badge is-reminder', children: '定时任务' }),
            Number.isFinite(planned)
              ? h('span', { key: 'time', className: 'dsh-pet-request__tool', children: clockText(planned) })
              : null,
          ],
        }),
        h('div', { key: 'title', className: 'dsh-pet-reminder__title', children: clip(reminder.title, 80) }),
        reminder.prompt && reminder.prompt.trim() !== ''
          ? h('div', { key: 'prompt', className: 'dsh-pet-request__body', children: clip(reminder.prompt, 160) })
          : null,
      ],
    });
  };
}
