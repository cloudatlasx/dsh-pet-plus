/**
 * 右键菜单卡：拖动排序、逐项显隐、恢复默认。
 *
 * 只改「工具项」这一段（对话 / 余额 / 待办 / 记录 / 碎碎念 / 睡觉），
 * 动画点播、显示位置与第三方「更多」不在这里排——它们各有出现条件，排了也没有意义。
 *
 * 布局用三列网格（把手 / 名字 / 显隐按钮）：每行宽度与高度完全一致，名字过长时省略号截断，
 * 按钮靠右固定宽度——名字与按钮不会挤在一起（这正是之前「都挤在一起」的原因）。
 * 排序用原生拖拽（不引第三方库）：拖动中记下起点，落到目标行时把起点插到目标位置。
 * @module dsh-pet/src/client/settings/menu-card
 */
import type { FunctionComponent } from 'react';
import type * as ReactNS from 'react';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';
import { MENU_TOOL_ACTIONS, resolveMenuLayout } from '../../shared/menu/layout.ts';

/** 右键菜单卡的输入。 */
export interface MenuCardProps {
  /** 保存中或配置未就绪时禁用全部操作。 */
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
  const { h, t, useState } = rt;
  const { cardHead } = makeUiKit({ h, t });

  return function MenuCard(props: MenuCardProps) {
    // 用 resolveMenuLayout 兜一次：配置里可能有旧版本的名字或缺失的项，
    // 这里拿到的才是「真实会显示的那一排」，否则用户会看到菜单里没有的项。
    const layout = resolveMenuLayout(props.order, props.hidden);
    // 拖动起点与当前悬停行：两者都在拖拽期间才有值，用来画插入位置与半透明拖动行。
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [overIndex, setOverIndex] = useState<number | null>(null);

    const moveTo = (from: number, to: number): void => {
      const total = layout.order.length;
      if (from === to || from < 0 || to < 0 || from >= total || to >= total) return;
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

    const clearDrag = (): void => {
      setDragIndex(null);
      setOverIndex(null);
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('menuTitle'), t('menuHint')),
        h('div', {
          className: 'dsh-pet-cfg__menuList',
          children: layout.order.map((action, index) => {
            const hidden = layout.hidden.includes(action);
            const label = LABELS.get(action) ?? action;
            const classes = ['dsh-pet-cfg__menuRow'];
            if (hidden) classes.push('is-hidden');
            if (dragIndex === index) classes.push('is-dragging');
            if (overIndex === index && dragIndex !== null && dragIndex !== index) classes.push('is-over');
            return h('div', {
              key: action,
              className: classes.join(' '),
              draggable: !props.busy,
              title: t('menuDrag'),
              onDragStart: (e: ReactNS.DragEvent<HTMLDivElement>) => {
                if (props.busy) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.effectAllowed = 'move';
                // 放一份纯文本：某些平台上不 setData 就不会真正开始拖动。
                e.dataTransfer.setData('text/plain', String(index));
                setDragIndex(index);
                setOverIndex(index);
              },
              onDragOver: (e: ReactNS.DragEvent<HTMLDivElement>) => {
                if (dragIndex === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOverIndex(index);
              },
              onDrop: (e: ReactNS.DragEvent<HTMLDivElement>) => {
                if (dragIndex === null) return;
                e.preventDefault();
                moveTo(dragIndex, index);
                clearDrag();
              },
              onDragEnd: clearDrag,
              children: [
                h('span', { className: 'dsh-pet-cfg__menuHandle', 'aria-hidden': true, children: '⠿' }),
                h('span', { className: 'dsh-pet-cfg__menuName', title: label, children: label }),
                h('button', {
                  type: 'button',
                  className: 'dsh-pet-cfg__btn is-sm dsh-pet-cfg__menuToggle' + (hidden ? '' : ' is-primary'),
                  disabled: props.busy,
                  title: hidden ? t('menuShow') : t('menuHide'),
                  onClick: () => toggle(action),
                  children: hidden ? t('menuShow') : t('menuHide'),
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
