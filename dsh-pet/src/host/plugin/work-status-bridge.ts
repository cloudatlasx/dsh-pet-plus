/**
 * 工作状态联动：把 store 里的活动状态按 5s 间隔压扁后写进轮询快照。
 *
 * 不监听会话事件（归会话监听器），不渲染气泡。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/work-status-bridge
 */
import type { HostSetup } from './setup.ts';

/** 工作状态桥的输入：轮询快照、工作状态 store，以及判定「外部槽」用的哨兵会话 id。 */
export type WorkStatusBridgeInput = Pick<HostSetup, 'state' | 'workStatus' | 'EXTERNAL_WORK_SESSION'>;

/**
 * 创建工作状态桥。
 */
export function createWorkStatusBridge(deps: WorkStatusBridgeInput) {
  const { state, workStatus, EXTERNAL_WORK_SESSION } = deps;
  // 工作状态快照写进 S：内容真的变了才写（每次写都推进 counter，前端据此重播档位动画）。
  // 只压「距上次写入不足 WORK_STATE_GAP_MS 的 working → result」——工具秒回时会来回切十几次，
  // 每切一次前端就把片段从第 0 帧重播；反向不压（开工迟到比多换一次片更糟），终态不压。
  const WORK_STATE_GAP_MS = 5000;

  let publishedWork = '\u0000';

  let publishedState: string | null = null;

  let publishedWorkAt = 0;

  let workFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    // 会话也算内容：同档同文案换了会话，页面必须知道，否则点气泡会跳到上一条会话。
    // 步数也要进 key：档位与文案都没变、只是又跑完一个工具时，气泡里的「第 N 步」得跟着走。
    const key =
      String(snap.state) +
      '\u0000' +
      String(snap.task) +
      '\u0000' +
      String(snap.sessionId ?? '') +
      '\u0000' +
      String(snap.steps) +
      '\u0000' +
      String(snap.todoDone) +
      '/' +
      String(snap.todoTotal);
    if (key === publishedWork) return;
    // 抖动判定：只压 working → result 这一个方向（同档只换文案不算抖动，照常立即写；
    // 反向 result → working 立即写）
    const busyFlip = publishedState === 'working' && snap.state === 'result';
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (busyFlip && wait > 0) {
      // 整条不写（档位与文案一起压住）：到点再取最新快照补写
      // （不要在这里缓存 snap——期间可能又变了）
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedWorkAt = Date.now();
    // 外部槽（`api`）不是真实 DSH 会话：这里写成 null，客户端才不会把气泡做成一个点了没反应的入口。
    const sessionId = snap.sessionId === null || snap.sessionId === EXTERNAL_WORK_SESSION ? null : snap.sessionId;
    state.writeSection('workStatus', {
      state: snap.state,
      task: snap.task,
      sessionId,
      steps: snap.steps,
      startedAt: snap.startedAt,
      todoDone: snap.todoDone,
      todoTotal: snap.todoTotal,
    });
  };

  // 外部槽（`api`）没有「回合结束」这种天然终点，只能靠 touchedAt 过期。但过期判定发生在
  // 快照读取里，而 section 是「内容真的变了才写」——没人来读就没人写，气泡就会停在最后一次的值上。
  // 所以这里定期读一次：过期后快照换成别的会话（或 null），key 变了，上面那段自然会把条子收掉。
  // 15s 足够让「十分钟」看着准（最多晚 15s 下线），又不会让空转的写变成噪声。
  const WORK_STATUS_SWEEP_MS = 15000;

  const sweepTimer = setInterval(() => {
    publishWorkStatus();
  }, WORK_STATUS_SWEEP_MS);

  sweepTimer.unref?.();

  /** 停掉挂起的补写定时器与周期清扫（插件卸载时调用）。 */
  const stopWorkStatusFlush = (): void => {
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    clearInterval(sweepTimer);
  };
  return { publishWorkStatus, stopWorkStatusFlush };
}
/** 工作状态桥的产出（供下游工厂按需 Pick）。 */
export type WorkStatusBridge = ReturnType<typeof createWorkStatusBridge>;
