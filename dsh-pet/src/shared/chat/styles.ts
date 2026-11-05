/**
 * 对话弹窗的样式与尺寸参数：两端注入同一份 CSS。
 * 只放静态字符串与常量，不建 DOM、不读运行时状态。
 * @module dsh-pet/src/shared/chat/styles
 */

/** 弹窗样式。
 *  一条自适应输入框（无标题）+ 一行图标按钮（上传 / 截屏 / 按住说话）+ 可选的图片预览；
 *  初始 160px，随输入增宽、封顶 340px 后折行增高；回车发送，Esc 或点外关闭。
 *  宽度由 JS 按文本测量覆盖根元素宽度。 */
export const CHAT_CSS = [
  // z-index 略低于右键菜单（2147483000）：弹窗开着时右键宠物，菜单要能盖在它上面。
  '.dsh-pet-chat{position:fixed;z-index:2147482999;width:160px;max-width:80vw;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;',
  // 字体与桌宠气泡同款（上首软糖体，两端均已注入 @font-face），风格一致不显正式。
  // 字体族走全局配置变量 --dsh-pet-font-family：弹窗挂在 body 下、继承不到宠物根容器，由两端注入在 documentElement。
  // 字号保持固定 14px：配置里的 font.size 只作用于气泡与悬浮提示。
  "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
  'user-select:none}',
  '.dsh-pet-chat *{box-sizing:border-box}',
  '.dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;',
  'padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;',
  'resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}',
  '.dsh-pet-chat-input:disabled{opacity:.55}',
  // 操作行：记录 / 上传 / 截屏 / 按住说话，最右是关闭（撑开的空白由 spacer 占住）
  '.dsh-pet-chat-actions{display:flex;align-items:center;gap:6px;padding:0 8px 7px}',
  '.dsh-pet-chat-spacer{flex:1 1 auto;min-width:0}',
  // 关闭按钮：独立底色，悬停变红一点，别和「往消息里加东西」的动作混在一起
  '.dsh-pet-chat-btn[data-close="1"]{color:rgba(43,43,43,.5)}',
  '.dsh-pet-chat-btn[data-close="1"]:hover{background:rgba(229,72,77,.12);color:#d94f3d}',
  '.dsh-pet-chat-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
  'border:none;border-radius:6px;background:transparent;color:rgba(43,43,43,.62);font-size:14px;line-height:1;',
  'cursor:pointer;transition:background .15s,color .15s}',
  '.dsh-pet-chat-btn:hover{background:rgba(0,0,0,.06);color:rgba(43,43,43,.9)}',
  '.dsh-pet-chat-btn:disabled{opacity:.45;cursor:default}',
  '.dsh-pet-chat-btn svg{display:block}',
  // 话筒：录音中常亮红底 + 呼吸，告诉用户「正在听」。状态由 dom 写在 data-hear 上。
  '.dsh-pet-chat-btn[data-hear="recording"]{color:#e5484d;background:rgba(229,72,77,.14)}',
  '.dsh-pet-chat-btn[data-hear="recording"]:hover{background:rgba(229,72,77,.2);color:#e5484d}',
  '.dsh-pet-chat-btn[data-hear="recording"] svg{animation:dsh-pet-hear-pulse 1s ease-in-out infinite}',
  '@keyframes dsh-pet-hear-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
  // 已选图片：跟在两枚按钮右侧的一枚小图，不占额外一行
  '.dsh-pet-chat-attach{display:none;align-items:center;gap:4px;margin-left:2px}',
  '.dsh-pet-chat-attach[data-on="1"]{display:inline-flex}',
  '.dsh-pet-chat-thumb{width:24px;height:24px;object-fit:cover;border-radius:4px;',
  'border:1px solid rgba(0,0,0,.1);flex:0 0 auto;background:rgba(0,0,0,.06)}',
  '.dsh-pet-chat-attach-x{border:none;background:transparent;color:rgba(43,43,43,.45);cursor:pointer;',
  'font-size:12px;line-height:1;padding:2px 3px;border-radius:4px}',
  '.dsh-pet-chat-attach-x:hover{background:rgba(0,0,0,.08);color:rgba(43,43,43,.85)}',
  '.dsh-pet-chat-hint{display:none;color:rgba(43,43,43,.55);font-size:12px;padding:0 12px 8px}',
  '.dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}',
  // 对话记录面板：展开时占输入框上方一块，列表自己滚（最新在下方），头与脚不随列表滚。
  // 面板开着时弹窗至少 300px 宽——一行行气泡挤在 160px 里读起来太难受。
  '.dsh-pet-chat[data-log="1"]{min-width:min(300px,80vw)}',
  '.dsh-pet-chat-log{display:block;border-bottom:1px solid rgba(0,0,0,.08);',
  'background:rgba(0,0,0,.022);border-radius:10px 10px 0 0}',
  '.dsh-pet-chat-log[hidden]{display:none}',
  '.dsh-pet-chat-log-head{display:flex;align-items:center;gap:6px;padding:6px 8px 4px}',
  '.dsh-pet-chat-log-title{font-size:12px;font-weight:600;color:rgba(43,43,43,.8)}',
  '.dsh-pet-chat-log-count{font-size:11px;color:rgba(43,43,43,.45);margin-right:auto;',
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-chat-log-btn{border:none;background:transparent;color:rgba(43,43,43,.6);font-size:11px;',
  'line-height:1;padding:4px 6px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}',
  '.dsh-pet-chat-log-btn:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.9)}',
  '.dsh-pet-chat-log-btn:disabled{opacity:.45;cursor:default}',
  '.dsh-pet-chat-log-list{max-height:min(240px,45vh);overflow-y:auto;padding:2px 8px 8px;',
  'display:flex;flex-direction:column;gap:6px;user-select:text}',
  '.dsh-pet-chat-log-row{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:1.45;max-width:100%}',
  '.dsh-pet-chat-log-row[data-role="user"]{align-items:flex-end}',
  '.dsh-pet-chat-log-meta{font-size:10px;color:rgba(43,43,43,.4)}',
  '.dsh-pet-chat-log-text{padding:4px 7px;border-radius:8px;background:#fff;',
  'border:1px solid rgba(0,0,0,.07);white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}',
  '.dsh-pet-chat-log-row[data-role="user"] .dsh-pet-chat-log-text{background:#eef4ff;border-color:rgba(70,120,220,.18)}',
  '.dsh-pet-chat-log-tag{font-size:10px;color:rgba(43,43,43,.42)}',
  '.dsh-pet-chat-log-note{padding:0 8px 6px;font-size:10px;color:rgba(43,43,43,.5);',
  'overflow-wrap:anywhere;user-select:text}',
  '.dsh-pet-chat-log-note[data-err="1"]{color:#d94f3d}',
  '.dsh-pet-chat-log-empty{padding:10px 2px;font-size:12px;color:rgba(43,43,43,.4);text-align:center}',
  // 记录按钮开着时给个淡底，提示「这块是展开状态」
  '.dsh-pet-chat-btn[data-on="1"]{background:rgba(0,0,0,.07);color:rgba(43,43,43,.9)}',
].join('');

/** 输入框宽度自适应参数：初始小宽，随文本增宽，封顶后折行增高。 */
export const CHAT_MIN_W = 160;
export const CHAT_MAX_W = 340;
/** 输入框水平 padding 补偿（11×2） */
export const CHAT_H_PAD = 22;

let chatCssInjected = false;

/** 把弹窗样式注入文档一次；重复挂载不会重复插入。 */
export function injectChatCss(): void {
  if (chatCssInjected || typeof document === 'undefined') return;
  chatCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/chat';
  tag.textContent = CHAT_CSS;
  document.head.appendChild(tag);
}
