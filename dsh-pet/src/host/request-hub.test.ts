/**
 * 中转站的准入判定：`/request/diag` 背后那套「为什么没弹气泡」的逻辑。
 *
 * 这里只测准入与自愈两条最容易悄悄坏掉的规则：
 * - 一个端都没连上时先给宽限，宽限内连上就照常接管；
 * - 上一条请求的计时器丢了（pending 永远占坑）时，按到期时刻自愈，别让后面全被挡住。
 * @module dsh-pet/src/host/request-hub.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRequestHub } from './request-hub.ts';
import type { RequestEnvelope } from '../shared/request.ts';

/** 记录写进 `sections.request` 的信封，测试据此拿请求 id。 */
const makeState = (written: RequestEnvelope[]) =>
  ({
    // 第二参数就是信封本身（不是 `{ data }` 包装），收起标记是同一 id + `closed: true`。
    writeSection: (name: string, section: unknown) => {
      if (name === 'request') {
        const env = section as RequestEnvelope | null;
        if (env && typeof env.id === 'string' && env.closed !== true) written.push(env);
      }
      return true;
    },
  }) as unknown as Parameters<typeof createRequestHub>[0]['state'];

/** 造一个只关心「有没有端」和「几点」的中转站。 */
function makeHub(options: { clock?: { t: number }; graceMs?: number; escalateMs?: number } = {}) {
  const clock = options.clock ?? { t: 1_000_000 };
  const env = { clients: 1, enabled: true };
  const written: RequestEnvelope[] = [];
  /** 被喊去屏幕中央的次数（每次 `escalate` 记一条）。 */
  const escalated: Array<'approval' | 'question'> = [];
  const hub = createRequestHub({
    state: makeState(written),
    log: { info: () => {}, warn: () => {} },
    enabled: () => env.enabled,
    hasClient: () => env.clients,
    now: () => clock.t,
    escalate: (kind) => escalated.push(kind),
    escalateMs: options.escalateMs ?? 60,
    ...(options.graceMs === undefined ? {} : { clientGraceMs: options.graceMs }),
  });
  /** 最近一条写出去的信封 id。 */
  const lastId = (): string => written[written.length - 1]?.id ?? '';
  return { hub, env, clock, lastId, escalated };
}

/** 造一条审批请求体。 */
const approval = { toolName: 'bash', reason: '跑一条命令' };

/** 等一个事件循环拍子（拦截器内部有 `await gate()`）。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('request hub 准入', () => {
  it('有端在线时接管提问，答完把答案交回去', async () => {
    const { hub, lastId } = makeHub();
    let delegated = false;
    const pending = hub.interceptQuestions(
      { questions: [{ id: 'q1', question: '走哪条路？', options: [{ label: 'A' }, { label: 'B' }] }] },
      () => {
        delegated = true;
        return { answers: [] };
      },
    ) as Promise<{ answers: unknown[] }>;
    await tick();
    assert.equal(hub.busy(), true);
    const answered = hub.answer({ id: lastId(), answers: [{ id: 'q1', selected: ['A'] }] });
    assert.equal(answered.ok, true);
    const result = await pending;
    assert.equal(delegated, false);
    assert.deepEqual(result.answers, [{ id: 'q1', selected: ['A'] }]);
    assert.equal(hub.busy(), false);
  });

  it('一个端都没连上时先等宽限：中途连上就仍然接管', async () => {
    const { hub, env, lastId } = makeHub({ graceMs: 480 });
    env.clients = 0;
    const promise = hub.interceptApproval(approval, () => 'unavailable') as Promise<string>;
    // 宽限期内端回来了（真机上是页面刷新 / 桌宠重启后的第一次长轮询）。
    setTimeout(() => {
      env.clients = 1;
    }, 60);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hub.busy(), true, '宽限期内连上就该接管，而不是让给 DSH');
    hub.answer({ id: lastId(), outcome: 'allowed-once' });
    assert.equal(await promise, 'allowed-once');
  });

  it('宽限到期仍无端在线：交回 DSH，并在诊断里留下 skip:no-client', async () => {
    const { hub, env } = makeHub({ graceMs: 120 });
    env.clients = 0;
    const outcome = await hub.interceptApproval(approval, () => 'unavailable');
    assert.equal(outcome, 'unavailable');
    const diag = hub.diag();
    assert.equal(diag.waiters, 0);
    assert.equal(diag.pending, false);
    assert.ok(
      diag.hits.some((hit) => hit.outcome === 'skip:no-client'),
      '诊断里要能看到是「没有端」导致的回落',
    );
  });

  it('上一条 pending 过了到期时刻：自愈并记一条 stale-pending', async () => {
    const clock = { t: 1_000_000 };
    const { hub, lastId } = makeHub({ clock });
    // 让一条请求挂住（不回答、不超时：把时钟推到很久以后模拟计时器丢了）。
    const stuck = hub.interceptApproval(approval, () => 'unavailable') as Promise<string>;
    await tick();
    assert.equal(hub.busy(), true);
    clock.t += 60 * 60 * 1000;
    // 下一条请求进来：先看清这是一条过期占坑的请求，settle 掉再继续。
    const next = hub.interceptApproval({ toolName: 'read' }, () => 'unavailable') as Promise<string>;
    assert.equal(await stuck, 'unavailable', '过期的请求应该以 delegate 收尾');
    await tick();
    assert.equal(hub.busy(), true, '新请求本身要接住');
    const hits = hub.diag().hits.map((hit) => hit.outcome);
    assert.ok(hits.includes('stale-pending'), `诊断里要有 stale-pending，实际：${hits.join(',')}`);
    hub.answer({ id: lastId(), outcome: 'rejected' });
    assert.equal(await next, 'rejected');
  });

  it('开关关掉时完全不拦截，诊断里记 skip:off', async () => {
    const { hub, env } = makeHub();
    env.enabled = false;
    const outcome = await hub.interceptQuestions({ questions: [{ id: 'q', question: '?' }] }, () => ({
      answers: [],
    }));
    assert.deepEqual(outcome, { answers: [] });
    assert.ok(hub.diag().hits.some((hit) => hit.outcome === 'skip:off'));
  });

  it('挂太久还没人理：喊一次「游到屏幕中央」，只喊一次', async () => {
    const { hub, lastId, escalated } = makeHub({ escalateMs: 30 });
    const pending = hub.interceptApproval(approval, () => 'unavailable') as Promise<string>;
    await tick();
    assert.deepEqual(escalated, [], '刚弹出来不该立刻把宠物叫走');
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.deepEqual(escalated, ['approval']);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.deepEqual(escalated, ['approval'], '只提醒一次，别循环游来游去');
    hub.answer({ id: lastId(), outcome: 'rejected' });
    assert.equal(await pending, 'rejected');
  });

  it('答得快就不喊：计时器随请求一起收掉', async () => {
    const { hub, lastId, escalated } = makeHub({ escalateMs: 200 });
    const pending = hub.interceptApproval(approval, () => 'unavailable') as Promise<string>;
    await tick();
    hub.answer({ id: lastId(), outcome: 'allowed-once' });
    assert.equal(await pending, 'allowed-once');
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.deepEqual(escalated, []);
  });
});
