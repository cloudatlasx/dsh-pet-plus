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

/** 发一条回答；网络失败静默——宿主超时后会自己回落到 DSH 面板。 */
function postAnswer(body: unknown): void {
  void postAction(ROUTE_PATH + '/request/answer', body).catch(() => undefined);
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
export function makeApprovalBubble(rt: RequestBubbleRuntime) {
  const { h } = rt;
  injectBubbleCss();

  return function ApprovalBubble({ request, on }: ApprovalBubbleProps) {
    const preview = request.preview === true;
    const answer = (outcome: 'allowed-once' | 'allow-session' | 'rejected' | 'delegate'): void => {
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
          children: request.reason && request.reason.trim() !== '' ? request.reason : '这一步要跑一个需要授权的操作。',
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
              key: 'session',
              type: 'button',
              className: 'dsh-pet-request__btn',
              title: '本会话内同类审批不再询问',
              onClick: () => answer('allow-session'),
              children: '本会话都允许',
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
        // 题目区单独滚：选完一项会重渲染，若整颗气泡是滚动容器，scrollTop 会归零、
        // 「发送」被顶出视野，用户得再往下拉一次。
        h('div', {
          key: 'scroll',
          className: 'dsh-pet-request__scroll',
          children: questions.map((q, index) =>
            h('div', {
              key: 'q' + q.id,
              className: 'dsh-pet-request__question',
              children: [
                h('div', {
                  key: 'title',
                  className: 'dsh-pet-request__title',
                  children:
                    (q.header && q.header.trim() !== '' ? q.header + '：' : '') + (index + 1) + '. ' + q.question,
                }),
                q.detail && q.detail.trim() !== ''
                  ? h('div', { key: 'detail', className: 'dsh-pet-request__detail', children: q.detail })
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
        }),
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
 * 造定时提醒 / 主动推送气泡：标题、分条明细、正文、尾注，外加「知道了」「去会话」两个动作。
 *
 * 长内容不再截成一句话塞在气泡里：明细逐行列出，正文与明细各自滚动（`.dsh-pet-request__body`
 * 与 `.dsh-pet-reminder__lines` 都有高度上限），所以一次推 10 条待办也读得完。
 *
 * @param rt - 注入的 react 能力。
 * @returns 提醒气泡组件。
 */
export function makeReminderBubble(rt: RequestBubbleRuntime) {
  const { h } = rt;
  injectBubbleCss();

  return function ReminderBubble({ reminder, on }: ReminderBubbleProps) {
    const planned = typeof reminder.scheduledAt === 'string' ? Date.parse(reminder.scheduledAt) : NaN;
    const lines = reminder.lines ?? [];
    const hint = reminder.hint ?? '';
    const text = reminder.prompt ?? '';
    const announce = reminder.kind === 'announce';
    // 对话里约好的提醒（kind = 'chat'）：徽标与定时任务分开，用户一眼能认出「这个是刚才聊天时答应我的」。
    const chat = reminder.kind === 'chat';
    // 待办清单到点（kind = 'todo'）：与调度器/会话/聊天三种来源分开认。
    const todo = reminder.kind === 'todo';
    const badgeText = announce ? '宠物消息' : todo ? '待办提醒' : chat ? '聊天提醒' : '定时任务';
    const actions = reminder.actions ?? [];
    const sessionId = reminder.sessionId;
    const [sending, setSending] = rt.useState('');
    const [draft, setDraft] = rt.useState('');
    const close = (): void => {
      void postAction(ROUTE_PATH + '/reminder/close', { id: reminder.id }).catch(() => undefined);
    };
    // 「等会儿」：收起来，15 分钟后再弹一次。用户此刻正忙，不是不关心。
    const snooze = (): void => {
      void postAction(ROUTE_PATH + '/reminder/snooze', { id: reminder.id, minutes: 15 }).catch(() => undefined);
    };
    // 「静音一小时」：一小时里所有到点提醒都不弹——开会、演示、专心写东西时用。
    const muteHour = (): void => {
      void postAction(ROUTE_PATH + '/mute', { minutes: 60 }).catch(() => undefined);
      close();
    };
    // 快捷动作 / 自由输入都是同一件事：把用户的一句话投回那个会话，agent 接着往下做。
    const sendAction = (label: string, body: string, keepDraft = false): void => {
      if (sessionId === undefined || sending !== '') return;
      setSending(label);
      if (!keepDraft) setDraft('');
      void postAction(ROUTE_PATH + '/reply', { sessionId, text: body, id: reminder.id })
        .then(() => setSending(''))
        .catch(() => setSending(''));
    };
    const sendDraft = (): void => {
      const body = draft.trim();
      if (body === '') return;
      sendAction('draft', body);
    };
    const focusSession = reminder.sessionId;
    const goSession = (): void => {
      if (focusSession === undefined) return;
      void postAction(ROUTE_PATH + '/focus-session', { sessionId: focusSession }).catch(() => undefined);
      close();
    };
    return h('div', {
      className: 'dsh-pet-bubble dsh-pet-reminder' + (on ? ' is-on is-clickable' : ''),
      onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
      children: [
        h('div', {
          key: 'head',
          className: 'dsh-pet-request__head',
          children: [
            h('span', {
              key: 'kind',
              className:
                'dsh-pet-request__badge is-reminder' +
                (announce ? ' is-announce' : todo ? ' is-todo' : chat ? ' is-chat' : ''),
              children: badgeText,
            }),
            Number.isFinite(planned)
              ? h('span', { key: 'time', className: 'dsh-pet-request__tool', children: clockText(planned) })
              : null,
          ],
        }),
        h('div', { key: 'title', className: 'dsh-pet-reminder__title', children: reminder.title }),
        lines.length > 0
          ? h('div', {
              key: 'lines',
              className: 'dsh-pet-reminder__lines',
              children: lines.map((line, index) =>
                h('div', { key: 'l' + index, className: 'dsh-pet-reminder__line', children: line }),
              ),
            })
          : null,
        text !== '' && text !== reminder.title
          ? h('div', { key: 'prompt', className: 'dsh-pet-request__body', children: text })
          : null,
        hint !== '' ? h('div', { key: 'hint', className: 'dsh-pet-reminder__hint', children: hint }) : null,
        actions.length > 0
          ? h('div', {
              key: 'quick',
              className: 'dsh-pet-reminder__quick',
              children: actions.map((action, index) =>
                h('button', {
                  key: 'q' + index,
                  type: 'button',
                  className: 'dsh-pet-reminder__chip' + (sending === action.label ? ' is-busy' : ''),
                  disabled: sending !== '',
                  onClick: () => sendAction(action.label, action.text),
                  children: sending === action.label ? '发送中…' : action.label,
                }),
              ),
            })
          : null,
        sessionId === undefined
          ? null
          : h('div', {
              key: 'draft',
              className: 'dsh-pet-reminder__reply',
              children: [
                h('input', {
                  key: 'in',
                  className: 'dsh-pet-request__input',
                  type: 'text',
                  placeholder: '接着说一句，我去干…',
                  value: draft,
                  maxLength: 400,
                  onInput: (e: ReactNS.FormEvent<HTMLInputElement>) => setDraft(e.currentTarget.value),
                  onKeyDown: (e: ReactNS.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    sendDraft();
                  },
                }),
                h('button', {
                  key: 'send',
                  type: 'button',
                  className: 'dsh-pet-request__btn',
                  disabled: sending !== '' || draft.trim() === '',
                  onClick: sendDraft,
                  children: sending === 'draft' ? '发送中…' : '发送',
                }),
              ],
            }),
        h('div', {
          key: 'actions',
          className: 'dsh-pet-request__actions',
          children: [
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'dsh-pet-request__btn is-primary',
              onClick: close,
              children: '知道了',
            }),
            focusSession === undefined
              ? null
              : h('button', {
                  key: 'focus',
                  type: 'button',
                  className: 'dsh-pet-request__btn',
                  onClick: goSession,
                  children: '去会话回复',
                }),
            h('button', {
              key: 'snooze',
              type: 'button',
              className: 'dsh-pet-request__btn is-ghost',
              onClick: snooze,
              title: '15 分钟后再提醒我',
              children: '等会儿',
            }),
            h('button', {
              key: 'mute',
              type: 'button',
              className: 'dsh-pet-request__btn is-ghost',
              onClick: muteHour,
              title: '一小时内不再弹提醒',
              children: '静音 1 小时',
            }),
          ],
        }),
      ],
    });
  };
}
