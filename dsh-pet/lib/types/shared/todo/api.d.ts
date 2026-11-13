import { type TodoItem } from './types.ts';
/** 待办接口的基址（与宿主路由同一前缀）。 */
export declare const TODOS_PATH: string;
/** 定时任务接口的基址（DSH 调度器里的任务）。 */
export declare const TASKS_PATH: string;
/** 一次调用的结论：成功带解析后的值，失败带一句能直接展示的中文原因。 */
export type TodoResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    message: string;
};
/** 读整张清单。 */
export declare function loadTodos(baseUrl?: string): Promise<TodoResult<TodoItem[]>>;
/** 新建一条；`dueAt` 为 null 表示没有期限。 */
export declare function addTodo(text: string, dueAt: number | null, baseUrl?: string): Promise<TodoResult<TodoItem>>;
/** 修改一条：只传要改的字段。 */
export declare function patchTodo(id: string, patch: {
    text?: string;
    dueAt?: number | null;
    done?: boolean;
}, baseUrl?: string): Promise<TodoResult<TodoItem>>;
/** 删除一条；返回删掉的条数（0 = 本来就没有）。 */
export declare function removeTodo(id: string, baseUrl?: string): Promise<TodoResult<number>>;
/** 一条 DSH 定时任务或宠物自己记着的提醒：面板只展示、只允许完成，不在面板里新建。 */
export interface PetTask {
    id: string;
    title: string;
    kind: string;
    scheduledAt: string;
    status: string;
    /** 周期说法（`每个工作日 11:00`）；一次性的任务没有。 */
    repeat?: string;
}
/** 读 DSH 定时任务清单。 */
export declare function loadTasks(baseUrl?: string): Promise<TodoResult<PetTask[]>>;
/** 完成（删除）一条定时任务：周期任务只有删掉才算不再打扰。 */
export declare function completeTask(id: string, baseUrl?: string): Promise<TodoResult<null>>;
