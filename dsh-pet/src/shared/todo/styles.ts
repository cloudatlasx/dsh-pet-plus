/**
 * 待办面板的样式：面板本体是气泡槽里的一个气泡，外框沿用气泡的白底圆角与尾巴。
 *
 * 只有静态字符串与注入状态，不建 DOM、不读配置；尺寸全部锚在气泡字号 --f 上，
 * 因此 config.font 的字号与 followPet、以及宠物尺寸改了，面板跟着等比缩放。
 * 高度预算 TODO_PANEL_METRICS 与这里的系数同源：改任何一条都必须同步，否则桌面窗口上边距会算少。
 * @module dsh-pet/src/shared/todo/styles
 */
import { BUBBLE_OVERLAP_RATIO, resolveFontPx } from '../fonts.ts';
import type { FontConfig } from '../types.ts';

/** 面板根字号相对气泡字号的比例：默认配置（气泡 21.02px）下取整为 13px。 */
export const TODO_FONT_SCALE = 0.618;

/** 面板竖向预算（em，基准 = 面板根字号）：头部 + 表单 + 下半区，默认配置下约 329px。 */
export const TODO_PANEL_METRICS = {
  /** 头部：上下内边距 + 标题行（行高 1.5 × 字号 1.077）。 */
  head: 0.769 + 0.615 + 1.077 * 1.5,
  /** 表单：正文框 + 间距 + 时间行 + 下内边距。 */
  form: 0.462 * 2 + 1.4 + 0.462 + (0.462 * 2 + 1.4) + 0.769,
  /** 清单态：上下内边距 + 两行条目（每行 = 内边距 + 正文 + 行距 + 时间标签）。 */
  list: 0.462 * 2 + 2 * (0.538 * 2 + 1.5 + 0.154 + 0.846 * 1.5),
  /** 底部提示。 */
  hint: 0.462 + 0.692 + 0.846 * 1.5,
  /** 日历态：内边距 + 一句话输入行 + 标题行 + 星期行 + 六行日期 + 底部操作行 + 行间空隙。 */
  calendar:
    1.077 +
    1.077 * 1.5 +
    0.846 * 1.5 +
    6 * (1.4 + 0.231 * 2) +
    5 * 0.154 +
    (0.923 * 1.5 + 0.462) +
    // 一句话说时间：输入框（行高 + 内边距 + 上下边框）与它后面那道 gap。
    (0.923 * 1.4 + 0.231 * 2 + 0.154) +
    0.308 * 4,
} as const;

/** 面板样式：头部 + 添加行 + 可滚动的清单 + 底部提示。 */
export const TODO_CSS = [
  // 气泡变体：两端气泡的基础类不同（网页 .dsh-pet-bubble / 桌面 .pet-bubble），所以并列两条提高特异性，
  // 不依赖注入顺序压过基础样式。宽度锚 --f（14.65 × 21.02 ≈ 308px），max() 给 220px 下限防止
  // 小字号下输入框与按钮挤成一列，max-width 再把整体夹回视口。
  '.dsh-pet-bubble.dsh-pet-todo-bubble,.pet-bubble.dsh-pet-todo-bubble{padding:0;',
  'width:max(220px,calc(var(--f)*14.65));max-width:calc(100vw - 16px);pointer-events:auto;cursor:default}',
  // 面板本体：只负责竖向排布，外框（底色/圆角/阴影/尾巴）全部交给气泡，圆角用 inherit 对齐。
  // 尺寸一律 em，基准是本行的 --t；自己改了 font-size 的元素内边距改用 calc(var(--t)*k)，
  // 否则 em 会按它自己的字号再缩一遍。
  '.dsh-pet-todo{--t:calc(var(--f)*' + TODO_FONT_SCALE + ');display:flex;flex-direction:column;',
  'box-sizing:border-box;border-radius:inherit;overflow:hidden;color:#2b2b2b;font-size:var(--t);',
  'line-height:1.5;user-select:none;',
  "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
  '}',
  '.dsh-pet-todo *{box-sizing:border-box}',
  '.dsh-pet-todo-head{display:flex;align-items:center;gap:.615em;padding:.769em .923em .615em}',
  '.dsh-pet-todo-title{flex:1;font-size:1.077em;font-weight:600}',
  '.dsh-pet-todo-count{color:rgba(43,43,43,.55);font-size:.923em}',
  '.dsh-pet-todo-close{border:none;background:transparent;color:rgba(43,43,43,.5);font-family:inherit;',
  'font-size:1em;line-height:1;padding:.308em .385em;border-radius:.462em;cursor:pointer}',
  '.dsh-pet-todo-close:hover{background:rgba(0,0,0,.06);color:rgba(43,43,43,.9)}',
  '.dsh-pet-todo-form{display:flex;flex-direction:column;gap:.462em;padding:0 .923em .769em;',
  'border-bottom:1px solid rgba(0,0,0,.07)}',
  '.dsh-pet-todo-input{width:100%;border:1px solid rgba(0,0,0,.12);border-radius:.615em;',
  'background:rgba(255,255,255,.9);padding:.462em .615em;font-size:1em;line-height:1.4;color:#2b2b2b;',
  'font-family:inherit;outline:none}',
  '.dsh-pet-todo-input:focus{border-color:rgba(64,128,255,.55);box-shadow:0 0 0 .154em rgba(64,128,255,.14)}',
  '.dsh-pet-todo-input::placeholder{color:rgba(43,43,43,.42)}',
  '.dsh-pet-todo-input:disabled{opacity:.55;cursor:default}',
  // 下半区只有清单一块：时间写在同一句话里，面板不再有日历态。
  // 折叠用 grid-template-rows 的 0fr→1fr：内容高度是 auto 也能过渡，不用猜 max-height。
  '.dsh-pet-todo-lower{display:flex;flex-direction:column}',
  '.dsh-pet-todo-fold{display:grid;grid-template-rows:0fr;visibility:hidden;',
  'transition:grid-template-rows .18s ease,visibility 0s .18s}',
  '.dsh-pet-todo-fold>.dsh-pet-todo-foldClip{overflow:hidden;min-height:0}',
  '.dsh-pet-todo-fold.is-list{grid-template-rows:1fr;visibility:visible;transition-delay:0s}',
  // 清单高度由 capListHeight 按两行写在行内；这里只保证超出就滚动、滚动不带动气泡外的东西。
  '.dsh-pet-todo-list{list-style:none;margin:0;padding:.462em;overflow-y:auto;overscroll-behavior:contain;',
  'flex:0 1 auto;min-height:0;scrollbar-width:thin}',
  '.dsh-pet-todo-item{display:flex;align-items:flex-start;gap:.615em;padding:.538em .462em;border-radius:.615em}',
  '.dsh-pet-todo-item:hover{background:rgba(0,0,0,.045)}',
  '.dsh-pet-todo-check{margin-top:.231em;width:1.154em;height:1.154em;flex:0 0 auto;cursor:pointer;',
  'accent-color:#4a7dff}',
  '.dsh-pet-todo-main{flex:1;min-width:0}',
  '.dsh-pet-todo-text{overflow-wrap:anywhere;white-space:pre-wrap}',
  '.dsh-pet-todo-meta{margin-top:calc(var(--t)*0.154);font-size:.846em;color:rgba(43,43,43,.5)}',
  '.dsh-pet-todo-item[data-urgency="overdue"] .dsh-pet-todo-meta{color:#d94f3d}',
  '.dsh-pet-todo-item[data-urgency="soon"] .dsh-pet-todo-meta{color:#c9761b}',
  '.dsh-pet-todo-item[data-urgency="today"] .dsh-pet-todo-meta{color:#3f6fd8}',
  '.dsh-pet-todo-item.is-done .dsh-pet-todo-text{text-decoration:line-through;color:#2e9e4f}',
  '.dsh-pet-todo-del{border:none;background:transparent;color:rgba(43,43,43,.34);font-size:.923em;line-height:1;',
  'padding:calc(var(--t)*0.308) calc(var(--t)*0.385);border-radius:.462em;cursor:pointer;flex:0 0 auto;',
  'min-width:calc(var(--t)*1.692)}',
  '.dsh-pet-todo-del:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.8)}',
  '.dsh-pet-todo-del.is-armed{background:rgba(217,79,61,.12);color:#d94f3d}',
  '.dsh-pet-todo-empty{padding:calc(var(--t)*1.538) calc(var(--t)*0.923);text-align:center;',
  'color:rgba(43,43,43,.44);font-size:.923em}',
  '.dsh-pet-todo-empty[hidden]{display:none}',
  '.dsh-pet-todo-err{flex:0 0 auto;padding:0 calc(var(--t)*0.923) calc(var(--t)*0.615);color:#d94f3d;',
  'font-size:.923em;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-todo-err[hidden]{display:none}',
  // margin-top:auto 把提示钉在下半区底部：清单只有两行时，多出来的空当留在中间而不是堆在提示下面。
  '.dsh-pet-todo-hint{margin-top:auto;padding:calc(var(--t)*0.462) calc(var(--t)*0.923) calc(var(--t)*0.692);',
  'color:rgba(43,43,43,.4);font-size:.846em;text-align:center}',
].join('');

let todoCssInjected = false;

/** 把面板样式注入文档一次；重复挂载不会重复插入。 */
export function injectTodoCss(): void {
  if (todoCssInjected || typeof document === 'undefined') return;
  todoCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/todo';
  tag.textContent = TODO_CSS;
  document.head.appendChild(tag);
}

/** 面板占用的窗口上边距（px）：桌面窗口余量必须容得下整块面板，否则面板顶端被窗口上沿切掉。
 *  算法与 {@link bubbleTopMarginPx} 同口径：面板底边同样落在宠物盒顶边下方 0.108 × 尺寸处。
 *  面板高度是常量（下半区固定），所以展开日历或出现错误行都不会改变窗口尺寸。
 *  @param font - 该宠物的 font 配置，缺失按默认口径。
 *  @param size - 该宠物的宽度 px。 */
export function todoPanelTopMarginPx(font: FontConfig | undefined, size: number): number {
  const m = TODO_PANEL_METRICS;
  // 窗口余量按较高的那种状态算：面板高度会随状态变，但窗口尺寸不能跟着变。
  const panelPx =
    (m.head + m.form + Math.max(m.list + m.hint, m.calendar)) * resolveFontPx(font, size).bubble * TODO_FONT_SCALE;
  const overlap = (Number(size) || 0) * BUBBLE_OVERLAP_RATIO;
  return Math.max(0, Math.ceil(panelPx - overlap));
}
