/**
 * 对话输入弹窗的挂载与生命周期：定位、关闭、发送。
 * 两端共用同一份实现；它只经注入的 baseUrl/surface 说话，不读配置、不读写记忆。
 * 回复的主展示路径仍是 /state 的 pets.<id>.say（气泡）；只有「指令」档会把这一轮的
 * 回复正文当场写进窗内的结果区——那一档要的正是「她做完了什么」。
 * @module dsh-pet/src/shared/chat/dialog
 */
import { ROUTE_PATH } from '../constants.ts';
import { createChatDom } from './dom.ts';
import { createCompositionWatch, decideEnter } from './enter.ts';
import type { EncodedImage } from './encode.ts';
import { createChatLog } from './log.ts';
import { placeBeside } from './place.ts';
import { sendChat, type ChatAttachment } from './send.ts';
import { injectChatCss } from './styles.ts';

/** 对话弹窗挂载句柄。 */
export interface ChatDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
  /** 开录：快捷键「按住说话」按下时用（麦克风已在录、环境不支持时无动作）。 */
  startHear: () => void;
  /** 收尾：快捷键松开时用（没在录时无动作）。 */
  stopHear: () => void;
  /** 此刻是否真的在采集。 */
  isHearing: () => boolean;
  /** 放进一张已编码的图（截图快捷键在弹窗已开时走这条）；返回是否收下。 */
  setEncoded: (encoded: EncodedImage) => boolean;
  /** 放进一张图片文件（粘贴、拖拽在弹窗已开时走这条）；类型不接受或编码失败时返回 false。 */
  setImageFile: (file: File) => Promise<boolean>;
  /** 在弹窗里显示一条临时提示（截图失败这类原因，超时自动收起）。 */
  flash: (text: string) => void;
}

/** 发送接线需要的元素与回调。 */
interface SendBinding {
  readonly input: HTMLTextAreaElement;
  readonly err: HTMLElement;
  /** 已含 `?pet=&surface=` 的对话地址。 */
  readonly url: string;
  readonly isClosed: () => boolean;
  /** 发送成功（弹窗尚未关闭）；`reply` 是这一轮她的回复正文（宿主没给正文时为 undefined）。 */
  readonly onOk: (reply?: string) => void;
  /** 待发送的图片；没有就发纯文本。 */
  readonly attachment: () => ChatAttachment | undefined;
  /** 是否还在压缩图片：是的话先提示，别发出去把图丢掉。 */
  readonly isEncoding: () => boolean;
  /** 非错误提示（"图片还在处理"这类）。 */
  readonly notify: (text: string) => void;
}

/** 点弹窗外或按 Esc 关闭；返回解绑函数。 */
function bindDismiss(root: HTMLElement, isClosed: () => boolean, onDismiss: () => void): () => void {
  const onPointerDown = (e: MouseEvent): void => {
    if (isClosed() || root.contains(e.target as Node)) return;
    onDismiss();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onDismiss();
  };
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

/** 回车发送：成功后回调、失败把原因写进 err 行，不伪造回复。 */
function bindSend(binding: SendBinding): void {
  let sending = false;
  const doSend = (): void => {
    if (binding.isClosed() || sending) return;
    if (binding.isEncoding()) {
      binding.notify('图片还在处理，稍等一下');
      return;
    }
    const text = binding.input.value.trim();
    if (!text) return;
    sending = true;
    binding.input.disabled = true;
    sendChat(binding.url, text, binding.attachment())
      .then((state) => {
        if (state.ok) binding.onOk(state.text);
        else {
          binding.err.textContent = '对话失败：' + (state.message ?? state.reason);
          binding.err.style.display = 'block';
        }
      })
      .catch((e) => {
        binding.err.textContent = '对话异常：' + String(e && e.message ? e.message : e);
        binding.err.style.display = 'block';
      })
      .finally(() => {
        sending = false;
        binding.input.disabled = false;
        if (!binding.isClosed()) binding.input.focus();
      });
  };
  // 回车要让开输入法：组合中的回车是上屏键，长按重复的回车只该被吞掉、不该插换行
  const ime = createCompositionWatch();
  binding.input.addEventListener('compositionstart', ime.start);
  binding.input.addEventListener('compositionend', () => ime.end(performance.now()));
  binding.input.addEventListener('keydown', (e) => {
    const action = decideEnter(e, ime, performance.now());
    if (action === 'ignore') return;
    e.preventDefault();
    if (action === 'send') doSend();
  });
}

/**
 * 由对话地址推导识别地址：两端传进来的都是 `.../chat`，去掉尾段换成 `/voice/hear`。
 *
 * @param baseUrl - 已含挂载前缀的对话地址。
 * @returns 同前缀下的识别地址。
 */
function hearUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/chat$/, '') + '/voice/hear';
}

/** 挂载对话弹窗的入参。 */
export interface ChatDialogOptions {
  petId: string;
  /** 端点基址：浏览器默认相对路径，桌面传绝对 URL（file:// 页面需要绝对）。 */
  baseUrl?: string;
  /** 这个弹窗开在哪一端：POST /chat 的 ?surface= 是必填的，宿主据此提前拒掉不可能的组合。 */
  surface: 'web' | 'desktop';
  x: number;
  y: number;
  /** 发送成功后调用（弹窗此时仍开着）：`chat` 档用来刷新记录，`cmd` 档用来把结果摆进窗里。 */
  onSent?: () => void;
  onClose?: () => void;
  /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口。 */
  clamp?: { x: number; y: number; w: number; h: number };
  /**
   * 宠物的矩形（视口局部坐标）。给了就按「宠物贴哪边、弹窗朝另一边长」摆，
   * 不会把宠物整个盖住；缺省退回 `x`/`y` 当左上角的旧行为。
   */
  anchor?: { x: number; y: number; w: number; h: number };
  /** 开哪一种窗：`chat` 带常驻记录、聊完留下继续聊；`cmd` 只发一条指令、结果留在窗里等她自己收。 */
  mode?: 'chat' | 'cmd';
  /** @deprecated 旧入口参数，仅用于推断档位：显式传 false 等于 `mode: 'cmd'`。 */
  logOpen?: boolean;
  /** 打开时就带着的图片（拖拽落到宠物身上走的这条）；缺省 = 空弹窗。 */
  initialImage?: File;
  /** 打开时就带着的已编码图片（截图快捷键走的这条：截屏没有 File，只有 base64）。 */
  initialEncoded?: EncodedImage;
  /** 截屏实现：浏览器传 getDisplayMedia 抓帧，桌面传 preload 的 IPC 调用；缺省 = 不支持。 */
  capture?: () => Promise<EncodedImage>;
  /**
   * 识别地址；缺省按 `baseUrl` 去掉尾部 `/chat` 推导（两端传进来的都是 `.../chat`）。
   * 给了也用不上时（环境不能录音）按钮不出现，见 createChatDom。
   */
  hearUrl?: string;
}

/** 挂载一个对话输入弹窗（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  顶栏是标题（「对话」/「指令」）+ 右上角关闭，下面一行图标按钮（上传 / 截屏 / 按住说话）与图片预览。
 *  档位由调用方决定（右键菜单两个独立入口）：`chat` 带记录、发完留下继续聊；
 *  `cmd` 发完不关窗，把她的回复写进窗内的结果区，等用户自己按 ✕ 收。
 *  Esc 或点弹窗外关闭；生成失败留在弹窗内显式提示。
 *  clamp 由调用方给：桌面传「窗口 ∩ 工作区」，宠物贴边时弹窗照样完整显示、窗口零移动。 */
export function mountChatDialog(opts: ChatDialogOptions): ChatDialogMount {
  injectChatCss();
  const { petId, surface, x, y, onSent, onClose, clamp } = opts;
  const baseUrl = opts.baseUrl ?? ROUTE_PATH + '/chat';
  // `surface` 必填（宿主校验）；这个 URL 只用于 POST 发送——GET 读记忆那条路不需要它
  const withPet = baseUrl + '?pet=' + encodeURIComponent(petId) + '&surface=' + surface;
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

  const dom = createChatDom({ capture: opts.capture, hearUrl: opts.hearUrl ?? hearUrlOf(baseUrl) });
  const { root, input, err } = dom;

  // 档位在开窗时就定死：右键菜单是「对话」「指令」两个独立入口，窗内不再切换。
  //  chat = 带记录、聊完还能接着聊；cmd = 只说一件事、结果当场摆在窗里，等她自己按 ✕ 收。
  const mode: 'chat' | 'cmd' = opts.mode ?? (opts.logOpen === false ? 'cmd' : 'chat');
  root.dataset.mode = mode;
  dom.title.textContent = mode === 'cmd' ? '指令' : '对话';
  if (mode === 'cmd') input.placeholder = '让她去做点什么…';

  // 对话记录：常驻在输入框上方，打开就能看见说过什么。只有「对话」档建它——
  // 「指令」窗要的是这一条指令的结果，历史列表只会把它挤下去。
  let log: ReturnType<typeof createChatLog> | undefined;
  if (mode === 'chat') {
    log = createChatLog({ petId, baseUrl });
    root.insertBefore(log.root, input);
    // 导出按钮住在顶栏：只在「对话」档露出来（它导出的正是下面这块记录）
    dom.exportBtn.hidden = false;
    dom.exportBtn.addEventListener('click', () => log?.save());
  }

  // 「指令」窗的结果区：发完不关窗，把她的回复当场写在这里，看得见就不用再回头翻记录。
  let result: HTMLDivElement | undefined;
  if (mode === 'cmd') {
    result = document.createElement('div');
    result.className = 'dsh-pet-chat-result';
    result.style.display = 'none';
    root.insertBefore(result, input);
  }

  /**
   * 落点：有 `anchor` 就按「宠物贴哪边、弹窗朝另一边长」摆（见 ./place.ts），
   * 否则保持旧行为——以 (x,y) 为左上角、超出 clamp 夹回。
   */
  const place = (): void => {
    const r = root.getBoundingClientRect();
    if (opts.anchor && opts.anchor.w > 0 && opts.anchor.h > 0) {
      const at = placeBeside(opts.anchor, { w: r.width, h: r.height }, c);
      root.style.left = at.x + 'px';
      root.style.top = at.y + 'px';
      root.dataset.side = at.side;
      return;
    }
    root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - r.width - 4)) + 'px';
    root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - r.height - 4)) + 'px';
  };

  let closed = false;
  let unbindDismiss = (): void => {};
  // 记录面板的列表是异步填进来的：内容一到位弹窗就长高，得跟着重新落点，否则底部会被屏幕裁掉。
  const ro = new ResizeObserver(() => {
    if (!closed) place();
  });
  ro.observe(root);
  const close = (): void => {
    if (closed) return;
    closed = true;
    ro.disconnect();
    unbindDismiss();
    log?.dispose();
    dom.dispose();
    dom.clearAttach();
    root.remove();
    if (onClose) onClose();
  };
  unbindDismiss = bindDismiss(root, () => closed, close);
  // 关闭按钮：桌面窗口是透明+穿透的，点弹窗外那一下到不了 DOM；这颗按钮在哪一端都关得掉。
  dom.closeBtn.addEventListener('click', close);
  bindSend({
    input,
    err,
    url: withPet,
    isClosed: () => closed,
    onOk: (reply) => {
      if (mode === 'cmd') {
        // 指令：**不关窗**。她做完的事要当场看得见，看完自己按 ✕ 收。
        if (result) {
          result.textContent = reply ?? '做完了，没留话。';
          result.dataset.thinking = '0';
          result.style.display = 'block';
        }
        input.value = '';
        dom.clearAttach();
        dom.resizeInput();
        place();
        input.focus();
      } else {
        // 对话：留下并刷新记录——「边聊边看」正是这一档存在的理由，关窗交给右上角 ✕ / Esc。
        input.value = '';
        dom.clearAttach();
        log?.refresh();
        dom.resizeInput();
        place();
        input.focus();
      }
      if (onSent) onSent();
    },
    attachment: () => dom.getAttachment(),
    isEncoding: () => dom.isEncoding(),
    notify: (text) => dom.flash(text),
  });
  // 截屏按钮的接线在 dom 里（依赖注入的 capture），这里只负责发送与关闭

  dom.resizeInput(); // append 后再量一次（此时样式已生效）
  // 记录先拉一次（异步填列表，ResizeObserver 会跟着重新落点）
  log?.refresh();
  place();
  if (opts.initialImage) void dom.setImageFile(opts.initialImage);
  if (opts.initialEncoded) dom.setEncoded(opts.initialEncoded);
  input.focus();
  return {
    el: root,
    close,
    startHear: dom.startHear,
    stopHear: dom.stopHear,
    isHearing: dom.isHearing,
    setEncoded: dom.setEncoded,
    setImageFile: dom.setImageFile,
    flash: dom.flash,
  };
}
