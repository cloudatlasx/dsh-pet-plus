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
import type { SettingsRuntime } from './runtime.ts';
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
/**
 * 造右键菜单卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export declare function makeMenuCard(rt: SettingsRuntime): FunctionComponent<MenuCardProps>;
