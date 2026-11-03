/**
 * 气泡与悬浮提示的渲染：工作状态 / 碎碎念 / 余额三段内容共用一个气泡槽，按优先级择一显示。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 只读实例状态，除 DOM 与 syncInputBusy() 之外不写任何字段。
 * @module dsh-pet/runtime/electron-helper/sprite-bubble
 */
'use strict';

Object.assign(PetSprite.prototype, {
  setTip(on) {
    const next = !!on;
    if (next === this.tipOn) return;
    this.tipOn = next;
    this.renderTip();
  },

  /**
   * 悬浮提示渲染：文本 = 宠物显示名（宿主已保证非空）；位置 = 光标右下（装不下自动翻边），
   * 摆位判据与浏览器端共用 shared 的 tooltipPlacement。
   *
   * 光标存的是视口坐标，而提示是 position:fixed、DOM 坐标相对窗口，所以这里减掉窗口原点。
   * 存视口坐标而非窗口坐标，是因为窗口会随宠物移动：只在这里按当前原点重算一次，贴光标不会漂。
   */
  renderTip() {
    if (this.tip.textContent !== this.pet.name) this.tip.textContent = this.pet.name;
    const cursor = this.tipCursor;
    if (cursor) {
      const winX = this.pos.x - this.margin.l;
      const winY = this.pos.y - this.margin.t;
      const winW = this.size + this.margin.l + this.margin.r;
      const winH = this.winH + this.margin.t + this.margin.b;
      // 允许显示范围 = 窗口 ∩ 光标所在屏的工作区：只按窗口夹会画到屏幕外，只按工作区夹会落到
      // 窗口外（html/body 是 overflow:hidden，一样看不见）。
      const area = S.resolveRect(WORK_AREAS, cursor.x, cursor.y) ?? { x: winX, y: winY, width: winW, height: winH };
      const x0 = Math.max(winX, area.x);
      const y0 = Math.max(winY, area.y);
      const x1 = Math.min(winX + winW, area.x + area.width);
      const y1 = Math.min(winY + winH, area.y + area.height);
      const p = S.tooltipPlacement(
        { x: cursor.x - winX, y: cursor.y - winY },
        { w: this.tip.offsetWidth, h: this.tip.offsetHeight },
        { x: x0 - winX, y: y0 - winY, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
        this.size * S.TOOLTIP_GAP_RATIO,
      );
      this.tip.style.left = p.x + 'px';
      this.tip.style.top = p.y + 'px';
    }
    this.tip.classList.toggle('is-on', this.tipOn);
    window.__dshPetDebug.tooltipOn = this.tipOn;
  },
  renderBubble() {
    // 审批/提问请求优先级最高：它是等用户回话的，不接管就会卡住 DSH 那一轮。
    if (this.requestEnvelope) {
      this.renderRequestBubble();
      return;
    }
    // 待办面板占气泡槽且优先级最高：它是用户主动打开的窗口，其余气泡一律让位。
    // 面板是外部塞进来的 DOM，重建 innerHTML 会把它自己抹掉，所以这一段只补显隐与让位。
    this.bubble.classList.toggle('dsh-pet-todo-bubble', this.todoOpen);
    if (this.todoOpen) {
      this.bubble.classList.remove('is-whisper', 'is-clickable', 'is-expanded', S.MEME_BUBBLE_CLASS);
      this.bubble.classList.add('is-on');
      window.__dshPetDebug.lastBubbleTitle = '待办事项';
      this.syncInputBusy();
      return;
    }
    // 定时任务提醒：到点由宿主写 sections.reminder，展示期间盖过工作/碎碎念气泡（它本来就是来抢注意的）。
    if (this.reminderEnvelope) {
      this.renderReminderBubble();
      return;
    }
    // 气泡单槽：同一时刻只显示一个（优先级：终态任务 > 碎碎念/对话 > 余额 > 非终态任务）。
    // 终态任务不让位：完成/失败气泡只活 10s，被顶掉就彻底看不到；非终态气泡常驻，让位零损失。
    // 工作气泡与碎碎念同款样式（宽度自适应 + 自动换行）；配图标记交给 CSS（带图时取消 min-width）。
    // 图片 URL 与视频同规则：传 BASE 前缀（桌面是 file:// 页面，必须绝对地址），素材根同理。
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperView);
    const balanceOn = !!(this.bubbleOn && this.balanceView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    const slot =
      workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';
    // 记住当前槽位：点击处理在 init.js，必须知道「现在显示的是哪一种气泡」才能分清翻页与跳会话。
    this.bubbleSlot = slot;
    // 配图两种形态二选一：url 用完整地址，image 按素材根拼表情包路径；样式/class 共用。
    const whisperImg =
      slot === 'whisper'
        ? this.whisperUrl
          ? S.createMemeImageFromUrl(this.whisperUrl)
          : S.createMemeImage(this.whisperImage, BASE, this.assetRoot)
        : null;
    this.bubble.classList.toggle(
      'is-whisper',
      // 余额「文字说明」也套紧凑变体：字号更小、宽度下限更窄，多行说明更紧凑
      slot === 'whisper' || slot === 'work' || (slot === 'balance' && this.balanceWrap),
    );
    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);
    // 可点/展开两个状态类：可点 → 气泡参与命中区（见 syncInputRegions）；index>0 → 更宽的盒与紧凑字号。
    // 展开态仅内置 windows 的窗口明细与用量页使用；custom 各页是对等页面，翻页不切紧凑字号。
    const isCustom = !!(this.balanceState && S.customViews(this.balanceState));
    const workClickable = this.workClickable();
    const clickable = (slot === 'balance' && this.balanceClickable()) || workClickable;
    const expanded = slot === 'balance' && clickable && !isCustom && this.balanceViewIndex > 0;
    this.bubble.classList.toggle('is-clickable', clickable);
    this.bubble.classList.toggle('is-expanded', expanded);
    if (slot === 'none') {
      // 三者都没有可显示的内容：隐藏（不占位，也就不会挡住任何一层）
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      this.syncInputBusy(); // 气泡没了 → 撤销它的控件矩形与 busy 标记（否则整窗还留着可点区域）
      return;
    }
    this.bubble.innerHTML = '';
    if (slot === 'work') {
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.workText;
      this.bubble.appendChild(line);
    } else if (slot === 'whisper') {
      // 配图（shared 生成的 <img> + 共用样式）：先看图再读话
      if (whisperImg) this.bubble.appendChild(whisperImg);
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
      // 语音状态角标：idle 时什么都不加；failed 用静音喇叭，表示这句没念出来
      const voice = S.getVoiceState();
      if (voice !== 'idle') {
        S.injectMemeBubbleCss(); // 角标样式与配图同一份 CSS，两端共用
        const badge = document.createElement('span');
        badge.className =
          'dsh-pet-voice-badge' + (voice === 'loading' ? ' is-loading' : '') + (voice === 'failed' ? ' is-failed' : '');
        badge.setAttribute('aria-hidden', 'true');
        if (voice === 'ready') badge.textContent = '🔊';
        else if (voice === 'failed') badge.textContent = '🔇';
        this.bubble.appendChild(badge);
      }
    } else if (this.balanceState && S.customViews(this.balanceState)) {
      // custom 形态：第三方自己的节点树。页索引取当前页；页数变少时夹到最后一页，不显示残页。
      const views = S.customViews(this.balanceState);
      const page = views[Math.min(this.balanceViewIndex, views.length - 1)];
      if (page) this.bubble.appendChild(this.renderTree(page));
    } else {
      // 展开态的行在这里现算：renderBubble 是只读渲染路径，不缓存（余额每轮都在变，缓存反而要同步失效）
      // 每页内容与页数同源（S.balancePageView / S.balancePageCount）：不再按「index>0 即窗口明细」二分化，
      // 否则新增的用量页会和明细挤在同一页。没有读数时回落到缓存的首屏行。
      const rows = this.balanceState ? S.balancePageView(this.balanceState, this.balanceViewIndex) : this.balanceView;
      const hasTier = rows.some((r) => r.role === 'tier');
      if (hasTier) {
        // deepseek 余额单行：余额（峰/谷）¥x — 档位字着色
        const line = document.createElement('div');
        line.className = 'pet-bub-row';
        for (const r of rows) {
          const span = document.createElement('span');
          if (r.role === 'tier') span.className = 'pet-bub-tier pet-bub-tier-' + r.tier;
          span.textContent = r.text;
          line.appendChild(span);
        }
        this.bubble.appendChild(line);
      } else {
        for (const r of rows) {
          // 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时，四段 flex 同行，条吃剩余宽度。
          if (r.role === 'quota') {
            const row = document.createElement('div');
            row.className = 'pet-bub-quota';
            const label = document.createElement('span');
            label.className = 'pet-bub-quota-label';
            label.textContent = r.label;
            const bar = document.createElement('span');
            bar.className = 'pet-bub-quota-bar';
            const fill = document.createElement('i');
            fill.className = 'pet-bub-quota-fill pet-bub-quota-' + r.tone;
            fill.style.width = Math.max(0, Math.min(100, r.percent)) + '%';
            bar.appendChild(fill);
            const used = document.createElement('span');
            used.className = 'pet-bub-quota-used';
            used.textContent = r.usedText;
            const reset = document.createElement('span');
            reset.className = 'pet-bub-quota-reset';
            reset.textContent = r.resetText;
            row.append(label, bar, used, reset);
            this.bubble.appendChild(row);
            continue;
          }
          // 用量页：三行两列，总量是唯一大字；进/出各一处强调色，其余次级灰。
          if (r.role === 'usage') {
            const box = document.createElement('div');
            box.className = 'pet-bub-usage';
            const line = (cells) => {
              const row = document.createElement('div');
              row.className = 'pet-bub-usage-line';
              for (const cell of cells) {
                const span = document.createElement('span');
                span.className = cell.cls;
                span.textContent = cell.text;
                row.appendChild(span);
              }
              return row;
            };
            // 进出比例条：宽度即真实占比，输入通常压倒性占多数，条偏单色属正常。
            const bar = document.createElement('div');
            bar.className = 'pet-bub-usage-bar';
            if (r.inputPercent !== undefined) {
              const inBar = document.createElement('i');
              inBar.className = 'pet-bub-usage-bar-in';
              inBar.style.width = r.inputPercent + '%';
              const outBar = document.createElement('i');
              outBar.className = 'pet-bub-usage-bar-out';
              outBar.style.width = 100 - r.inputPercent + '%';
              bar.append(inBar, outBar);
            }
            box.append(
              line([
                { cls: 'pet-bub-usage-title', text: r.title },
                { cls: 'pet-bub-usage-total', text: r.total },
              ]),
            );
            if (r.inputPercent !== undefined) box.appendChild(bar);
            box.append(
              line([
                { cls: 'pet-bub-usage-in', text: r.input },
                { cls: 'pet-bub-usage-out', text: r.output },
              ]),
              line([
                { cls: 'pet-bub-usage-period', text: r.period },
                { cls: 'pet-bub-usage-spend', text: r.spend },
              ]),
            );
            this.bubble.appendChild(box);
            continue;
          }
          const div = document.createElement('div');
          if (r.role === 'error') div.className = 'pet-bub-err';
          else if (r.role === 'sub') div.className = 'pet-bub-row pet-bub-sub';
          else div.className = 'pet-bub-row';
          div.textContent = r.text;
          this.bubble.appendChild(div);
        }
      }
    }
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    // 气泡内容/尺寸变了 → 重报控件矩形并同步 busy 标记。这里是所有显隐与换内容的汇聚点。
    this.syncInputBusy();
  },

  /** 小工具：造一个元素并挂类名/文本。 */
  bubbleEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  },

  /** 小工具：造一个参与请求回答的按钮。 */
  bubbleButton(label, cls, action) {
    const btn = this.bubbleEl('button', 'pet-bub-btn' + (cls ? ' ' + cls : ''), label);
    btn.type = 'button';
    btn.dataset.reqAction = action;
    return btn;
  },

  /**
   * 审批 / 提问气泡：把宿主 `sections.request` 的信封画成可直接点的选项。
   * 按钮点击由 init.js 的 bubble click 分流到 onRequestAction（窗口穿透已由 is-clickable 登记）。
   */
  renderRequestBubble() {
    const req = this.requestEnvelope;
    this.bubble.classList.remove('is-whisper', 'is-expanded', S.MEME_BUBBLE_CLASS, 'dsh-pet-todo-bubble');
    this.bubble.classList.add('is-on', 'is-request', 'is-clickable');
    this.bubbleSlot = 'request';
    this.bubble.innerHTML = '';
    const wrap = this.bubbleEl('div', 'pet-bub-req');
    const head = this.bubbleEl('div', 'pet-bub-req__head');
    const isQuestion = req.kind === 'question';
    head.appendChild(
      this.bubbleEl('span', 'pet-bub-req__badge' + (isQuestion ? ' is-question' : ''), isQuestion ? '提问' : '审批'),
    );
    head.appendChild(
      this.bubbleEl('span', 'pet-bub-req__title', isQuestion ? '宠物需要你选一下' : req.toolName || '需要确认'),
    );
    wrap.appendChild(head);
    if (!isQuestion) {
      wrap.appendChild(this.bubbleEl('div', 'pet-bub-req__text', req.reason || '是否允许这次操作？'));
      const actions = this.bubbleEl('div', 'pet-bub-req__actions');
      actions.append(
        this.bubbleButton('允许一次', 'is-primary', 'approve'),
        this.bubbleButton('本会话都允许', '', 'approve-session'),
        this.bubbleButton('拒绝', '', 'reject'),
        this.bubbleButton('去 DSH', 'is-ghost', 'delegate'),
      );
      wrap.appendChild(actions);
    } else {
      const questions = req.questions || [];
      const picksFor = (qid) => this.requestPicks[qid] || [];
      for (const q of questions) {
        const box = this.bubbleEl('div', 'pet-bub-req__q');
        if (q.header) box.appendChild(this.bubbleEl('div', 'pet-bub-req__qhead', q.header));
        box.appendChild(this.bubbleEl('div', 'pet-bub-req__text', q.question));
        const opts = this.bubbleEl('div', 'pet-bub-req__actions');
        for (const opt of q.options || []) {
          const picked = picksFor(q.id).includes(opt.label);
          const btn = this.bubbleButton(opt.label, 'pet-bub-opt' + (picked ? ' is-picked' : ''), 'pick');
          btn.dataset.reqQ = q.id;
          btn.dataset.reqValue = opt.label;
          if (opt.description) btn.title = opt.description;
          opts.appendChild(btn);
        }
        box.appendChild(opts);
        wrap.appendChild(box);
      }
      const ready = questions.length > 0 && questions.every((q) => picksFor(q.id).length > 0);
      const actions = this.bubbleEl('div', 'pet-bub-req__actions');
      const send = this.bubbleButton('发送', 'is-primary', 'send');
      if (!ready) send.disabled = true;
      actions.append(send, this.bubbleButton('去 DSH', 'is-ghost', 'delegate'));
      wrap.appendChild(actions);
    }
    this.bubble.appendChild(wrap);
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    this.syncInputBusy();
  },

  /** 定时任务提醒气泡：标题 + 摘要 + 到点时刻，不参与点击。 */
  renderReminderBubble() {
    const rem = this.reminderEnvelope;
    this.bubble.classList.remove('is-whisper', 'is-clickable', 'is-expanded', S.MEME_BUBBLE_CLASS, 'is-request');
    this.bubble.classList.add('is-on');
    this.bubbleSlot = 'reminder';
    this.bubble.innerHTML = '';
    const wrap = this.bubbleEl('div', 'pet-bub-req');
    wrap.appendChild(this.bubbleEl('div', 'pet-bub-rem__title', '⏰ ' + (rem.title || '定时提醒')));
    const text = rem.prompt && rem.prompt !== rem.title ? rem.prompt : '';
    if (text) wrap.appendChild(this.bubbleEl('div', 'pet-bub-rem__text', text));
    const when = rem.scheduledAt ? new Date(rem.scheduledAt) : new Date(rem.ts);
    if (!Number.isNaN(when.getTime())) {
      wrap.appendChild(
        this.bubbleEl('div', 'pet-bub-rem__time', when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      );
    }
    this.bubble.appendChild(wrap);
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    this.syncInputBusy();
  },

  /** 请求气泡的按钮分流：选选项、发送、允许/拒绝、交给 DSH。 */
  onRequestAction(action, qid, value) {
    const req = this.requestEnvelope;
    if (!req || this.requestPending) return;
    if (action === 'delegate') {
      this.submitRequestAnswer({ id: req.id, kind: req.kind, cancel: true });
      return;
    }
    if (req.kind === 'approval') {
      if (action !== 'approve' && action !== 'reject' && action !== 'approve-session') return;
      this.submitRequestAnswer({
        id: req.id,
        kind: 'approval',
        outcome: action === 'reject' ? 'rejected' : action === 'approve-session' ? 'allow-session' : 'allowed-once',
      });
      return;
    }
    if (action === 'pick') {
      const q = (req.questions || []).find((item) => item.id === qid);
      if (!q) return;
      const picks = this.requestPicks[qid] || [];
      let next;
      if (q.multiSelect) next = picks.includes(value) ? picks.filter((v) => v !== value) : picks.concat(value);
      else next = picks.includes(value) ? [] : [value];
      this.requestPicks[qid] = next;
      this.renderBubble();
      return;
    }
    if (action === 'send') {
      const answers = [];
      for (const q of req.questions || []) {
        const picks = this.requestPicks[q.id] || [];
        if (picks.length === 0) return;
        answers.push({ id: q.id, selected: picks });
      }
      if (answers.length === 0) return;
      this.submitRequestAnswer({ id: req.id, kind: 'question', answers });
    }
  },

  /** POST 回答；成功后乐观收起，宿主随后会写 closed 信封做最终清理。 */
  submitRequestAnswer(body) {
    this.requestPending = true;
    fetch(BASE + '/request/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .then((json) => {
        if (json && json.ok) {
          this.requestEnvelope = null;
          this.requestPicks = {};
          this.requestPending = false;
          this.renderBubble();
          return;
        }
        this.requestPending = false;
      })
      .catch(() => {
        this.requestPending = false;
      });
  },
});
