/**
 * 右键菜单卡：排顺序、藏项、恢复默认。
 *
 * 只改「工具项」这一段（对话 / 余额 / 待办 / 记录 / 碎碎念 / 睡觉），
 * 动画点播、显示位置与第三方「更多」不在这里排——它们各有出现条件，排了也没有意义。
 *
 * 顺序用一个数组就地交换（不是每次拖拽重建），这样按钮的焦点不会在重排时被抽走。
 * 隐藏不删位置：把 `hidden` 当成开关，用户重新显示时项还在原来的排位上。
 * @module dsh-pet/src/client/settings/menu-card
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';
import { MENU_TOOL_ACTIONS, resolveMenuLayout } from '../../shared/menu/layout.ts';

/** 右键菜单卡的输入。 */
export interface MenuCardProps {
  /** 保存中或配置未就绪时禁用全部按钮。 */
  busy: boolean;
  /** 当前顺序（动作名）。 */
  order: readonly string[];
  /** 当前隐藏项（动作名）。 */
  hidden: readonly string[];
  /** 顺序或隐藏项变化。 */
  onChange: (order: string[], hidden: string[]) => void;
}

/** 动作名 → 菜单文案（与菜单上逐字一致，避免设置页与菜单两套说法）。 */
const LABELS = new Map(MENU_TOOL_ACTIONS.map((item) => [item.action, item.label]));

/**
 * 造右键菜单卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeMenuCard(rt: SettingsRuntime): FunctionComponent<MenuCardProps> {
  const { h, t } = rt;
  const { cardHead } = makeUiKit({ h, t });

  return function MenuCard(props: MenuCardProps) {
    // 用 resolveMenuLayout 兜一次：配置里可能有旧版本的名字或缺失的项，
    // 这里拿到的才是「真实会显示的那一排」，否则用户会看到菜单里没有的项。
    const layout = resolveMenuLayout(props.order, props.hidden);
    const move = (from: number, delta: number): void => {
      const to = from + delta;
      if (to < 0 || to >= layout.order.length) return;
      const next = [...layout.order];
      const [item] = next.splice(from, 1);
      if (item === undefined) return;
      next.splice(to, 0, item);
      props.onChange(next, layout.hidden);
    };
    const toggle = (action: string): void => {
      const hidden = layout.hidden.includes(action)
        ? layout.hidden.filter((item) => item !== action)
        : [...layout.hidden, action];
      props.onChange(layout.order, hidden);
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('menuTitle'), t('menuHint')),
        h('div', {
          className: 'dsh-pet-cfg__menuList',
          children: layout.order.map((action, index) => {
            const hidden = layout.hidden.includes(action);
            return h('div', {
              key: action,
              className: 'dsh-pet-cfg__menuRow' + (hidden ? ' is-hidden' : ''),
              children: [
                h('span', { className: 'dsh-pet-cfg__menuName', children: LABELS.get(action) ?? action }),
                h('span', {
                  className: 'dsh-pet-cfg__menuOps',
                  children: [
                    h('button', {
                      type: 'button',
                      className: 'dsh-pet-cfg__btn is-sm',
                      disabled: props.busy || index === 0,
                      title: t('menuMoveUp'),
                      onClick: () => move(index, -1),
                      children: '↑',
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dsh-pet-cfg__btn is-sm',
                      disabled: props.busy || index === layout.order.length - 1,
                      title: t('menuMoveDown'),
                      onClick: () => move(index, 1),
                      children: '↓',
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dsh-pet-cfg__btn is-sm' + (hidden ? '' : ' is-primary'),
                      disabled: props.busy,
                      title: hidden ? t('menuShow') : t('menuHide'),
                      onClick: () => toggle(action),
                      children: hidden ? t('menuShow') : t('menuHide'),
                    }),
                  ],
                }),
              ],
            });
          }),
        }),
        h('div', {
          className: 'dsh-pet-cfg__actionsRow',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm',
              disabled: props.busy,
              onClick: () => props.onChange([], []),
              children: t('menuReset'),
            }),
            h('span', { className: 'dsh-pet-cfg__note', children: t('menuNote') }),
          ],
        }),
      ],
    });
  };
}
