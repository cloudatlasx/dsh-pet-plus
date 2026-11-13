import type { PetTask } from './api.ts';
import type { TodoItem } from './types.ts';
/** 面板里需要被面板逻辑持有的元素。 */
export interface TodoPanelParts {
    /** 根：面板内容的外框，节点由调用方塞进容器。 */
    root: HTMLElement;
    /** 添加表单：回车提交。 */
    form: HTMLFormElement;
    /** 正文输入框：一句话里同时写「什么时候」和「做什么」。 */
    input: HTMLInputElement;
    /** 清单容器。 */
    list: HTMLUListElement;
    /** 空态提示。 */
    empty: HTMLDivElement;
    /** 顶部的未完成计数。 */
    count: HTMLSpanElement;
    /** 右上角关闭按钮；桌面端窗口余量是穿透的，点空白收不起来，只能靠它。 */
    closeButton: HTMLButtonElement;
    /** 错误行（隐藏时为 `hidden`）。 */
    error: HTMLDivElement;
    /** 底部提示行：没听出时间时会换一句话说明。 */
    hint: HTMLDivElement;
    /** 定时任务区：没有任务时整块隐藏。 */
    tasks: HTMLDivElement;
    /** 定时任务清单容器。 */
    taskList: HTMLUListElement;
}
/** 清单条目上的交互回调。 */
export interface TodoListHandlers {
    /** 勾选 / 取消勾选。 */
    onToggle: (todo: TodoItem, done: boolean) => void;
    /** 删除（调用方已确认过一次）。 */
    onDelete: (todo: TodoItem) => void;
}
/** 底部提示：一句话把时间和事说完。 */
export declare const TODO_HINT_TEXT = "\u4E00\u53E5\u8BDD\u8BF4\u5B8C\u5C31\u884C\uFF1A\u300C\u4E94\u5206\u949F\u540E\u63D0\u9192\u6211\u62FF\u5FEB\u9012\u300D\u3002\u79BB\u5230\u671F\u8D8A\u8FD1\uFF0C\u6211\u4F1A\u63D0\u9192\u5F97\u8D8A\u52E4\u5FEB\uFF5E";
/**
 * 造面板骨架（尚未挂进文档）。
 *
 * @returns 面板需要的全部元素引用。
 */
export declare function createTodoPanelParts(): TodoPanelParts;
/**
 * 渲染一整张清单。
 *
 * @param parts - 面板元素。
 * @param todos - 已排序的待办。
 * @param handlers - 勾选与删除的回调。
 * @param now - 当前时刻，用来生成「还剩多久」。
 */
export declare function renderTodoList(parts: TodoPanelParts, todos: readonly TodoItem[], handlers: TodoListHandlers, now: number): void;
/** 定时任务行的交互回调。 */
export interface TaskListHandlers {
    /** 完成（= 删除）这条任务。 */
    onComplete: (task: PetTask) => void;
}
/** 任务行的副标题：种类 + 下次时刻 + 周期 + 停用标记。 */
export declare function taskMetaLabel(task: PetTask): string;
/**
 * 渲染定时任务清单：没有任务就整块隐藏，不占位置。
 *
 * @param parts - 面板元素。
 * @param tasks - 调度器返回的任务。
 * @param handlers - 完成回调。
 */
export declare function renderTaskList(parts: TodoPanelParts, tasks: readonly PetTask[], handlers: TaskListHandlers): void;
/**
 * 显示 / 清除错误行。
 *
 * @param parts - 面板元素。
 * @param message - 错误文案；null 表示清除。
 */
export declare function setTodoError(parts: TodoPanelParts, message: string | null): void;
/**
 * 切换忙碌态：请求在途时禁掉输入，避免连点建出两条。
 *
 * @param parts - 面板元素。
 * @param busy - 是否请求在途。
 */
export declare function setTodoBusy(parts: TodoPanelParts, busy: boolean): void;
