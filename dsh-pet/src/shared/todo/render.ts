/**
 * 待办面板的 DOM 骨架与清单渲染：只拼元素、绑事件，不取数、不定位、不关弹窗。
 *
 * 删除做成两步（先变成「确认」，2.5 秒后自动复原）：清单没有撤销，误点一次就没了太容易。
 * @module dsh-pet/src/shared/todo/render
 */
import { metaLabel, todoUrgency } from './format.ts';
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

/** 删除按钮的二次确认窗口（ms）：超时自动复原，避免「确认」态一直挂着。 */
const DELETE_ARM_MS = 2500;

/** 空态文案：加载中会临时替换它，重渲染时再写回来。 */
const EMPTY_TEXT = '还没有待办。记一件要做的事，到点我会提醒你～';

/** 底部提示：一句话把时间和事说完。 */
export const TODO_HINT_TEXT = '一句话说完就行：「五分钟后提醒我拿快递」。离到期越近，我会提醒得越勤快～';

/** 清单最多露出几行，其余靠滚动。 */
const LIST_ROWS = 2;

/** 造一个带 class 的元素，避免每处都写 createElement + className。 */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 造一个可折叠区：高度靠 grid-template-rows 在 0fr 与 1fr 之间过渡，内容高度是 auto 也能动画。 */
function fold(className: string, children: HTMLElement[]): HTMLDivElement {
  const outer = element('div', 'dsh-pet-todo-fold ' + className);
  const clip = element('div', 'dsh-pet-todo-foldClip');
  clip.append(...children);
  outer.appendChild(clip);
  return outer;
}

/**
 * 造面板骨架（尚未挂进文档）。
 *
 * @returns 面板需要的全部元素引用。
 */
export function createTodoPanelParts(): TodoPanelParts {
  const root = element('div', 'dsh-pet-todo');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '待办事项');

  const head = element('div', 'dsh-pet-todo-head');
  const title = element('span', 'dsh-pet-todo-title', '待办事项');
  const count = element('span', 'dsh-pet-todo-count', '0 项未完成');
  count.setAttribute('aria-live', 'polite');
  const closeButton = element('button', 'dsh-pet-todo-close', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭待办面板');
  head.append(title, count, closeButton);

  const form = element('form', 'dsh-pet-todo-form');
  const input = element('input', 'dsh-pet-todo-input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = '五分钟后提醒我拿快递…（回车记下）';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '待办内容，可以一句话写清时间和事');
  form.append(input);

  const error = element('div', 'dsh-pet-todo-err');
  error.hidden = true;

  const empty = element('div', 'dsh-pet-todo-empty', EMPTY_TEXT);
  empty.hidden = true;

  const list = element('ul', 'dsh-pet-todo-list');
  const hint = element('div', 'dsh-pet-todo-hint', TODO_HINT_TEXT);

  // 面板只要一个输入框：时间就在同一句话里说，其余控件都收进这句话。
  const lower = element('div', 'dsh-pet-todo-lower');
  lower.append(fold('is-list', [error, empty, list, hint]));

  // 定时任务：DSH 调度器里的任务列在下面，只能「完成」（= 删除），不能在这里新建——
  // 新建走对话（「每天早上八点提醒我…」）或 DSH 自己的界面。
  const tasks = element('div', 'dsh-pet-todo-tasks');
  const tasksHead = element('div', 'dsh-pet-todo-tasksHead', '定时任务');
  const taskList = element('ul', 'dsh-pet-todo-list dsh-pet-todo-taskList');
  tasks.append(tasksHead, taskList);
  tasks.hidden = true;
  root.append(head, form, lower, tasks);
  return { root, form, input, list, empty, count, closeButton, error, hint, tasks, taskList };
}

/**
 * 把清单压到「两行」的高度，多出来的部分靠清单自己滚动。
 *
 * 行高随正文折行变化，写不成 CSS 常量，所以量一次首行再乘二；量不到（未挂载）就不设上限，
 * 免得把清单压成 0 高。
 *
 * @param list - 清单容器。
 */
function capListHeight(list: HTMLUListElement): void {
  const first = list.firstElementChild;
  if (first === null) {
    list.style.maxHeight = '';
    return;
  }
  const rowHeight = first.getBoundingClientRect().height;
  if (rowHeight <= 0) return;
  // 清单自带内边距，算进高度里才不会被截掉最后一行的一半。
  const pad = parseFloat(getComputedStyle(list).paddingTop) || 0;
  list.style.maxHeight = rowHeight * LIST_ROWS + pad * 2 + 'px';
}

/**
 * 渲染一整张清单。
 *
 * @param parts - 面板元素。
 * @param todos - 已排序的待办。
 * @param handlers - 勾选与删除的回调。
 * @param now - 当前时刻，用来生成「还剩多久」。
 */
export function renderTodoList(
  parts: TodoPanelParts,
  todos: readonly TodoItem[],
  handlers: TodoListHandlers,
  now: number,
): void {
  parts.list.textContent = '';
  const pending = todos.filter((todo) => !todo.done).length;
  parts.count.textContent = `${pending} 项未完成`;
  parts.empty.textContent = EMPTY_TEXT;
  parts.empty.hidden = todos.length > 0;
  for (const todo of todos) parts.list.appendChild(renderItem(todo, handlers, now));
  capListHeight(parts.list);
}

/** 定时任务行的交互回调。 */
export interface TaskListHandlers {
  /** 完成（= 删除）这条任务。 */
  onComplete: (task: PetTask) => void;
}

/** 任务种类的中文说法；未认识的原样显示。 */
const TASK_KINDS: Record<string, string> = {
  at: '一次',
  after: '稍后一次',
  daily: '每天',
  weekly: '每周',
  every: '每隔一段',
  cron: '按计划',
  chat: '她记着的提醒',
};

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value);
}

/** 下一次触发时刻：`M/D HH:mm`；解析不出来就给空串。 */
function stampOf(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 任务行的副标题：种类 + 下次时刻 + 周期 + 停用标记。 */
export function taskMetaLabel(task: PetTask): string {
  const parts: string[] = [];
  const kind = TASK_KINDS[task.kind] ?? task.kind;
  if (task.repeat !== undefined && task.repeat !== '') {
    // 周期提醒：让「每个工作日 11:00」自己说明，不再叠一个笼统的种类词
    parts.push(task.repeat);
    const when = stampOf(task.scheduledAt);
    if (when !== '') parts.push('下次 ' + when);
  } else {
    parts.push(kind);
    const when = stampOf(task.scheduledAt);
    if (when !== '') parts.push(when);
  }
  if (task.status === 'inactive') parts.push('已停用');
  return parts.join(' · ');
}

/**
 * 渲染定时任务清单：没有任务就整块隐藏，不占位置。
 *
 * @param parts - 面板元素。
 * @param tasks - 调度器返回的任务。
 * @param handlers - 完成回调。
 */
export function renderTaskList(parts: TodoPanelParts, tasks: readonly PetTask[], handlers: TaskListHandlers): void {
  parts.taskList.textContent = '';
  parts.tasks.hidden = tasks.length === 0;
  for (const task of tasks) {
    const item = element('li', 'dsh-pet-todo-item is-task' + (task.status === 'inactive' ? ' is-done' : ''));
    const main = element('div', 'dsh-pet-todo-main');
    const text = element('div', 'dsh-pet-todo-text', task.title);
    const meta = element('div', 'dsh-pet-todo-meta', taskMetaLabel(task));
    main.append(text, meta);

    const done = element('button', 'dsh-pet-todo-done', '完成');
    done.type = 'button';
    done.setAttribute('aria-label', '完成任务：' + task.title);
    done.addEventListener('click', () => handlers.onComplete(task));

    item.append(main, done);
    parts.taskList.appendChild(item);
  }
}

/** 渲染一条；未完成项带紧迫度，已完成项划线。 */
function renderItem(todo: TodoItem, handlers: TodoListHandlers, now: number): HTMLLIElement {
  const item = element('li', 'dsh-pet-todo-item' + (todo.done ? ' is-done' : ''));
  if (!todo.done) item.dataset.urgency = todoUrgency(todo.dueAt, now);

  const check = element('input', 'dsh-pet-todo-check');
  check.type = 'checkbox';
  check.checked = todo.done;
  check.setAttribute('aria-label', (todo.done ? '标记未完成：' : '标记完成：') + todo.text);
  check.addEventListener('change', () => handlers.onToggle(todo, check.checked));

  const main = element('div', 'dsh-pet-todo-main');
  const text = element('div', 'dsh-pet-todo-text', todo.text);
  const meta = element('div', 'dsh-pet-todo-meta', metaLabel(todo, now));
  main.append(text, meta);

  const remove = element('button', 'dsh-pet-todo-del', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除：' + todo.text);
  remove.addEventListener('click', () => {
    // 第一次点击只进入确认态；再点一次才真的删。
    if (remove.dataset.armed !== '1') {
      remove.dataset.armed = '1';
      remove.classList.add('is-armed');
      remove.textContent = '确认';
      window.setTimeout(() => {
        // 面板已关闭 / 已重渲染时元素不再在文档里：静默复原即可。
        if (!remove.isConnected) return;
        delete remove.dataset.armed;
        remove.classList.remove('is-armed');
        remove.textContent = '✕';
      }, DELETE_ARM_MS);
      return;
    }
    handlers.onDelete(todo);
  });

  item.append(check, main, remove);
  return item;
}

/**
 * 显示 / 清除错误行。
 *
 * @param parts - 面板元素。
 * @param message - 错误文案；null 表示清除。
 */
export function setTodoError(parts: TodoPanelParts, message: string | null): void {
  parts.error.hidden = message === null;
  parts.error.textContent = message ?? '';
}

/**
 * 切换忙碌态：请求在途时禁掉输入，避免连点建出两条。
 *
 * @param parts - 面板元素。
 * @param busy - 是否请求在途。
 */
export function setTodoBusy(parts: TodoPanelParts, busy: boolean): void {
  parts.input.disabled = busy;
}
