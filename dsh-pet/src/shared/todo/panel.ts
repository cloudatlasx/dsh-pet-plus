/**
 * 待办面板的内容与生命周期：取数、提交、删除、忙碌态，以及「点面板外收起」的意图转发。
 * 不负责定位与显隐：面板是气泡槽的一个槽位，位置与谁显示都由槽位决定。
 * 依赖 ./api 的 HTTP、./render 的骨架与 ./styles 的样式；清理只摘自己的节点与监听，不碰容器。
 * @module dsh-pet/src/shared/todo/panel
 */
import {
  TASKS_PATH,
  TODOS_PATH,
  addTodo,
  completeTask,
  loadTasks,
  loadTodos,
  patchTodo,
  removeTodo,
  type PetTask,
  type TodoResult,
} from './api.ts';
import { parseNaturalTimeInSentence } from './natural-time.ts';
import {
  createTodoPanelParts,
  renderTaskList,
  renderTodoList,
  setTodoBusy,
  setTodoError,
  TODO_HINT_TEXT,
  type TaskListHandlers,
  type TodoListHandlers,
} from './render.ts';
import { injectTodoCss } from './styles.ts';
import type { TodoItem } from './types.ts';

/** 面板挂载参数。 */
export interface TodoPanelOptions {
  /** 接口基址；桌面端可传绝对地址，缺省走同源前缀。 */
  baseUrl?: string;
  /** 定时任务接口基址：桌面端的 fetch 拿不到同源相对路径，必须给绝对地址。 */
  tasksUrl?: string;
  /** 点面板外面时调用；显隐由槽位决定，面板不自己收。 */
  onClose?: () => void;
  /** 这次按下的落点是否该让面板留着；两端各判各的命中层，面板不认识它们的类名。 */
  keepOpenOn?: (target: EventTarget | null) => boolean;
}

/** 面板句柄。 */
export interface TodoPanel {
  /** 面板根元素；调用方负责塞进自己的容器。 */
  el: HTMLElement;
  /** 关闭并清理（幂等）。 */
  dispose: () => void;
}

/** 落在面板外的那一下与随后的失焦之间的宽限期：窗口内的按键不该跟用户抢焦点。 */
const FOCUS_GUARD_MS = 400;
/** 每次聚焦最多抢回几次：抢多了会跟用户抢鼠标。 */
const FOCUS_GUARD_BUDGET = 3;
/** 打字期间重申键盘焦点的节拍：宠物窗是 showInactive 弹出的，DOM 聚焦不等于窗口真的能收到按键。 */
const FOCUS_ASSERT_MS = 700;

/**
 * 桌面端补一次「窗口要键盘焦点」的请求。
 *
 * 网页端没有 petBridge，这里什么也不做；桌面端由主进程调用 win.focus()，
 * 窗口已聚焦时它会自己跳过，所以重复调用不会跟别的应用抢焦点。
 */
function assertKeyboardFocus(): void {
  const bridge = (globalThis as { petBridge?: { requestKeyboardFocus?: () => void } }).petBridge;
  bridge?.requestKeyboardFocus?.();
}

/**
 * 建一个待办面板并开始取数。
 *
 * @param options - 接口基址与关闭回调。
 * @returns 面板根元素与清理函数。
 */
export function createTodoPanel(options: TodoPanelOptions = {}): TodoPanel {
  injectTodoCss();
  const parts = createTodoPanelParts();
  const baseUrl = options.baseUrl ?? TODOS_PATH;
  const tasksUrl = options.tasksUrl ?? TASKS_PATH;
  let disposed = false;
  let busy = false;
  let todos: TodoItem[] = [];
  let tasks: PetTask[] = [];

  // 三个函数互相引用（列表回调 → 修改 → 重拉 → 渲染）：mutate / reload 用函数声明提升，
  // 回调里引用它们不会在构造期求值，也就不存在初始化顺序问题。
  const handlers: TodoListHandlers = {
    onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),
    onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl)),
  };
  const taskHandlers: TaskListHandlers = {
    // 「完成」= 删除：DSH 的定时任务没有已完成状态，删掉才算不再打扰。
    onComplete: (task) => void mutate(() => completeTask(task.id, tasksUrl)),
  };

  /** 重新拉整张清单：修改一律以宿主返回为准，不在本地猜结果。 */
  async function reload(): Promise<void> {
    const [todoResult, taskResult] = await Promise.all([loadTodos(baseUrl), loadTasks(tasksUrl)]);
    if (disposed) return;
    if (!todoResult.ok) {
      setTodoError(parts, todoResult.message);
      // 加载失败时别让空态一直停在「加载中…」。
      parts.empty.textContent = '清单加载失败，关掉面板再开一次试试';
      parts.empty.hidden = false;
      return;
    }
    todos = todoResult.value;
    // 定时任务读失败只是少一块内容，不该让整张清单报错。
    tasks = taskResult.ok ? taskResult.value : [];
    setTodoError(parts, null);
    renderTodoList(parts, todos, handlers, Date.now());
    renderTaskList(parts, tasks, taskHandlers);
  }

  /** 串行执行一次修改：请求在途时禁止再次提交，成功后统一重拉。 */
  async function mutate(task: () => Promise<TodoResult<unknown>>): Promise<void> {
    if (disposed || busy) return;
    busy = true;
    // 打字打一半就提交时，输入框会被禁用而丢焦点；记下来，等这次修改收尾再还回去。
    const hadFocus = document.activeElement === parts.input;
    setTodoBusy(parts, true);
    setTodoError(parts, null);
    const result = await task();
    busy = false;
    if (disposed) return;
    setTodoBusy(parts, false);
    if (hadFocus) restoreFocus();
    if (!result.ok) {
      setTodoError(parts, result.message);
      return;
    }
    await reload();
  }

  // 焦点守卫：面板挂在宠物头顶，窗口切换、槽位重排、忙碌态禁用输入框都会把焦点拿走。
  // 只在「用户本来就在打字」（输入框里有内容）时才抢回，且每次聚焦最多抢几次——
  // 抢得太积极会跟用户的鼠标抢焦点，那比偶发丢焦点更烦。
  let refocusBudget = 0;
  let pointerDownAt = 0;
  /** 打字期间的焦点重申计时器：失焦就停，重新聚焦再开。 */
  let assertTimer: number | null = null;
  const stopAssert = (): void => {
    if (assertTimer === null) return;
    window.clearInterval(assertTimer);
    assertTimer = null;
  };
  const startAssert = (): void => {
    assertKeyboardFocus();
    if (assertTimer !== null) return;
    assertTimer = window.setInterval(() => {
      // 面板收起了、或用户已经离开输入框：别再打扰。
      if (disposed || document.activeElement !== parts.input) {
        stopAssert();
        return;
      }
      assertKeyboardFocus();
    }, FOCUS_ASSERT_MS);
  };
  const onDocPointerDown = (): void => {
    pointerDownAt = Date.now();
  };
  /** 抢回输入框焦点：等这一拍的 DOM 变更落定再抓，太早会被随后的重排再抹掉。 */
  function restoreFocus(): void {
    if (disposed) return;
    window.setTimeout(() => {
      if (disposed || busy || parts.input.disabled) return;
      parts.input.focus();
      assertKeyboardFocus();
    }, 80);
  }
  parts.input.addEventListener('focus', () => {
    refocusBudget = FOCUS_GUARD_BUDGET;
    startAssert();
  });
  parts.input.addEventListener('blur', () => {
    stopAssert();
    if (disposed || parts.input.value.trim() === '') return;
    // 用户自己刚点了别处（点面板外本来就会收起）：那是他的意图，别把焦点抢回去。
    if (Date.now() - pointerDownAt < FOCUS_GUARD_MS) return;
    if (refocusBudget <= 0) return;
    refocusBudget -= 1;
    restoreFocus();
  });
  document.addEventListener('pointerdown', onDocPointerDown, true);

  /** 提交新增：一句话里同时读时间和正文；空正文直接回到输入框。 */
  const submitAdd = (): void => {
    const raw = parts.input.value.trim();
    if (raw === '') {
      parts.input.focus();
      return;
    }
    // 时间就在同一句话里（「五分钟后提醒我拿快递」）；没听出时间也能记，只是不到点提醒。
    const parsed = parseNaturalTimeInSentence(raw);
    const dueAt = parsed === null ? null : parsed.dueAt;
    const text = parsed !== null && parsed.text !== '' ? parsed.text : raw;
    // 过去的时刻建出来就是逾期，提醒一上线就会喊，等于让用户先错一次再改。
    if (dueAt !== null && dueAt < Date.now()) {
      setTodoError(parts, '这个时间已经过去了，换一个吧');
      return;
    }
    setTodoError(parts, null);
    parts.hint.textContent =
      dueAt === null ? '没听出时间，先记成不提醒的待办；写成「五分钟后提醒我拿快递」我就能到点喊你～' : TODO_HINT_TEXT;
    void mutate(async () => {
      const result = await addTodo(text, dueAt, baseUrl);
      if (result.ok) parts.input.value = '';
      return result;
    });
  };

  parts.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAdd();
  });
  // 点面板外面就收起：面板没有标题栏也没有关闭按钮，收起意图只能靠「点别处」表达。
  // 用 mousedown 而不是 click，并走捕获阶段：拖拽宠物时 pointerdown 会先截走事件，
  // 监听 click 会漏掉「按住拖走」的那一下；捕获阶段保证在页面任何处理之前先判一次。
  // 不写 instanceof Node：shared-core 会被桌面端 lint 当成无 DOM 全局的脚本检查。
  const onDocMouseDown = (event: MouseEvent): void => {
    if (disposed) return;
    const target = event.target as Node | null;
    if (target !== null && parts.root.contains(target)) return;
    // 点宠物本体不算「点别处」：拖它走是常见需求，而拖拽的起点就是这一下。
    if (options.keepOpenOn?.(event.target) === true) return;
    options.onClose?.();
  };
  document.addEventListener('mousedown', onDocMouseDown, true);
  parts.closeButton.addEventListener('click', () => options.onClose?.());
  parts.empty.textContent = '加载中…';
  parts.empty.hidden = false;
  // 不自动聚焦输入框：面板挂在宠物头顶，抢走 DSH 输入框的焦点比少一次点击更烦。
  void reload();

  return {
    el: parts.root,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 监听必须摘：不摘的话面板关掉后它还会在每次点击时被判一次，等于永久挂着一个死回调。
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      stopAssert();
      parts.root.remove();
    },
  };
}
