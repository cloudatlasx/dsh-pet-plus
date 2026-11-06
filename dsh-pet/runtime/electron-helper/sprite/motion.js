/**
 * 运动驱动：拖拽跟随、抛掷、位置指令与 Q 弹挤压的帧循环。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 每条驱动只管自己的帧句柄与世代号；停止由调用方决定，互不 import。
 * @module dsh-pet/runtime/electron-helper/sprite-motion
 */
'use strict';

Object.assign(PetSprite.prototype, {
  startMoveDrive(el) {
    const pm = this.pendingMove;
    if (!pm || this.moveRef !== null) return;
    this.pendingMove = null;
    const { startRatio, startYRatio, targetRatio, leadSec, tailSec } = pm;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
    const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
    const token = ++this.moveToken;
    const W = VIEW.w;
    const H = VIEW.h;
    const step = () => {
      if (this.moveToken !== token) return;
      const t = el.currentTime || 0;
      let ratioX;
      if (t <= leadSec) ratioX = startRatio;
      else if (t >= duration - tailSec) ratioX = targetRatio;
      // 按规划落点插值而不是 dir × 距离：minDist/maxDist 为负时符号必须保留，
      // 否则规划往左、驱动往右，走完再跳回原本的方向。
      else ratioX = startRatio + (targetRatio - startRatio) * ((t - leadSec) / travelWindow);
      // 移动的是窗口（宠物包围盒跟随），sprite 在本窗口内不动
      this.sendBounds(ratioX * W - this.halfW, startYRatio * H - this.halfH);
      if (t < duration - tailSec) {
        this.moveRef = requestAnimationFrame(step);
      } else {
        this.moveRef = null;
        this.customPos = { rx: targetRatio, ry: startYRatio };
      }
    };
    this.moveRef = requestAnimationFrame(step);
  },

  stopMove() {
    this.pendingMove = null;
    this.moveToken++;
    if (this.moveRef !== null) {
      cancelAnimationFrame(this.moveRef);
      this.moveRef = null;
    }
    // 位置指令的弹簧也是自主移动：停走路时一并停掉，否则两套运动系统会同时改窗口位置。
    this.stopPosFollow();
  },

  // 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）
  stopDragFollow() {
    this.dragFollowToken++;
    if (this.dragFollow !== null) {
      cancelAnimationFrame(this.dragFollow);
      this.dragFollow = null;
    }
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
  },

  /** rAF 弹簧跟随：窗口朝拖拽目标过阻尼追赶（不再硬贴指针），抹平高频抖动 */
  startDragFollow() {
    if (this.dragFollow !== null) return;
    const token = ++this.dragFollowToken;
    let last = performance.now();
    const step = () => {
      if (this.dragFollowToken !== token) return;
      const target = this.dragTarget;
      if (!target) {
        this.dragFollow = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const vel = this.dragVel;
      let x = this.pos.x;
      let y = this.pos.y;
      vel.vx = S.springStep(vel.vx, x, target.x, dt, this.physics.throwPower);
      vel.vy = S.springStep(vel.vy, y, target.y, dt, this.physics.throwPower);
      x += vel.vx * dt;
      y += vel.vy * dt;
      this.sendBounds(x, y); // 移动的是窗口（this.pos 实时更新）；sprite 在本窗口内不动
      this.dragFollow = requestAnimationFrame(step);
    };
    this.dragFollow = requestAnimationFrame(step);
  },

  /** 停止抛掷（空中被抓/点菜单/回家时定格在当前落点）。必须同时清 throwState——否则「抓住后温柔放下」
   *  会残留最后一次飞行速度，静止的宠物点一下就被误判成飞行中。 */
  stopThrow() {
    this.throwToken++;
    if (this.throwRef !== null) {
      cancelAnimationFrame(this.throwRef);
      this.throwRef = null;
    }
    this.throwState = null;
  },

  /** 抛掷驱动：重力 + 边缘反弹 + 落地摩擦，落定后写入 customPos */
  startThrow(px, py, vx, vy) {
    this.stopDragFollow();
    this.stopMove();
    // 边界 = 工作区并集：空洞是墙，屏缝不是墙（跨屏弹跳照旧）。confineToScreen 开启时改为锁定
    // 松手这一刻所在的那块屏，飞行途中不重取；relayout 改了屏数时由 throwStepRegion 退回不锁定。
    const lockScreen = this.confineToScreen ? S.screenOfBox(this.throwSpaceOf(), px, py) : -1;
    const token = ++this.throwToken;
    let state = { x: px, y: py, vx, vy };
    let last = performance.now();
    let prevGrounded = false; // 落地 Q 弹：只在空中→地面转换帧触发一次
    const step = () => {
      if (this.throwToken !== token) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const fallingVy = state.vy; // 本帧积分前的竖直速度（正=下落）：即落地冲击速度
      // 每帧重取：显示器变化时 relayout() 会让缓存失效，res.screen 必须与这一份对应
      const sp = this.throwSpaceOf();
      // 细分积分：弹弓没有速度上限，一帧可能跨过上百 px；不拆会跳过落地/反弹那几帧，
      // Q 弹、地面摩擦与 atRest 判定都会漏。普通甩抛算出 1 步，与单步积分逐位相同。
      const substeps = S.throwSubsteps(state.vx, state.vy, dt);
      let res = S.throwStepRegion(state, dt / substeps, sp, this.physics, lockScreen);
      for (let i = 1; i < substeps && !res.atRest; i++) {
        res = S.throwStepRegion(res, dt / substeps, sp, this.physics, lockScreen);
      }
      state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      this.throwState = state;
      // 上报飞行状态（节流 ~30ms）：主进程 broker 汇聚后广播，其它窗口据此做跨窗碰撞检测；
      // broker 协议单位是物理像素，这里 ×scale。
      if (window.petBridge && window.petBridge.reportFlight && now - this.lastFlightReport > 30) {
        window.petBridge.reportFlight({
          x: toScreen(state.x),
          y: toScreen(state.y),
          vx: toScreen(state.vx),
          vy: toScreen(state.vy),
          size: toScreen(this.size),
          bottomPad: toScreen(this.bottomPad),
        });
        this.lastFlightReport = now;
      }
      // 宠物间碰撞（仅 petCollision 开启）：飞行中的自己撞到其它宠物 → 动量弹开
      if (this.physics && this.physics.petCollision) {
        const myBody = S.bodyPixelBox({ x: state.x, y: state.y, size: this.size, bottomPad: this.bottomPad });
        for (const pid of Object.keys(this.others)) {
          const o = this.others[pid];
          if (!o || !o.size) continue;
          const otherBody = S.bodyPixelBox({ x: o.x, y: o.y, size: o.size, bottomPad: o.bottomPad });
          if (!S.rectsOverlap(myBody, otherBody)) continue;
          const hit = S.collidePet(
            { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size: this.size },
            { x: o.x, y: o.y, vx: o.vx, vy: o.vy, size: o.size },
          );
          if (hit) {
            // 飞行方：按动量结果继续弹开；被撞方：主进程转发给目标窗口 → 目标窗 startThrow
            state.vx = hit.fvx;
            state.vy = hit.fvy;
            this.throwState = state;
            if (window.petBridge && window.petBridge.reportCollide) {
              // 被撞方初速同为 broker 物理像素协议：×scale
              window.petBridge.reportCollide(pid, toScreen(hit.hvx), toScreen(hit.hvy));
            }
            break; // 一帧只处理一次碰撞（避免连锁触发抖动）
          }
        }
      }
      this.sendBounds(res.x, res.y);
      // 落地 Q 弹：只在空中→地面转换帧触发一次，力度随冲击速度；「地面」是当前所在屏的底边。
      const curBounds = sp.bounds[res.screen] || sp.bounds[0];
      const grounded = curBounds ? res.y >= curBounds.maxY - 1 : false;
      if (res.bounced && grounded && !prevGrounded) {
        const frontEl = this.front === 0 ? this.videoA : this.videoB;
        this.startSquash(frontEl, S.landingSquash(fallingVy));
      }
      prevGrounded = grounded;
      if (res.atRest) {
        this.throwRef = null;
        this.throwState = null;
        this.customPos = { rx: (this.pos.x + this.halfW) / VIEW.w, ry: (this.pos.y + this.halfH) / VIEW.h };
        window.__dshPetDebug.lastDragRelease = { x: this.pos.x, y: this.pos.y };
        return;
      }
      this.throwRef = requestAnimationFrame(step);
    };
    this.throwRef = requestAnimationFrame(step);
  },

  // 位置 / 抛掷指令（POST /position、POST /throw）
  stopPosFollow() {
    this.posFollowToken++;
    if (this.posFollow !== null) {
      cancelAnimationFrame(this.posFollow);
      this.posFollow = null;
    }
    // 被接管时也要收掉行进动画，否则它会一直轻轻晃着停在原地
    this.stopGlide();
  },

  /** 行进中的轻微浮动（CSS 动画，reduce-motion 时由样式表自己关掉）。 */
  startGlide() {
    if (!this.el) return;
    this.el.classList.add('is-gliding');
    // 变身小鱼：视频淡出、鱼淡入（样式见 index.html 的 .pet-fish）。
    // --swim-dir 决定鱼头朝哪边，由 startGlide 的调用方（moveToCenter）在出发前写好。
    this.el.classList.add('is-swimming');
    // 鲸鱼 WebM 从头播一遍；play() 被拒（未挂载/解码失败）时 CSS 小鱼继续兜底。
    if (this.fishVideo) {
      try {
        this.fishVideo.currentTime = 0;
        const playing = this.fishVideo.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => undefined);
      } catch {
        // 播放失败不影响移动
      }
    }
  },

  stopGlide() {
    if (!this.el) return;
    this.el.classList.remove('is-gliding', 'is-swimming');
    if (this.fishVideo) this.fishVideo.pause();
  },

  /**
   * 提醒气泡弹出：变身小鱼游到 DSH 那块屏的正中间。
   *
   * 只记第一次的出发位置——同一条提醒重画（重连、宿主重写信封）不该再出发一次；
   * 用户在中间自己拖走则以拖拽优先，不硬拽回来。
   */
  swimToCenterForReminder(id) {
    if (this.dragState.active) return;
    if (this.reminderSwimHome === null) {
      this.reminderSwimHome = { rx: this.currentCenterX() / VIEW.w, ry: this.currentCenterY() / VIEW.h };
    }
    const first = this.reminderSwimId !== id;
    this.reminderSwimId = id;
    if (!first) return;
    this.moveToCenter(0.5, 0.5, 'line', 1600, 'anchor');
  },

  /** 确认（或收起/超时）之后游回提醒前的位置；没游出去过就什么都不做。 */
  swimBackFromReminder() {
    const home = this.reminderSwimHome;
    this.reminderSwimHome = null;
    this.reminderSwimId = null;
    if (home === null) return;
    if (this.dragState.active) return;
    // 回程按并集比例解释（home 就是这么记的），与「游过来」的 anchor 不是同一套参照系
    this.moveToCenter(home.rx, home.ry, 'line', 1100, 'view');
  },

  /**
   * 位置指令 + 稍后归位：先游到 (rx, ry)，`returnAfter` 毫秒后再游回出发的地方。
   *
   * 给「请求挂太久，宠物游到屏幕中央催一下」用：宿主只知道该提醒了，不知道窗口原来在哪
   * （多显示器、自定义布局都在渲染端），所以「原位」只能在这里记。用户中途自己按着宠物拖走，
   * 就当他接管了——归位取消，别把人家手里的东西拽回去。
   *
   * @param rx - 目标中心横坐标（归一化 0~1）。
   * @param ry - 目标中心纵坐标（归一化 0~1）。
   * @param mode - 运动模式，通常传 `line`。
   * @param duration - 去程时长（ms）。
   * @param returnAfter - 去程结束后停留多久再归位（ms）；`<= 0` 表示不归位。
   * @param frame - 归一化参照系：`anchor` = DSH 所在那块屏（去程），归位腿固定按并集比例。
   */
  moveToCenterAndReturn(rx, ry, mode, duration, returnAfter, frame) {
    if (this.dragState.active) return;
    const home = { rx: this.currentCenterX() / VIEW.w, ry: this.currentCenterY() / VIEW.h };
    this.cancelReturnHome();
    this.moveToCenter(rx, ry, mode, duration, frame);
    // 落地的同一拍再闪一次气泡：走过去要 1 秒多，起点就闪的话等它到了动画早放完了
    this.pulseOnArrive = true;
    if (!(returnAfter > 0)) return;
    const token = ++this.returnSeq;
    this.returnHomeToken = token;
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      // 期间被新的位置指令 / 用户拖拽接管，就不归位了
      if (this.returnHomeToken !== token) return;
      if (this.dragState.active) return;
      // 用 instant 会瞬间闪回去，这里固定走一段直线，肉眼能看出「它自己溜回去了」。
      // 归位目标是出发点的并集比例，所以这里必须按 view 解释，不能继承去程的 anchor。
      this.moveToCenter(home.rx, home.ry, 'line', 900, 'view');
    }, duration + returnAfter);
    this.returnTimer.unref?.();
  },

  /** 取消待执行的归位（新指令、拖拽、销毁时都要调，否则宠物会突然自己跑掉）。 */
  cancelReturnHome() {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = null;
    this.returnHomeToken = 0;
  },

  /**
   * 位置指令：把宠物中心挪到归一化坐标 (rx, ry)，与 customPos 同一套语义。
   * mode 三选一：instant 一帧到位；spring 走过阻尼弹簧；line 在 duration 毫秒里直线走完
   * （duration <= 0 等同 instant）。用户正按着宠物时整拍静默丢弃——手指底下的东西不该跑。
   * 归一化空间默认是工作区并集的外接矩形，落点会被夹到 AREAS 并集（空洞不可达）；
   * `frame: 'anchor'` 时改为按 DSH 所在那块屏换算、也只在那块屏内夹取——双屏横排时并集的
   * 0.5/0.5 正好落在两块屏的接缝上，「去屏幕中间」必须用 anchor 才是「DSH 那块屏的中间」。
   */
  moveToCenter(rx, ry, mode, duration, frame) {
    if (this.dragState.active) return; // 用户交互优先
    // 任何新的位置指令都作废未执行的归位：否则宠物可能先照新指令走，过一秒又自己溜回老地方
    this.cancelReturnHome();
    this.stopThrow(); // 先显式接管：停掉飞行与走路（stopMove 顺带停掉上一次的位置跟随）
    this.stopMove();
    // 参照系：并集外接矩形（默认）或 DSH 所在屏（anchor，未上报时退回主屏）
    const area = frame === 'anchor' ? anchorAreaLocal() || PRIMARY_AREA : null;
    // 归一化空间是外接矩形，不规则布局里含大片空洞；position() 的 customPos 分支零夹取，
    // 不夹的话落进空洞的坐标会把宠物放进看不见的地方。鼠标拖拽到不了那里不是因为代码在拦，
    // 而是光标物理上出不去屏幕——位置接口必须自己补这道守卫：把身体中心夹到可达区域内。
    const targetX = area === null ? rx * VIEW.w : area.x + rx * area.width;
    const targetY = area === null ? ry * VIEW.h : area.y + ry * area.height;
    const c = S.clampPointToRegion(area === null ? AREAS : [area], targetX, targetY);
    // 夹取后的比例才是要写进 customPos 的值：position() 会按它重算窗口位置。
    const fx = c.x / VIEW.w;
    const fy = c.y / VIEW.h;
    const px = c.x - this.halfW;
    const py = c.y - this.halfH;
    if (mode === 'instant' || (mode === 'line' && duration <= 0)) {
      this.sendBounds(px, py);
      this.customPos = { rx: fx, ry: fy };
      return;
    }
    const token = ++this.posFollowToken;
    if (mode === 'line') {
      // 直线补间：在像素空间插值——按归一化比例插值会把斜线走歪（外接矩形不是正方形）
      const fromX = this.pos.x;
      const fromY = this.pos.y;
      const t0 = performance.now();
      // 起身与落地都要有过渡：光是一条匀速直线看着像被瞬移改造过，两头加缓动才像「游过去」
      // 鱼头朝着游的方向：往右游 dir=1，往左游 dir=-1（鱼默认朝右画）
      if (this.el) this.el.style.setProperty('--swim-dir', px < fromX ? '-1' : '1');
      this.startGlide();
      const step = () => {
        if (this.posFollowToken !== token) return;
        const p = Math.min((performance.now() - t0) / duration, 1);
        if (p >= 1) {
          // 精确落位：终点不留残余偏差（弹簧那条靠收敛阈值收尾，这条靠 p 到 1）
          this.posFollow = null;
          this.sendBounds(px, py);
          this.customPos = { rx: fx, ry: fy };
          this.stopGlide();
          // 落地轻压一下：有「停住」的重感，又不至于像被拍扁（点击是 0.55 = S.SQ_SQUASH）
          this.startSquash(this.front === 0 ? this.videoA : this.videoB, 0.22);
          // 「游过来催一下」的那次，落地这一拍才让气泡再闪一遍
          if (this.pulseOnArrive) {
            this.pulseOnArrive = false;
            if (this.requestEnvelope) this.pulseBubble(this.requestEnvelope.id + ':esc');
          }
          return;
        }
        // ease-in-out（cubic）：起步慢、中途快、收尾慢
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        this.sendBounds(fromX + (px - fromX) * e, fromY + (py - fromY) * e);
        this.posFollow = requestAnimationFrame(step);
      };
      this.posFollow = requestAnimationFrame(step);
      return;
    }
    // spring：过阻尼弹簧跟随——没有行程时间，靠收敛判定自己收尾
    let last = performance.now();
    const vel = { vx: 0, vy: 0 };
    const step = () => {
      if (this.posFollowToken !== token) return;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      let x = this.pos.x;
      let y = this.pos.y;
      vel.vx = S.springStep(vel.vx, x, px, dt, this.physics.throwPower);
      vel.vy = S.springStep(vel.vy, y, py, dt, this.physics.throwPower);
      x += vel.vx * dt;
      y += vel.vy * dt;
      this.sendBounds(x, y);
      // 收敛判定：足够近且足够慢 → 精确落位并提交。拖拽跟手靠指针松手结束，这条得自己判。
      if (Math.abs(px - x) < 0.5 && Math.abs(py - y) < 0.5 && Math.abs(vel.vx) < 1 && Math.abs(vel.vy) < 1) {
        this.posFollow = null;
        this.sendBounds(px, py);
        this.customPos = { rx: fx, ry: fy };
        return;
      }
      this.posFollow = requestAnimationFrame(step);
    };
    this.posFollow = requestAnimationFrame(step);
  },

  /**
   * 抛掷指令：角度（度，0 = 正右，逆时针为正）+ 力度倍率 → 初速度，交给 startThrow；
   * 下游的重力/反弹/摩擦/落地 Q 弹/跨窗碰撞全是既有行为。
   */
  throwWith(angleDeg, power) {
    if (this.dragState.active) return; // 用户交互优先
    const v = S.throwVelocity(angleDeg, power);
    this.startThrow(this.pos.x, this.pos.y, v.vx, v.vy);
  },

  /** 被撞回调（跨窗碰撞 broker 转发）：停当前动作，从落点以新初速抛出去（全复用现有物理） */
  onDeskHit(vx, vy) {
    this.stopMove();
    this.stopDragFollow();
    this.stopThrow();
    this.startThrow(this.pos.x, this.pos.y, vx, vy);
  },

  /** Q 弹挤压：前台视频垂直压扁（贴地锚定再回弹），曲线在 shared。depth = 下压幅度
   *  （点击固定 0.55，落地按冲击速度动态取）；reduce-motion 时跳过。 */
  startSquash(el, depth = S.SQ_SQUASH) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const token = ++this.squashToken;
    if (this.squashRef !== null) cancelAnimationFrame(this.squashRef);
    const origin = el.style.transformOrigin;
    el.style.transformOrigin = 'bottom';
    const t0 = performance.now();
    const step = () => {
      if (this.squashToken !== token) return;
      const u = Math.min((performance.now() - t0) / S.SQ_DURATION_MS, 1);
      const scale = S.squashScale(u, depth);
      el.style.transform = (this.facing === 'right' ? 'scaleX(-1) ' : '') + 'scaleY(' + scale + ')';
      if (u < 1) {
        this.squashRef = requestAnimationFrame(step);
      } else {
        this.squashRef = null;
        el.style.transformOrigin = origin;
        // 恢复纯镜像（若期间 switchTo 重置过 transform，也以镜像为准）
        el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
      }
    };
    this.squashRef = requestAnimationFrame(step);
  },

  stopSquash() {
    this.squashToken++;
    if (this.squashRef !== null) {
      cancelAnimationFrame(this.squashRef);
      this.squashRef = null;
    }
  },

  // 点击 vs 拖拽（阈值/抓取偏移/释放回循环待机；移动的是窗口）
});
