/**
 * 对话记录面板：在对话弹窗里就地展开「我和她说过什么」，并提供一键导出。
 *
 * 数据全部来自宿主 `GET /chat?rounds=`（记忆文件的唯一读写方），本模块只读不写；
 * 「保存」打 `POST /chat/export`，由宿主把**整条**历史写成 Markdown（不受这里的 200 轮上限影响），
 * 返回的绝对路径显示在脚注里，用户自己去打开或另存。
 *
 * 两端共用：浏览器与桌面都通过 mountChatDialog 挂载它，所以桌面 helper 不需要另写一份。
 * @module dsh-pet/src/shared/chat/log
 */

/** 一条历史消息（宿主返回的形状，只取展示需要的字段）。 */
interface LogMessage {
  role?: string;
  content?: unknown;
  ts?: unknown;
  image?: { width?: unknown; height?: unknown };
  meme?: unknown;
  action?: unknown;
  remind?: { title?: unknown; dueAt?: unknown };
}

/** 面板句柄。 */
export interface ChatLogPanel {
  /** 根元素（由对话弹窗插到输入框上方）。 */
  readonly root: HTMLDivElement;
  /** 展开或收起。 */
  readonly toggle: () => void;
  /** 展开（已展开则刷新）。 */
  readonly open: () => void;
  /** 收起。 */
  readonly close: () => void;
  /** 此刻是否展开。 */
  readonly isOpen: () => boolean;
  /** 重新拉一次历史（发送成功后调，保持面板与记忆一致）。 */
  readonly refresh: () => void;
  /** 释放（停掉未落地的请求回调，移除元素）。 */
  readonly dispose: () => void;
}

/** 一次最多回看多少轮（宿主对 `?rounds=` 的上限是 200）。 */
const LOG_ROUNDS = 200;

/** 请求超时（ms）：读记忆很快，超过就是宿主出问题了。 */
const LOG_TIMEOUT_MS = 15_000;

/** 时间戳 → `HH:mm`；跨天的消息在行首带上日期。 */
function clockOf(ts: number, today: Date): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** 造一枚小按钮（样式与对话弹窗的图标按钮同族）。 */
function textButton(label: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dsh-pet-chat-log-btn ' + cls;
  btn.textContent = label;
  return btn;
}

/**
 * 建对话记录面板。
 *
 * @param opts.petId - 宠物 id（GET/POST 都要）。
 * @param opts.baseUrl - 已含挂载前缀、**不含查询串**的对话地址（如 `.../dsh-pet-7340/chat`）。
 * @returns 面板句柄；根元素默认隐藏，由调用方决定插到哪儿。
 */
export function createChatLog(opts: { petId: string; baseUrl: string }): ChatLogPanel {
  const { petId, baseUrl } = opts;

  const root = document.createElement('div');
  root.className = 'dsh-pet-chat-log';
  root.hidden = true;

  const head = document.createElement('div');
  head.className = 'dsh-pet-chat-log-head';
  const title = document.createElement('span');
  title.className = 'dsh-pet-chat-log-title';
  title.textContent = '对话记录';
  const count = document.createElement('span');
  count.className = 'dsh-pet-chat-log-count';
  const saveBtn = textButton('保存到文件', 'dsh-pet-chat-log-save');
  saveBtn.title = '把整条对话历史导出成 Markdown 文件';
  const closeBtn = textButton('✕', 'dsh-pet-chat-log-x');
  closeBtn.title = '收起记录';
  closeBtn.setAttribute('aria-label', '收起记录');
  head.append(title, count, saveBtn, closeBtn);

  const list = document.createElement('div');
  list.className = 'dsh-pet-chat-log-list';
  const note = document.createElement('div');
  note.className = 'dsh-pet-chat-log-note';
  root.append(head, list, note);

  let open = false;
  let disposed = false;
  /** 请求序号：连续展开/刷新时只认最后一次的响应，避免旧响应把新列表盖掉。 */
  let seq = 0;

  const setNote = (text: string, isErr = false): void => {
    note.textContent = text;
    note.dataset.err = isErr ? '1' : '0';
    note.style.display = text === '' ? 'none' : 'block';
  };

  /** 把一条消息渲染成一行（角色决定左右与配色）。 */
  const rowOf = (m: LogMessage, today: Date): HTMLDivElement => {
    const row = document.createElement('div');
    const role = m.role === 'user' ? 'user' : 'assistant';
    row.className = 'dsh-pet-chat-log-row';
    row.dataset.role = role;
    const meta = document.createElement('div');
    meta.className = 'dsh-pet-chat-log-meta';
    const ts = typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0;
    meta.textContent = (role === 'user' ? '我' : '她') + (ts > 0 ? ' · ' + clockOf(ts, today) : '');
    const body = document.createElement('div');
    body.className = 'dsh-pet-chat-log-text';
    const content = typeof m.content === 'string' ? m.content : '';
    body.textContent = content.trim() === '' ? '（空）' : content;
    row.append(meta, body);
    // 附件/配图/动作/提醒：只留一行小字，别把手写正文挤下去
    const tags: string[] = [];
    if (m.image !== undefined) {
      const w = Number(m.image.width);
      const h = Number(m.image.height);
      const sized = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
      tags.push(sized ? `附图 ${String(w)}×${String(h)}` : '附图');
    }
    if (typeof m.meme === 'string' && m.meme !== '') tags.push('配图 ' + m.meme);
    if (typeof m.action === 'string' && m.action !== '') tags.push('动作 ' + m.action);
    if (m.remind !== undefined) {
      const due = typeof m.remind?.dueAt === 'number' ? clockOf(m.remind.dueAt, today) : '';
      tags.push('提醒 ' + String(m.remind?.title ?? '') + (due === '' ? '' : '（' + due + '）'));
    }
    if (tags.length > 0) {
      const tag = document.createElement('div');
      tag.className = 'dsh-pet-chat-log-tag';
      tag.textContent = tags.join(' · ');
      row.appendChild(tag);
    }
    return row;
  };

  /** 拉一次历史并重绘；滚到底（最新在下方）。 */
  const refresh = (): void => {
    if (disposed) return;
    const mine = ++seq;
    const url = baseUrl + '?pet=' + encodeURIComponent(petId) + '&rounds=' + LOG_ROUNDS;
    fetch(url, { signal: AbortSignal.timeout(LOG_TIMEOUT_MS) })
      .then((res) => res.json())
      .then((raw: unknown) => {
        if (disposed || mine !== seq) return;
        const o = (raw ?? {}) as Record<string, unknown>;
        const messages = Array.isArray(o.messages) ? (o.messages as LogMessage[]) : [];
        const today = new Date();
        list.replaceChildren(...messages.map((m) => rowOf(m, today)));
        if (messages.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsh-pet-chat-log-empty';
          empty.textContent = '还没有聊过天。';
          list.appendChild(empty);
        }
        count.textContent = messages.length === 0 ? '' : `共 ${messages.length} 条 · 最近 ${LOG_ROUNDS} 轮`;
        setNote(messages.length >= LOG_ROUNDS * 2 ? '这里只显示最近的记录；保存会导出全部。' : '');
        list.scrollTop = list.scrollHeight;
      })
      .catch((e: unknown) => {
        if (disposed || mine !== seq) return;
        setNote('读取记录失败：' + (e instanceof Error ? e.message : String(e)), true);
      });
  };

  const save = (): void => {
    if (disposed) return;
    saveBtn.disabled = true;
    setNote('正在保存…');
    const url = baseUrl + '/export?pet=' + encodeURIComponent(petId);
    fetch(url, { method: 'POST', signal: AbortSignal.timeout(LOG_TIMEOUT_MS) })
      .then((res) => res.json())
      .then((raw: unknown) => {
        if (disposed) return;
        const o = (raw ?? {}) as Record<string, unknown>;
        if (o.ok === true && typeof o.path === 'string') {
          setNote(`已保存 ${String(o.count ?? '')} 条 → ${o.path}`);
        } else {
          setNote('保存失败：' + String(o.message ?? o.reason ?? '未知原因'), true);
        }
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setNote('保存失败：' + (e instanceof Error ? e.message : String(e)), true);
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  };

  const panel: ChatLogPanel = {
    root,
    toggle: () => {
      if (open) panel.close();
      else panel.open();
    },
    open: () => {
      if (open) {
        refresh();
        return;
      }
      open = true;
      root.hidden = false;
      root.dataset.open = '1';
      refresh();
    },
    close: () => {
      open = false;
      root.hidden = true;
      root.dataset.open = '0';
    },
    isOpen: () => open,
    refresh,
    dispose: () => {
      disposed = true;
      seq += 1;
      root.remove();
    },
  };

  closeBtn.addEventListener('click', () => panel.close());
  saveBtn.addEventListener('click', save);
  return panel;
}
