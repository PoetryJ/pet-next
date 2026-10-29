/**
 * 播放状态机：换源、前后台交替、收尾、冻结与占用锁、空闲随机链。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 请求身份、世代与阶段用 shared-core 的 reducePlayback；这里只执行加载、play、清理和上报。
 * 迟到的 loadeddata 必须带上当时的 generation。pending 被清空不能当成放行条件。
 * @module dsh-pet/runtime/electron-helper/sprite-playback
 */
'use strict';

const PLAYBACK_LOAD_TIMEOUT_MS = 10000;

Object.assign(PetSprite.prototype, {
  ensurePlaybackLife() {
    if (!this.playbackLife) this.playbackLife = S.initialPlaybackState();
    return this.playbackLife;
  },

  dispatchPlayback(event) {
    const reduced = S.reducePlayback(this.ensurePlaybackLife(), event);
    this.playbackLife = reduced.state;
    const id = reduced.state.request && reduced.state.request.playbackId;
    this.playback = reduced.state.phase === 'playing' && id ? id : null;
    for (let i = 0; i < reduced.effects.length; i += 1) this.applyPlaybackEffect(reduced.effects[i]);
  },

  applyPlaybackEffect(effect) {
    if (effect.type === 'load') this.loadPlayback(effect);
    else if (effect.type === 'play') this.playPlayback(effect.generation);
    else if (effect.type === 'abort') this.abortPlayback(effect.generation);
    else if (effect.type === 'pause') {
      const el = this.front === 0 ? this.videoA : this.videoB;
      if (el) el.pause();
    } else if (effect.type === 'cleanup') {
      this.abortPlayback(this.playbackLife ? this.playbackLife.generation : 0);
      this.playbackSlot = null;
    } else if (effect.type === 'report') {
      if (effect.status === 'failed' && effect.reason !== 'play-rejected') {
        console.warn(
          '[dsh-pet] 素材加载失败 pet=' +
            this.pet.id +
            ' anim=' +
            (this.playbackAnimName || '') +
            '：' +
            effect.reason +
            '（已释放本次切换）',
        );
      }
      this.reportPlayback(effect.playbackId, effect.status, effect.reason);
    }
  },

  schedulePlayback(fn, ms) {
    if (typeof this.scheduleTimeout === 'function') return this.scheduleTimeout(fn, ms);
    return window.setTimeout(fn, ms);
  },

  clearScheduledPlayback(handle) {
    if (handle == null) return;
    if (typeof this.clearScheduledTimeout === 'function') {
      this.clearScheduledTimeout(handle);
      return;
    }
    window.clearTimeout(handle);
  },

  abortPlayback(generation) {
    if (this.playbackTimerGeneration === generation) {
      this.clearScheduledPlayback(this.playbackTimer);
      this.playbackTimer = null;
      this.playbackTimerGeneration = 0;
    }
    const slot = this.playbackSlot;
    if (!slot || slot.generation !== generation) return;
    slot.el.removeEventListener('loadeddata', slot.onReady);
    slot.el.onerror = null;
    slot.el.onended = null;
    this.playbackSlot = null;
  },

  loadPlayback(effect) {
    const generation = effect.generation;
    const request = effect.request;
    const el = this.front === 0 ? this.videoB : this.videoA;
    if (!el) {
      this.dispatchPlayback({ type: 'failed', generation, reason: 'asset-load' });
      return;
    }
    el.src = request.asset.url;
    el.loop = !request.asset.once;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = request.asset.once ? this.bindEnded(el, generation) : null;
    const onReady = () => {
      el.removeEventListener('loadeddata', onReady);
      // 世代和阶段一起看。pending 已经是 null（失败、替换或播完）时也不能把这一代救回来。
      if (!this.playbackLife || this.playbackLife.generation !== generation || this.playbackLife.phase !== 'loading')
        return;
      this.dispatchPlayback({ type: 'loaded', generation });
    };
    const onError = () => {
      if (!this.playbackLife || this.playbackLife.generation !== generation) return;
      const phase = this.playbackLife.phase;
      if (phase !== 'loading' && phase !== 'ready' && phase !== 'playing') return;
      const code = el.error && el.error.code;
      const reason = code === 2 || code === 4 ? 'asset-load' : 'decode-error';
      this.dispatchPlayback({ type: 'failed', generation, reason });
    };
    el.onerror = onError;
    this.playbackTimerGeneration = generation;
    this.playbackTimer = this.schedulePlayback(() => {
      this.playbackTimer = null;
      if (!this.playbackLife || this.playbackLife.generation !== generation || this.playbackLife.phase !== 'loading')
        return;
      this.dispatchPlayback({ type: 'failed', generation, reason: 'timeout' });
    }, PLAYBACK_LOAD_TIMEOUT_MS);
    this.playbackSlot = { generation, el, onReady };
    el.addEventListener('loadeddata', onReady);
    el.load();
    if (el.readyState >= 2) onReady();
  },

  playPlayback(generation) {
    const slot = this.playbackSlot;
    if (!slot || slot.generation !== generation) return;
    if (this.playbackTimerGeneration === generation) {
      this.clearScheduledPlayback(this.playbackTimer);
      this.playbackTimer = null;
      this.playbackTimerGeneration = 0;
    }
    const el = slot.el;
    const old = this.front === 0 ? this.videoA : this.videoB;
    el.classList.add('is-front');
    if (old && old !== el) {
      old.classList.remove('is-front');
      old.onended = null;
      old.onerror = null;
      old.pause();
    }
    this.front = this.front === 0 ? 1 : 0;
    el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
    const settle = (ok) => {
      if (!this.playbackLife || this.playbackLife.generation !== generation || this.playbackLife.phase !== 'ready')
        return;
      this.dispatchPlayback({ type: 'playResolved', generation, ok });
    };
    let played;
    try {
      played = el.play();
    } catch {
      settle(false);
      played = null;
    }
    if (played && typeof played.then === 'function') {
      played.then(
        () => settle(true),
        () => settle(false),
      );
    } else if (played !== null) {
      settle(true);
    }
    if (this.pendingSquash) {
      this.pendingSquash = false;
      this.startSquash(el);
    }
    if (this.pendingMove) this.startMoveDrive(el);
  },

  disposePlayback() {
    if (this.playbackDisposed) return;
    this.playbackDisposed = true;
    this.ensurePlaybackLife();
    this.dispatchPlayback({ type: 'dispose' });
  },

  switchTo(next, nextOnce, playbackId, url) {
    if (!next) return;
    if (this.playbackDisposed) return;
    // 素材地址两条路：url 形态直接用第三方给的完整地址（宿主已把 scheme 卡在 http/https，
    // 不经 bridge、也不拼 BASE）；name 形态按「素材根 + 名字」拼。身份含这条实际地址和 once。
    const assetUrl = url || this.assetBase + encodeURIComponent(next) + (S.ANIMATION_EXT || '.webm');
    this.playbackAnimName = next;
    const before = this.ensurePlaybackLife();
    const generation = before.generation;
    const phase = before.phase;
    this.dispatchPlayback({
      type: 'begin',
      request: { playbackId: playbackId || null, asset: { url: assetUrl, once: !!nextOnce } },
    });
    const after = this.playbackLife;
    if (after.generation === generation && after.phase === phase && this.pendingSquash) {
      // 同一当前请求的重复提交不重新加载，但点击挤压仍然落在当前前台。
      this.pendingSquash = false;
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) this.startSquash(frontEl);
    }
  },

  playOnce(name, playbackId, url) {
    this.anim = name;
    this.once = true;
    this.switchTo(name, true, playbackId, url);
  },

  // 直接播一个外部地址。单独一个方法、不复用 onMenuAction：那套是菜单语义（文字类强制朝左的镜像
  // 修正、移动类走真实位移），裸地址没有这些属性。这里只停掉漫游并换源播一次，播完回到正常动画链；
  // 地址本身同时是 pending 的防重键与日志标识。
  playUrlOnce(url, playbackId) {
    this.stopMove();
    this.playOnce(url, playbackId, url);
  },

  /**
   * 占用锁：冻结 / 解冻（与浏览器同一套语义）。
   *
   * 冻结期间只挡四件事，且都在渲染端：随机链、当前自播动画（暂停定帧）、自动来源的余额与
   * 工作状态表现（见 events.js 的 onBalanceTick / onWorkTick / showBalanceNotice）、屏上的任务
   * 状态气泡（锁生效就收掉，解冻不补亮）。
   * 显式指令（say / anim / position / throw）一概不挡——那正是占用要保护的东西。
   */
  applyFreeze(next) {
    if (this.frozen === next) return;
    this.frozen = next;
    const el = this.front === 0 ? this.videoA : this.videoB;
    const stamp = '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id;
    if (next) {
      // 停住正在播的那一段：宿主停不掉一段视频，完全静止只能由渲染端执行；只堵随机链入口不够，
      // 那个入口要等动画播完才被调用。
      this.stopMove();
      if (el) el.pause();
      // 冻结打断正在进行的点播。解冻不接回来。显式点播不走这里，仍然可以 begin。
      this.ensurePlaybackLife();
      this.dispatchPlayback({ type: 'cancel', reason: 'frozen' });
      // 任务状态气泡：锁一生效就收掉，解冻不补亮
      if (this.workTimer !== null) window.clearTimeout(this.workTimer);
      this.workTimer = null;
      this.workOn = false;
      this.renderBubble();
      console.log(stamp + ' 占用锁生效：冻结（随机链停 + 当前动画暂停 + 任务状态气泡收起）');
      return;
    }
    console.log(stamp + ' 占用锁解除：恢复');
    // 解冻：非终态工作状态回档位循环，否则回 idle 一次，播完由 handleEnded 接回随机链。
    if (this.resumeWorkStatusAnim()) return;
    if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
  },

  /**
   * 锁叶子 → 冻结 / 解冻。
   *
   * expiresAt 已经过去 = 没有锁：窗口重载后拿到的陈旧叶子必须这么判，不能只看 locked。
   * 宿主不会到点推「锁没了」，所以这里自己定时解除，两端的「到点」因此同源。
   */
  setLock(state) {
    if (this.lockTimer !== null) {
      window.clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    const expiresAt = state && state.locked === true ? state.expiresAt : 0;
    this.applyFreeze(expiresAt > Date.now());
    if (expiresAt <= Date.now()) return;
    this.lockTimer = window.setTimeout(
      () => {
        this.lockTimer = null;
        this.applyFreeze(false);
      },
      Math.max(0, expiresAt - Date.now()),
    );
  },

  // 动画链（纯逻辑在 shared）
  playIdle() {
    // 占用锁：锁生效时不掷骰。这里是随机链的唯一入口（动画播完才会走到），一句判断就把随机动画、
    // 随机转向与自主走位一起停住——宠物停在最后一帧，等持锁者的下一条指令（走 /anim，不经这里）。
    if (this.frozen) return;
    this.stopMove();
    const { animations, animationWeights } = { animations: this.animations, animationWeights: this.weights };
    const roll = Math.random();
    // 宠物固定：掷骰时把「转向 / 移动」两档权重按 0 算，随机链不再让宠物自己翻朝向或走开；
    // 菜单点播与 /anim 不走这里，不受影响。
    const k = S.rollKind(roll, animationWeights, { fixed: this.pet.fixedEnabled });
    let next;
    if (k === 'idle') {
      next = S.pick(animations.idle, this.anim);
    } else if (k === 'turn') {
      next = S.pick(animations.turn, this.anim);
    } else if (k === 'move') {
      const moved = this.tryMove();
      if (moved === false) {
        const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
        next = act.name;
      } else if (typeof moved === 'string') {
        next = moved;
      } else {
        // 已有一场移动进行中：重播当前动画，不另设（绝不加载不存在的动作）
        this.playOnce(this.anim);
        return;
      }
    } else {
      const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
      next = act.name;
    }
    this.playOnce(next);
  },

  // 双缓冲会把同一元素交给下一代，onended 在赋值时收进当时的 generation 和元素。
  bindEnded(el, generation) {
    return (event) => {
      const life = this.playbackLife;
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (!life || life.generation !== generation || life.phase !== 'playing' || frontEl !== el) return;
      if (event != null && event.currentTarget !== el) return;
      this.handleEnded();
    };
  },

  handleEnded() {
    // 播放回执：前台视频真的播完了 → 如实回 ended。放在拖拽守卫之前——「播完了」是既成事实，
    // 拖拽守卫管的是动画链怎么推进，不该影响回执的准确性。play 还没兑现时不把这一段收成 ended。
    const life = this.playbackLife;
    if (!life || life.phase !== 'playing') return;
    const generation = life.generation;
    this.dispatchPlayback({ type: 'ended', generation });
    if (!this.playbackLife || this.playbackLife.phase !== 'ended') return;
    if (this.dragState.active) return;
    // 占用锁：冻结期间动画链一律不推进，事件动画播完就停在最后一帧。下面几条路都会换源播放，
    // 而它们读的是实时 workState、与 workTick 无关，onWorkTick 的门禁拦不住——尤其「事件动画播完
    // 恢复档位」：持锁者每投一次带 anim 的气泡，说话动画播完就把工作状态动画点回来。
    // 播放回执已在上面上报，不受这一行影响。
    if (this.frozen) return;
    const { animations } = { animations: this.animations };
    // 事件动画播完：回 idle（与 drag/clicks 同分支，不进随机链）；气泡由定时器自动消失，与动画解耦
    const isEvent = S.isEventAnim(animations.events, this.anim);
    if (isEvent) {
      // 工作状态多候选档位：播完一段自动轮换到下一候选，长时间状态不单段重复；仅非终态档位轮换，
      // 终态播完即止；单候选档位由 loop 无限循环（不触发 ended，走不到这里）。
      const nonTerminal = this.workState && this.workState !== 'success' && this.workState !== 'error';
      const nextWork = nonTerminal ? S.nextWorkStatusAnim(animations.events?.workStatus ?? [], this.anim) : null;
      if (nextWork !== null) {
        console.log(
          '[dsh-pet] ' +
            new Date().toTimeString().slice(0, 8) +
            ' pet=' +
            this.pet.id +
            ' workStatus 档内轮换: ' +
            this.anim +
            ' -> ' +
            nextWork,
        );
        this.playOnce(nextWork); // 继续播一遍（once=true）→ ended 再轮换
        return;
      }
      // 非 workStatus 事件动画（余额/碎碎念）播完：workStatus 仍非终态 → 立即恢复档位循环动画，
      // 不进随机链（长事件期间状态不变，随机链会一直播到状态切换才被拉回）
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    if (animations.turn.includes(this.anim)) {
      const next = this.facing === 'left' ? 'right' : 'left';
      this.facing = next; // 立即同步：翻转后的 pickNext 用新朝向过滤 noMirror
    }
    if (animations.drag.includes(this.anim) || animations.clicks.includes(this.anim)) {
      // 互动动画播完：workStatus 非终态时恢复状态循环，否则回 idle（与浏览器同一语义）
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    this.playIdle();
  },

  // 互动/事件动画播完后恢复工作状态档位循环：非终态 → 按当前档位重选动画（避开当前段）；
  // 终态/空闲 → false 不接管，调用方走原逻辑。
  resumeWorkStatusAnim() {
    // 占用锁：冻结期间不许由这条路把工作状态动画点回来——它读的是实时 workState，与 workTick 无关，
    // 持锁者每投一次带 anim 的气泡，说话动画播完就会走到这里。解冻路径是先置 frozen=false 再调它。
    if (this.frozen) return false;
    const state = this.workState;
    if (!state || state === 'success' || state === 'error') return false;
    const pool = this.animations.events?.workStatus;
    if (!pool || pool.length === 0) return false;
    const idx = S.WORK_STATUS_INDEX[state];
    const slot = pool[idx];
    if (slot === undefined) return false;
    const name = S.pickSlot(slot, this.anim); // 避开当前正播动画（避免连续重复）
    console.log(
      '[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + this.pet.id + ' 恢复工作状态动画: ' + name,
    );
    const rotating = Array.isArray(slot) && slot.length > 1;
    if (rotating)
      this.playOnce(name); // 多候选：播完由 handleEnded 轮换
    else this.switchTo(name, false); // 单候选：无限循环
    return true;
  },

  // 漫游（rAF 驱动，动画首尾各 leadSec/tailSec 秒原地不动；几何在 shared/planMove）。
  // preferredName 传入时固定用该动画（菜单点播移动动画），否则与随机链一致随机选。
  tryMove(preferredName, playbackId) {
    if (this.moveRef !== null || this.pendingMove || this.throwRef !== null) return true;
    const moves = this.animations.moves;
    const actions = moves.actions;
    if (!actions.length) return false;
    const chosen = preferredName
      ? actions.find((a) => a.name === preferredName) || null
      : actions[Math.floor(Math.random() * actions.length)];
    if (!chosen) return false;
    const mp = Object.assign({}, moves.default, chosen.params || {});
    // 朝向 → 走路方向：只看当前 facing。turn 播完会立即同步朝向，所以这里不能再做 XOR 修正，
    // 否则方向会多翻一次（镜像朝右、人往左走）。
    const dir = this.facing === 'right' ? 1 : -1;
    const W = VIEW.w;
    const H = VIEW.h;
    const distScale = this.size / S.PET_REF_WIDTH;
    const cx = this.currentCenterX();
    const cy = this.currentCenterY();
    // 落点按显示器判定：默认走并集（能骑缝跨屏，但走不进外接矩形里的空洞）。confineToScreen 开启时
    // 只按宠物现在所在那块屏判定，屏缝与空洞一样当墙、越界那一步直接取消。抛掷是逐帧物理边界，
    // 漫游是一次性落点规划、没有反弹语义；宠物落在空洞里时 resolveRect 取最近那块屏，仍走得动。
    const wanderArea = this.confineToScreen ? S.resolveRect(AREAS, cx, cy) : null;
    const plan = S.planMove({
      cx,
      cy,
      W,
      H,
      dir,
      minDist: mp.minDist * distScale,
      maxDist: mp.maxDist * distScale,
      margin: mp.margin, // 同 position() 的 marginX/marginY：配置值不再乘 scale
      halfW: this.halfW,
      sideAllow: this.sideAllow,
      areas: wanderArea ? [wanderArea] : AREAS,
    });
    if (!plan) return false;
    this.pendingMove = { ...plan, dir, leadSec: mp.leadSec, tailSec: mp.tailSec };
    this.anim = chosen.name;
    this.once = true;
    this.switchTo(chosen.name, true, playbackId);
    return chosen.name;
  },
});
