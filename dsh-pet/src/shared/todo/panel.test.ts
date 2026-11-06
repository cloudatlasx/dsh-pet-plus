/**
 * 待办面板的「一个输入框」：提交时从同一句话里拆出时间与正文，其余控件不再出现。
 *
 * 不引 jsdom：假 DOM 只实现本模块用到的成员（className / textContent / append / setAttribute / hidden / style），
 * 假 fetch 按 URL 与 method 返回固定响应，断言的是「发出去的请求体」这件事本身。
 * @module dsh-pet/src/shared/todo/panel.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTodoPanel } from './panel.ts';

/** 假元素：只保留测试要读的成员。 */
class FakeEl {
  tag: string;
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  placeholder = '';
  maxLength = 0;
  autocomplete = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, ((event: never) => void)[]> = {};
  classList = {
    add: (name: string): void => {
      this.className = this.className === '' ? name : this.className + ' ' + name;
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter((part) => part !== name)
        .join(' ');
    },
    toggle: (): void => undefined,
    contains: (name: string): boolean => this.className.split(' ').includes(name),
  };

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }

  appendChild(node: FakeEl): FakeEl {
    this.children.push(node);
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  addEventListener(name: string, handler: (event: never) => void): void {
    (this.listeners[name] ??= []).push(handler);
  }

  removeEventListener(): void {
    // 元素监听随节点一起丢掉，这里不用真的摘。
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  remove(): void {
    // 清理断言不需要真正摘节点。
  }

  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null;
  }

  getBoundingClientRect(): { height: number } {
    return { height: 0 };
  }
}

/** 假文档：createElement 交给 FakeEl，监听只记账。 */
class FakeDocument {
  head = new FakeEl('head');
  body = new FakeEl('body');
  listeners: Record<string, ((event: never) => void)[]> = {};

  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  addEventListener(name: string, handler: (event: never) => void): void {
    (this.listeners[name] ??= []).push(handler);
  }

  removeEventListener(): void {
    // 面板只在 dispose 里摘掉 document 上的监听，测试不需要。
  }
}

/** 固定喂给 fetch 的响应：POST /todos 把请求体回显成一条待办。 */
function withFakeEnv(): {
  doc: FakeDocument;
  requests: { url: string; method: string; body?: unknown }[];
  restore: () => void;
} {
  const doc = new FakeDocument();
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { document: doc });
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method, body });
    const payload =
      method === 'POST'
        ? {
            ok: true,
            todo: {
              id: 'todo-1',
              text: (body as { text: string }).text,
              dueAt: (body as { dueAt: number | null }).dueAt,
              done: false,
            },
          }
        : { ok: true, todos: [] };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
  return {
    doc,
    requests,
    restore: () => {
      Object.assign(globalThis, { document: originalDocument });
      globalThis.fetch = originalFetch;
    },
  };
}

/** 取出面板根下的直接子节点（假 DOM 的 children 是数组，类型上仍按真实接口断言）。 */
function childNodes(panel: { el: HTMLElement }): FakeEl[] {
  return Array.from(panel.el.children as unknown as FakeEl[]);
}

test('面板只有一个输入框：没有日期选择器、没有添加按钮', () => {
  const env = withFakeEnv();
  try {
    const panel = createTodoPanel({ baseUrl: '/todos' });
    const parts = childNodes(panel);
    const form = parts.find((node) => node.tag === 'form');
    assert.ok(form, '应该有添加表单');
    assert.equal(form.children.length, 1, '表单里只该有输入框');
    assert.equal(form.children[0].tag, 'input');
    assert.match(form.children[0].placeholder, /回车/);
    const lower = parts.find((node) => node.className.includes('dsh-pet-todo-lower'));
    assert.ok(lower);
    const folds = lower.children.map((node) => node.className).join(' ');
    assert.match(folds, /is-list/);
    assert.doesNotMatch(folds, /is-cal/, '日历折叠区已经去掉');
    panel.dispose();
  } finally {
    env.restore();
  }
});

test('提交：一句话里的时间进 dueAt，剩下的正文才是待办', async () => {
  const env = withFakeEnv();
  try {
    const panel = createTodoPanel({ baseUrl: '/todos' });
    const form = childNodes(panel).find((node) => node.tag === 'form');
    const input = form?.children[0];
    assert.ok(form && input);
    input.value = '五分钟后提醒我拿快递';
    for (const handler of form.listeners.submit) handler({ preventDefault: () => undefined } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const created = env.requests.find((request) => request.method === 'POST');
    assert.ok(created, '应该发出 POST');
    const body = created.body as { text: string; dueAt: number };
    assert.equal(body.text, '拿快递');
    assert.ok(body.dueAt > Date.now() + 4 * 60 * 1000, 'dueAt 应该在五分钟后');
    assert.ok(body.dueAt < Date.now() + 6 * 60 * 1000);
    assert.equal(input.value, '', '提交成功后清空输入框');
    panel.dispose();
  } finally {
    env.restore();
  }
});

test('提交：没听出时间就不猜，记成不提醒的待办', async () => {
  const env = withFakeEnv();
  try {
    const panel = createTodoPanel({ baseUrl: '/todos' });
    const form = childNodes(panel).find((node) => node.tag === 'form');
    const input = form?.children[0];
    assert.ok(form && input);
    input.value = '买三斤苹果';
    for (const handler of form.listeners.submit) handler({ preventDefault: () => undefined } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const created = env.requests.find((request) => request.method === 'POST');
    assert.ok(created);
    const body = created.body as { text: string; dueAt: number | null };
    assert.equal(body.dueAt, null);
    assert.equal(body.text, '买三斤苹果');
    panel.dispose();
  } finally {
    env.restore();
  }
});
