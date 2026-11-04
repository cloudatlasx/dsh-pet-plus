/**
 * 浏览器半侧的余额与碎碎念气泡：哑组件，只把 shared 的行数据或节点树映射成 React 节点。
 * 不发起请求，显隐与停留时长由 pet.ts 控制。
 * 依赖运行时注入的 react 与 shared 的 balance / whisper 视图。
 * 必须始终成立：样式与桌面端同源，文案与档位由 shared 计算。
 * @module dsh-pet/src/client/bubble
 */
import {
  balancePageView,
  customClickable,
  customViews,
  type BalanceBubbleRow,
  type BalanceState,
  type CustomNode,
} from '../shared/balance/index.ts';
import {
  MEME_BUBBLE_CLASS,
  MEME_IMG_CLASS,
  injectMemeBubbleCss,
  memeImageUrl,
  whisperBubbleView,
} from '../shared/whisper.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import { ROUTE_PATH } from '../shared/constants.ts';

/** 气泡内联样式：白色半透明圆泡加底部小尾巴，盒子尺寸锚字号 `--f`，位置锚宠物尺寸。
 *  width:max-content 不可省：left:50% 的绝对定位盒可用宽度只有包含块一半，shrink-to-fit
 *  会先被卡死；先按内容取宽，再由 max-width 收口。box-sizing 钉死 content-box，避免宿主
 *  全局 border-box 把内边距算进宽度；断词用 break-word，数字与单位不会被拆行。
 */
const bubbleCss = [
  // 本地字体：由 host 从 assets/fonts 提供；font-display:swap 先回退后切换。
  `@font-face{font-family:"ShangshouSoftCandy";src:url("${ROUTE_PATH}/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}`,
  '.dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' +
    // 宽度下限只到「放得下尾巴三角 + 一点内边距」：早先给到 5.7143em（380px 的宠物约 99px），
    // 于是「好的」这类两三个字的气泡也被撑成同一条长条，用户报「文字没那么长，泡泡还是挺长的」。
    // 现在下限压到 2em，宽度完全由内容决定，长文本仍由 max-width 收口换行。
    'width:max-content;min-width:calc(var(--f)*2);max-width:min(calc(var(--f)*19),100%);' +
    // 钉死 content-box：宿主可能全局设了 border-box，让 min/max-width 把内边距算进去，
    // 表现为「明明还有空位却折行」；桌面端同样钉死，两端一致。
    'box-sizing:content-box;' +
    'padding:calc(var(--f)*0.75) calc(var(--f)*0.8);' +
    'border-radius:calc(var(--f)*0.75);' +
    // 不透明的实色底 + 1px 描边：气泡属于内容层，毛玻璃在这层只会糊住自己的字。
    'background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);' +
    '--f0:var(--dsh-pet-font-bubble,calc(var(--dsh-pet-size)*0.0455));--f:var(--f0);' +
    'color:#18181b;font-family:var(--dsh-pet-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif);' +
    'font-size:var(--f);line-height:1.55;font-variant-numeric:tabular-nums;z-index:3;pointer-events:none;' +
    // 双层阴影：贴边那层给轮廓清晰度，远投影给层级；单层大模糊会显得脏。
    'box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 24px -8px rgba(0,0,0,.24);' +
    'opacity:0;transition:opacity .14s ease;' +
    'white-space:normal;overflow-wrap:break-word}',
  // 底部尾巴：小三角指向下方宠物，尺寸锚字号。
  '.dsh-pet-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--f)*-0.3736);' +
    'transform:translateX(-50%);border:calc(var(--f)*0.3736) solid transparent;' +
    'border-top-color:rgba(255,255,255,.97);border-bottom:none}',
  // 入场 180ms：位移 8px + 缩到 .96，缓动用 M3 的 emphasized decelerate。
  '@keyframes dsh-pet-bubble-in{from{opacity:0;transform:translateY(calc(var(--f)*0.5)) scale(.96)}' +
    'to{opacity:1;transform:none}}',
  '.dsh-pet-bubble.is-on{opacity:1;animation:dsh-pet-bubble-in .18s cubic-bezier(.05,.7,.1,1) both}',
  // 深色：底色 96% 的近黑，文字不用纯白（减眩光），描边换成白色低透明度。
  '@media (prefers-color-scheme:dark){' +
    '.dsh-pet-bubble{background:rgba(28,28,30,.96);border-color:rgba(255,255,255,.10);color:#f4f4f5;' +
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 10px 24px -8px rgba(0,0,0,.6)}' +
    '.dsh-pet-bubble::after{border-top-color:rgba(28,28,30,.96)}}',
  // 用户要求减少动效时只留淡入，不做位移与缩放。
  '@media (prefers-reduced-motion:reduce){.dsh-pet-bubble.is-on{animation:dsh-pet-bubble-in .12s linear both}}',
  // 碎碎念变体：字号缩到余额气泡的 0.75，宽度下限更窄，上限与折行规则相同。
  // 字号缩到 0.75 后内边距也跟着缩，宽度下限只需留住尾巴；上限仍按内容收口。
  '.dsh-pet-bubble.dsh-pet-whisper{font-size:calc(var(--f)*0.7473);' +
    'min-width:calc(var(--f)*1.6);max-width:min(calc(var(--f)*10.989),100%)}',
  // 工作气泡的第二行（第 N 步 · 已用 X 分钟）：小一号、灰一点，不跟正文抢注意力。
  '.dsh-pet-whisper__meta{display:block;margin-top:calc(var(--f)*0.14);font-size:calc(var(--f)*0.58);' +
    'line-height:1.3;color:rgba(43,43,43,.55);font-variant-numeric:tabular-nums}',
  // 清单进度条：细条 + 右侧「4/7 项」。条子只表达「队列走了多少」，不表示「这轮快完了」。
  '.dsh-pet-whisper__progress{display:flex;align-items:center;gap:calc(var(--f)*0.4);' +
    'margin-top:calc(var(--f)*0.3)}',
  '.dsh-pet-whisper__track{flex:1 1 auto;height:calc(var(--f)*0.3);border-radius:calc(var(--f)*0.15);' +
    'background:rgba(43,43,43,.12);overflow:hidden}',
  '.dsh-pet-whisper__fill{display:block;height:100%;border-radius:inherit;background:#2e9e4f;' +
    'transition:width .3s cubic-bezier(.05,.7,.1,1)}',
  '.dsh-pet-whisper__pct{flex:none;font-size:calc(var(--f)*0.56);line-height:1;color:rgba(43,43,43,.5);' +
    'font-variant-numeric:tabular-nums}',
  // 配图样式在 shared 的 MEME_BUBBLE_CSS，这里只保留标题与行样式。
  '.dsh-pet-bubble .pet-bub-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6);margin-bottom:calc(var(--f)*0.1978)}',
  '.dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593);flex-wrap:wrap}',
  // 档位行由多个片段拼成：只在片段之间换行，片段内部不拆字，避免竖排。
  '.dsh-pet-bubble .pet-bub-row>span{white-space:nowrap}',
  '.dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--f)*0.7692)}',
  '.dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--f)*0.2857);font-size:calc(var(--f)*0.4835);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--f)*0.2857);padding:0 calc(var(--f)*0.1978);vertical-align:1px}',
  // 峰/谷计价档位：峰红、谷绿。
  '.dsh-pet-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}',
  // 展开态：每个窗口一行，进度条长度等于已用百分比。
  // 气泡默认不挡宿主页面，只有可展开的余额气泡才开命中。
  '.dsh-pet-bubble.is-clickable{pointer-events:auto;cursor:pointer}',
  // 收起态排不下「窗口名 + 条 + 百分比 + 重置」四列，展开态单独加宽并缩到 60% 字号。
  '.dsh-pet-bubble.is-expanded{--f:calc(var(--f0)*0.6);width:min(calc(var(--f)*21),100%);max-width:100%}',
  // 淡出：换内容前先透明，换完去掉这个类再淡入。
  '.dsh-pet-bubble.is-on.is-fading{opacity:0}',
  '.dsh-pet-bubble .pet-bub-quota{display:flex;align-items:center;gap:calc(var(--f)*0.4);margin:calc(var(--f)*0.13) 0}',
  '.dsh-pet-bubble .pet-bub-quota-label{flex:none;min-width:calc(var(--f)*1.9);font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-quota-bar{flex:1 1 auto;height:calc(var(--f)*0.5);border-radius:calc(var(--f)*0.25);background:rgba(43,43,43,.12);overflow:hidden}',
  '.dsh-pet-bubble .pet-bub-quota-fill{display:block;height:100%;border-radius:inherit;background:#2e9e4f}',
  '.dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-warn{background:#e8952f}',
  '.dsh-pet-bubble .pet-bub-quota-fill.pet-bub-quota-crit{background:#e53935}',
  '.dsh-pet-bubble .pet-bub-quota-used{flex:none;min-width:calc(var(--f)*2.2);text-align:right;font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-quota-reset{flex:none;min-width:calc(var(--f)*2.6);text-align:right;font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  // 用量页（第三页）：三行两列占满展开态宽度，总量是唯一的大字。
  // 配色只给进/出两处强调，其余沿用次级灰——同页里超过两种彩色会盖过数值本身。
  '.dsh-pet-bubble .pet-bub-usage{display:flex;flex-direction:column;gap:calc(var(--f)*0.22);margin:calc(var(--f)*0.1) 0}',
  '.dsh-pet-bubble .pet-bub-usage-line{display:flex;align-items:baseline;justify-content:space-between;gap:calc(var(--f)*0.8);line-height:1.45}',
  '.dsh-pet-bubble .pet-bub-usage-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}',
  '.dsh-pet-bubble .pet-bub-usage-total{font-size:calc(var(--f)*1.45);line-height:1.2;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-usage-in{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#3f6ea8}',
  '.dsh-pet-bubble .pet-bub-usage-out{font-size:calc(var(--f)*0.7692);font-variant-numeric:tabular-nums;color:#b4703c}',
  '.dsh-pet-bubble .pet-bub-usage-period{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.62)}',
  '.dsh-pet-bubble .pet-bub-usage-spend{font-size:calc(var(--f)*0.7692);font-weight:650;font-variant-numeric:tabular-nums;color:#1f1f1f}',
  // 进出比例条：两段按真实占比分宽，颜色与下面的数字一一对应；占比极小时只留一条细线，不放大。
  '.dsh-pet-bubble .pet-bub-usage-bar{display:flex;height:calc(var(--f)*0.3);border-radius:calc(var(--f)*0.15);overflow:hidden;background:rgba(43,43,43,.1);margin:calc(var(--f)*0.05) 0}',
  '.dsh-pet-bubble .pet-bub-usage-bar-in{display:block;height:100%;background:#3f6ea8}',
  '.dsh-pet-bubble .pet-bub-usage-bar-out{display:block;height:100%;background:#b4703c}',
  // ===== 交互请求（审批 / 提问）与定时提醒 =====
  // 结构：徽标 + 工具名 / 正文 / 按钮行；提问额外有可滚动的题目区。
  '.dsh-pet-bubble.dsh-pet-request{display:flex;flex-direction:column;gap:calc(var(--f)*0.36)}',
  '.dsh-pet-bubble.dsh-pet-request.is-question{max-height:min(calc(var(--f)*15),46vh);overflow-y:auto;overscroll-behavior:contain}',
  '.dsh-pet-request__head{display:flex;align-items:center;gap:calc(var(--f)*0.35);min-width:0}',
  '.dsh-pet-request__badge{flex:none;font-size:calc(var(--f)*0.58);font-weight:700;color:#fff;background:#e8952f;' +
    'border-radius:calc(var(--f)*0.3);padding:calc(var(--f)*0.06) calc(var(--f)*0.34);letter-spacing:.02em}',
  '.dsh-pet-request__badge.is-reminder{background:#3f6ea8}',
  '.dsh-pet-request__badge.is-announce{background:#2e9e4f}',
  '.dsh-pet-request__tool{font-size:calc(var(--f)*0.64);color:rgba(43,43,43,.62);overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
  // 正文限高滚动：方案全文、报错堆栈这类长内容不再被截成一句，而是整段可读、可滚。
  '.dsh-pet-request__body{font-size:calc(var(--f)*0.7);line-height:1.45;color:#2b2b2b;word-break:break-word;' +
    'max-height:min(calc(var(--f)*5.5),30vh);overflow-y:auto;overscroll-behavior:contain;white-space:pre-wrap}',
  '.dsh-pet-reminder__title{font-size:calc(var(--f)*0.82);line-height:1.35;font-weight:700;color:#1f1f1f;word-break:break-word}',
  // 分条明细：一条一行，整体限高滚动。用 list 样式让「今天要做的事」一眼能数过来。
  '.dsh-pet-reminder__lines{display:flex;flex-direction:column;gap:calc(var(--f)*0.2);' +
    'max-height:min(calc(var(--f)*8),40vh);overflow-y:auto;overscroll-behavior:contain}',
  '.dsh-pet-reminder__line{font-size:calc(var(--f)*0.68);line-height:1.45;color:#2b2b2b;word-break:break-word;' +
    'padding-left:calc(var(--f)*0.7);text-indent:calc(var(--f)*-0.7)}',
  '.dsh-pet-reminder__line::before{content:"·";margin-right:calc(var(--f)*0.3);color:#3f6ea8;font-weight:700}',
  '.dsh-pet-reminder__hint{font-size:calc(var(--f)*0.62);line-height:1.4;color:rgba(43,43,43,.55);word-break:break-word}',
  // 快捷动作：一排「能做的事」，点一下就把话投回会话——宠物不只是播报，是入口。
  '.dsh-pet-reminder__quick{display:flex;gap:calc(var(--f)*0.26);flex-wrap:wrap;align-items:center}',
  '.dsh-pet-reminder__chip{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.66);line-height:1.2;' +
    'padding:calc(var(--f)*0.24) calc(var(--f)*0.52);border-radius:calc(var(--f)*0.9);cursor:pointer;' +
    'border:1px solid rgba(63,110,168,.42);background:rgba(63,110,168,.08);color:#2f5687;font-weight:600;' +
    'transition:background .12s ease,border-color .12s ease}',
  '.dsh-pet-reminder__chip:hover{background:rgba(63,110,168,.16);border-color:rgba(63,110,168,.62)}',
  '.dsh-pet-reminder__chip:disabled{opacity:.55;cursor:default}',
  '.dsh-pet-reminder__chip.is-busy{background:rgba(63,110,168,.2);border-color:rgba(63,110,168,.7)}',
  // 自由输入：不想点芯片就直接说一句，回车即发。
  '.dsh-pet-reminder__reply{display:flex;gap:calc(var(--f)*0.26);align-items:center}',
  '.dsh-pet-reminder__reply>.dsh-pet-request__input{flex:1 1 auto;min-width:0}',
  '.dsh-pet-request__actions{display:flex;gap:calc(var(--f)*0.3);flex-wrap:wrap;align-items:center}',
  '.dsh-pet-request__btn{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.68);line-height:1.2;' +
    'min-height:calc(var(--f)*2);padding:0 calc(var(--f)*0.8);border-radius:calc(var(--f)*0.4);cursor:pointer;' +
    'border:1px solid rgba(0,0,0,.12);background:rgba(0,0,0,.03);color:#18181b;font-weight:500}',
  '.dsh-pet-request__btn:hover{background:rgba(0,0,0,.06)}',
  '.dsh-pet-request__btn:hover{background:rgba(43,43,43,.05)}',
  '.dsh-pet-request__btn.is-primary{background:#2e9e4f;border-color:#2e9e4f;color:#fff;font-weight:650}',
  '.dsh-pet-request__btn.is-primary:hover{background:#278a44}',
  '.dsh-pet-request__btn.is-primary:disabled{background:rgba(43,43,43,.14);border-color:transparent;' +
    'color:rgba(43,43,43,.45);cursor:default}',
  '.dsh-pet-request__btn.is-ghost{border-color:transparent;background:transparent;color:rgba(43,43,43,.55);' +
    'font-size:calc(var(--f)*0.6);padding-left:calc(var(--f)*0.24);padding-right:calc(var(--f)*0.24)}',
  '.dsh-pet-request__question{display:flex;flex-direction:column;gap:calc(var(--f)*0.24);' +
    'padding-top:calc(var(--f)*0.22);border-top:1px solid rgba(43,43,43,.1)}',
  '.dsh-pet-request__question:first-child{border-top:none;padding-top:0}',
  '.dsh-pet-request__title{font-size:calc(var(--f)*0.72);line-height:1.4;font-weight:650;color:#1f1f1f;word-break:break-word}',
  '.dsh-pet-request__detail{font-size:calc(var(--f)*0.62);line-height:1.4;color:rgba(43,43,43,.6);' +
    'max-height:calc(var(--f)*3.2);overflow-y:auto;white-space:pre-wrap;word-break:break-word}',
  '.dsh-pet-request__options{display:flex;flex-wrap:wrap;gap:calc(var(--f)*0.24)}',
  '.dsh-pet-request__opt{appearance:none;font-family:inherit;font-size:calc(var(--f)*0.66);line-height:1.2;' +
    'padding:calc(var(--f)*0.18) calc(var(--f)*0.42);border-radius:calc(var(--f)*0.32);cursor:pointer;' +
    'border:1px solid rgba(43,43,43,.18);background:rgba(43,43,43,.03);color:#2b2b2b;max-width:100%;' +
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-pet-request__opt.is-picked{background:#e8f3eb;border-color:#2e9e4f;color:#1d6b36;font-weight:650}',
  '.dsh-pet-request__input{flex:1 1 calc(var(--f)*5);min-width:calc(var(--f)*4);font-family:inherit;' +
    'font-size:calc(var(--f)*0.66);padding:calc(var(--f)*0.16) calc(var(--f)*0.3);' +
    'border-radius:calc(var(--f)*0.3);border:1px solid rgba(43,43,43,.18);background:#fff;color:#2b2b2b}',
  '.dsh-pet-request__input:focus{outline:none;border-color:#2e9e4f}',
  // ── 折叠台账 ────────────────────────────────────────────────────────────────
  // 面板比普通气泡宽一点（放得下「时间 · 标题 · 摘要」三件事），高度封顶后内部滚动。
  '.dsh-pet-bubble.dsh-pet-history{display:flex;flex-direction:column;gap:calc(var(--f)*0.4);' +
    'max-width:min(calc(var(--f)*21),100%);pointer-events:auto}',
  '.dsh-pet-history__head{justify-content:space-between;align-items:center;flex-wrap:nowrap}',
  '.dsh-pet-request__badge.is-history{background:#5b6472}',
  // 列表：条目多时在这里滚，头部与底栏固定不动，滚到底也不会把「清空」滚丢。
  '.dsh-pet-history__list{display:flex;flex-direction:column;gap:1px;' +
    'max-height:min(calc(var(--f)*13),46vh);overflow-y:auto;overscroll-behavior:contain;' +
    'border-top:1px solid rgba(0,0,0,.06);border-bottom:1px solid rgba(0,0,0,.06)}',
  '.dsh-pet-history__row{display:flex;gap:calc(var(--f)*0.5);align-items:baseline;' +
    'min-height:calc(var(--f)*1.9);padding:calc(var(--f)*0.24) calc(var(--f)*0.1);text-align:left}',
  '.dsh-pet-history__row.is-clickable{cursor:pointer;border-radius:calc(var(--f)*0.3)}',
  '.dsh-pet-history__row.is-clickable:hover{background:rgba(37,99,235,.07)}',
  '.dsh-pet-history__time{flex:none;font-size:calc(var(--f)*0.58);color:rgba(0,0,0,.45);' +
    'font-variant-numeric:tabular-nums}',
  '.dsh-pet-history__body{display:flex;flex-direction:column;gap:calc(var(--f)*0.06);min-width:0}',
  '.dsh-pet-history__title{font-size:calc(var(--f)*0.72);line-height:1.35;font-weight:550;color:#18181b;' +
    'overflow-wrap:break-word}',
  '.dsh-pet-history__sum{font-size:calc(var(--f)*0.6);line-height:1.35;color:rgba(0,0,0,.5);' +
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-pet-history__empty{font-size:calc(var(--f)*0.66);line-height:1.5;color:rgba(0,0,0,.5);' +
    'padding:calc(var(--f)*0.3) 0}',
  '.dsh-pet-history__foot{align-items:center;flex-wrap:nowrap}',
  '.dsh-pet-history__note{font-size:calc(var(--f)*0.56);color:rgba(0,0,0,.4);line-height:1.3}',
  '@media (prefers-color-scheme:dark){' +
    '.dsh-pet-history__list{border-color:rgba(255,255,255,.08)}' +
    '.dsh-pet-history__title{color:#f4f4f5}' +
    '.dsh-pet-history__sum,.dsh-pet-history__empty{color:rgba(255,255,255,.55)}' +
    '.dsh-pet-history__time,.dsh-pet-history__note{color:rgba(255,255,255,.42)}' +
    '.dsh-pet-history__row.is-clickable:hover{background:rgba(124,176,255,.14)}' +
    // 正文类颜色此前是给浅色底写死的深色字，深色底上会糊成一片——这里统一按底色重设。
    '.dsh-pet-whisper__meta{color:rgba(255,255,255,.55)}' +
    '.dsh-pet-whisper__track{background:rgba(255,255,255,.16)}' +
    '.dsh-pet-whisper__fill{background:#4ade80}' +
    '.dsh-pet-whisper__pct{color:rgba(255,255,255,.55)}' +
    '.dsh-pet-bubble .pet-bub-title,.dsh-pet-bubble .pet-bub-sub,.dsh-pet-bubble .pet-bub-quota-label,' +
    '.dsh-pet-bubble .pet-bub-quota-reset,.dsh-pet-bubble .pet-bub-usage-title,' +
    '.dsh-pet-bubble .pet-bub-usage-period{color:rgba(255,255,255,.6)}' +
    '.dsh-pet-bubble .pet-bub-val,.dsh-pet-bubble .pet-bub-quota-used,' +
    '.dsh-pet-bubble .pet-bub-usage-total,.dsh-pet-bubble .pet-bub-usage-spend{color:#f4f4f5}' +
    '.dsh-pet-bubble .pet-bub-err{color:#ff8b7a}' +
    '.dsh-pet-bubble .pet-bub-tag{color:rgba(255,255,255,.55);border-color:rgba(255,255,255,.22)}' +
    '.dsh-pet-bubble .pet-bub-quota-bar,' +
    '.dsh-pet-bubble .pet-bub-usage-bar{background:rgba(255,255,255,.14)}' +
    '.dsh-pet-request__tool{color:rgba(255,255,255,.58)}' +
    '.dsh-pet-request__body,.dsh-pet-reminder__line{color:#e4e4e7}' +
    '.dsh-pet-reminder__title,.dsh-pet-request__title{color:#f4f4f5}' +
    '.dsh-pet-reminder__hint{color:rgba(255,255,255,.5)}' +
    '.dsh-pet-request__detail{color:rgba(255,255,255,.6)}' +
    '.dsh-pet-request__question{border-top-color:rgba(255,255,255,.1)}' +
    '.dsh-pet-request__btn{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#f4f4f5}' +
    '.dsh-pet-request__btn:hover{background:rgba(255,255,255,.12)}' +
    '.dsh-pet-request__btn.is-ghost{background:transparent;border-color:transparent;color:rgba(255,255,255,.55)}' +
    '.dsh-pet-request__input{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);color:#f4f4f5}' +
    '.dsh-pet-request__opt{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.18);color:#e4e4e7}' +
    '.dsh-pet-request__opt.is-picked{background:rgba(46,158,79,.22);border-color:#2e9e4f;color:#9be0b0}}',
].join('\n');

/** 注入气泡样式，每页只注入一次。 */
export function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/** 把余额行数据映射成 React 节点。 */
function rowsToNodes(h: typeof jsx, rows: BalanceBubbleRow[]): ReactNode {
  // 含档位段时同一行内联渲染，峰/谷着色。
  if (rows.some((r) => r.role === 'tier')) {
    return h('div', {
      className: 'pet-bub-row',
      children: rows.map((r, i) => {
        // 进度条行不会与档位段同现。
        if (r.role === 'quota') return null;
        if (r.role === 'tier') {
          return h('span', {
            key: i,
            className: 'pet-bub-tier pet-bub-tier-' + r.tier,
            children: r.text,
          });
        }
        return h('span', { key: i, children: r.text });
      }),
    });
  }
  // 其余每行一个块：label、sub、error、quota。
  return rows.map((r, i) => {
    // 展开态一行一个窗口；四段 flex 同行，进度条吃剩余宽度。
    if (r.role === 'quota') {
      return h('div', {
        key: i,
        className: 'pet-bub-quota',
        children: [
          h('span', { key: 'label', className: 'pet-bub-quota-label', children: r.label }),
          h('span', {
            key: 'bar',
            className: 'pet-bub-quota-bar',
            children: h('i', {
              className: 'pet-bub-quota-fill pet-bub-quota-' + r.tone,
              style: { width: Math.max(0, Math.min(100, r.percent)) + '%' },
            }),
          }),
          h('span', { key: 'used', className: 'pet-bub-quota-used', children: r.usedText }),
          h('span', { key: 'reset', className: 'pet-bub-quota-reset', children: r.resetText }),
        ],
      });
    }
    // 用量页：三行两列，总量是整卡唯一的大字；进/出各一处强调色，其余保持次级灰。
    if (r.role === 'usage') {
      return h('div', {
        key: i,
        className: 'pet-bub-usage',
        children: [
          h('div', {
            key: 'head',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'title', className: 'pet-bub-usage-title', children: r.title }),
              h('span', { key: 'total', className: 'pet-bub-usage-total', children: r.total }),
            ],
          }),
          // 进出比例条：宽度即真实占比，输入通常压倒性占多数，条偏单色属正常。
          r.inputPercent === undefined
            ? null
            : h('div', {
                key: 'bar',
                className: 'pet-bub-usage-bar',
                children: [
                  h('i', { key: 'in', className: 'pet-bub-usage-bar-in', style: { width: r.inputPercent + '%' } }),
                  h('i', {
                    key: 'out',
                    className: 'pet-bub-usage-bar-out',
                    style: { width: 100 - r.inputPercent + '%' },
                  }),
                ],
              }),
          h('div', {
            key: 'io',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'in', className: 'pet-bub-usage-in', children: r.input }),
              h('span', { key: 'out', className: 'pet-bub-usage-out', children: r.output }),
            ],
          }),
          h('div', {
            key: 'foot',
            className: 'pet-bub-usage-line',
            children: [
              h('span', { key: 'period', className: 'pet-bub-usage-period', children: r.period }),
              h('span', { key: 'spend', className: 'pet-bub-usage-spend', children: r.spend }),
            ],
          }),
        ],
      });
    }
    if (r.role === 'error') return h('div', { key: i, className: 'pet-bub-err', children: r.text });
    if (r.role === 'sub') return h('div', { key: i, className: 'pet-bub-row pet-bub-sub', children: r.text });
    return h('div', { key: i, className: 'pet-bub-row', children: r.text });
  });
}

/** 把自定义节点树映射成 React 节点，与 rowsToNodes 并列。
 *  行数据由插件定排版，这里把第三方定好的 tag、内联样式与文本原样映射。
 *  解析层已做白名单裁剪，故不做二次校验；不用 innerHTML，没有注入面。
 *  先文本后子节点，与 DOM 的 textContent + appendChild 顺序一致。
 */
function treeToNodes(h: typeof jsx, node: CustomNode, key: string | number): ReactNode {
  const props: Record<string, unknown> = { key };
  if (node.style) props.style = node.style;
  if (node.tag === 'img') {
    // 配图地址只来自解析层的 http/https 白名单；alt 留空由周围文本承担。
    props.src = node.src ?? '';
    props.alt = '';
    return h('img', props);
  }
  const children: ReactNode[] = [];
  if (node.text) children.push(node.text);
  for (let i = 0; i < (node.children?.length ?? 0); i++) {
    children.push(treeToNodes(h, node.children![i]!, i));
  }
  props.children = children;
  return h(node.tag, props);
}

/** 换内容前的淡出等待（ms），与 opacity 过渡同为 250ms。 */
const BALANCE_FADE_MS = 250;

/** 制造余额气泡组件（工厂），注入样式一次。
 *  内容来自 shared 的 balancePageView（按页取行数据）；内置形态走行数据，
 *  custom 走第三方节点树。切页是淡出 → 换内容 → 淡入，显隐与 10s 计时归 pet.ts 管。
 */
export function makeBalanceBubble(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）。
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}): (props: {
  state: BalanceState;
  on: boolean;
  /** 目标页：0 为初始页；内置 windows 形态下 0 收起、1 窗口明细、2 区间用量。 */
  index: number;
  /** 点击气泡：上层切到下一页并重置 10s 计时器。 */
  onCycle: () => void;
}) => ReactNode {
  const { h, useState, useEffect } = rt;
  injectBubbleCss();

  return function BalanceBubble({
    state,
    on,
    index,
    onCycle,
  }: {
    state: BalanceState;
    on: boolean;
    index: number;
    onCycle: () => void;
  }) {
    // shown 是实际显示页，index 是目标页；分开是为了留出淡出换内容的 250ms。
    const [shown, setShown] = useState(0);
    const [fading, setFading] = useState(false);
    useEffect(() => {
      if (index === shown) return;
      setFading(true);
      const timer = window.setTimeout(() => {
        setShown(index);
        setFading(false);
      }, BALANCE_FADE_MS);
      return () => window.clearTimeout(timer);
    }, [index, shown]);

    // 行数据与第三方节点树二选一；custom 页索引越界时夹到最后一页，避免显示残页。
    const isCustom = state.ok && state.shape === 'custom';
    const views = isCustom ? customViews(state) : undefined;
    const tree = views ? views[Math.min(shown, views.length - 1)] : undefined;
    const rows = isCustom ? [] : balancePageView(state, shown);
    // 可点：windows 可展开；custom 只有多于 1 页才可点；其余形态点开没有新内容。
    const clickable = state.ok && (state.shape === 'windows' || (isCustom && customClickable(state)));
    // 不可用状态是多行说明，套用碎碎念的窄字号变体。
    const wrap = state.ok ? '' : ' dsh-pet-whisper';
    // 展开态字号只属于内置 windows 的窗口明细与用量两页；custom 各页是对等页面，翻页不该切紧凑字号。
    return h('div', {
      className:
        'dsh-pet-bubble' +
        wrap +
        (on ? ' is-on' : '') +
        (clickable ? ' is-clickable' : '') +
        (!isCustom && shown > 0 ? ' is-expanded' : '') +
        (fading ? ' is-fading' : ''),
      // 就地吞掉，避免触发宠物本体的点击与拖拽。
      onClick: clickable
        ? (e: ReactNS.MouseEvent<HTMLDivElement>) => {
            e.stopPropagation();
            onCycle();
          }
        : undefined,
      children: tree ? treeToNodes(h, tree, 'tree') : rowsToNodes(h, rows),
    });
  };
}

/** 制造碎碎念气泡组件（工厂），与余额气泡共用样式与行渲染。
 *  image 是池内名（按素材根拼路径），url 是第三方完整地址，两者互斥且由 host 判定层保证。
 *  有配图时渲染在文字上方，图片样式取自 shared 的 MEME_BUBBLE_CSS。
 */
export function makeWhisperBubble(rt: { h: typeof jsx }): (props: {
  text: string;
  /** 第二行：进度（「第 3 步 · 已用 2 分钟」）。工作状态气泡用，其它气泡不传。 */
  meta?: string | null;
  /** 清单进度（0–100）；有值才画条子，null/缺省不画。 */
  percent?: number | null;
  /** 条子右边的「4/7 项」；不传就只有条子。 */
  percentLabel?: string | null;
  image?: string;
  url?: string;
  assetRoot?: string;
  on: boolean;
  voiceState?: 'idle' | 'loading' | 'ready' | 'failed';
  /** 可点时的回调；工作状态气泡用它跳会话，缺省即不可点。 */
  onClick?: (e: ReactNS.MouseEvent<HTMLDivElement>) => void;
}) => ReactNode {
  const { h } = rt;
  injectBubbleCss();
  injectMemeBubbleCss();

  return function WhisperBubble({
    text,
    meta,
    percent,
    percentLabel,
    image,
    url,
    assetRoot,
    on,
    voiceState = 'idle',
    onClick,
  }: {
    text: string;
    meta?: string | null;
    percent?: number | null;
    percentLabel?: string | null;
    image?: string;
    url?: string;
    assetRoot?: string;
    on: boolean;
    voiceState?: 'idle' | 'loading' | 'ready' | 'failed';
    onClick?: (e: ReactNS.MouseEvent<HTMLDivElement>) => void;
  }) {
    const rows = whisperBubbleView({ ok: true, text, ts: 0 });
    const key = String(image ?? '').trim();
    const href = String(url ?? '').trim();
    // 配图二选一：url 直接用，image 按素材根拼路径；判别位在字段名上，不靠 startsWith 嗅探。
    const src = href || (key ? memeImageUrl(key, ROUTE_PATH, assetRoot) : '');
    const body = src
      ? [
          h('img', {
            key: 'img',
            className: MEME_IMG_CLASS,
            // 名称形态拼本页路由前缀；url 形态是完整地址，与本页 origin 无关。
            src,
            alt: key || href,
          }),
          rowsToNodes(h, rows),
        ]
      : rowsToNodes(h, rows);
    // 第二行进度：只在有值时出现，字号比正文小一号，不抢正文的注意力。
    const metaNode =
      typeof meta === 'string' && meta !== ''
        ? h('span', { key: 'meta', className: 'dsh-pet-whisper__meta', children: meta })
        : null;
    // 清单进度条：只有拿到真实条数（todo 清单）才画；进度不可知时宁可没有，也不给假条子。
    const pct = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
    const barNode =
      pct === null
        ? null
        : h('span', {
            key: 'progress',
            className: 'dsh-pet-whisper__progress',
            children: [
              h('span', {
                key: 'track',
                className: 'dsh-pet-whisper__track',
                children: [
                  h('span', {
                    key: 'fill',
                    className: 'dsh-pet-whisper__fill',
                    style: { width: pct + '%' },
                  }),
                ],
              }),
              typeof percentLabel === 'string' && percentLabel !== ''
                ? h('span', { key: 'label', className: 'dsh-pet-whisper__pct', children: percentLabel })
                : null,
            ],
          });
    const textNodes = Array.isArray(body) ? body : [body];
    const tailNodes = [...(metaNode === null ? [] : [metaNode]), ...(barNode === null ? [] : [barNode])];
    return h('div', {
      className:
        'dsh-pet-bubble dsh-pet-whisper' +
        (src ? ' ' + MEME_BUBBLE_CLASS : '') +
        (on ? ' is-on' : '') +
        (onClick ? ' is-clickable' : ''),
      // 点在气泡上不能漏到底下的宠物本体：那里是拖拽与「摸一下」的命中区。
      onClick: onClick
        ? (e: ReactNS.MouseEvent<HTMLDivElement>) => {
            e.stopPropagation();
            onClick(e);
          }
        : undefined,
      children:
        voiceState === 'idle'
          ? [...textNodes, ...tailNodes]
          : [[...textNodes, ...tailNodes], voiceBadgeNode(h, voiceState)],
    });
  };
}

/** 语音状态角标：只在手动触发的播报上出现，右下角绝对定位，不参与文字排版。
 *  `failed` 用静音喇叭——「本该有声却没响」，不是系统告警，所以不上警告符号。 */
function voiceBadgeNode(h: typeof jsx, state: 'loading' | 'ready' | 'failed'): ReactNode {
  return h('span', {
    key: 'voice',
    className:
      'dsh-pet-voice-badge' + (state === 'loading' ? ' is-loading' : '') + (state === 'failed' ? ' is-failed' : ''),
    'aria-hidden': 'true',
    children: state === 'loading' ? null : state === 'failed' ? '🔇' : '🔊',
  });
}
