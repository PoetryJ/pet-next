/**
 * 宠物页面：单只宠物实例 PetCard 与多开容器 PetMulti。
 * 不负责配置解析与几何、物理计算：成品配置由 host 提供，纯逻辑来自 shared。
 * 依赖运行时注入的 react，以及 shared 的 state、pickers、motion、physics 等模块。
 * 必须始终成立：/state 是唯一数据源，动画与气泡都由叶子里的序号变化驱动。
 * @module dsh-pet/src/client/pet
 */
import { pick } from '../shared/pickers.ts';
import { createOwnAnimation, type OwnAnimation } from './pet/animation/animation.ts';
import { playClickSound } from './pet/click-sound.ts';
import { injectPetCss } from './pet/css.ts';
import type { PetCardProps } from './pet/card/card-props.ts';
import { makeCardView } from './pet/card/card-view.ts';
import { createBubbleSlots } from './pet/card/bubble-slots.ts';
import { createCardState } from './pet/card/card-state.ts';
import { createCueEffects } from './pet/card/cue-effects.ts';
import type { CardHub } from './pet/card/card-hub.ts';
import { createAnimationFlow, type AnimationFlow } from './pet/card/animation-flow.ts';
import { createLockFreeze } from './pet/card/lock-freeze.ts';
import { createFlight, type Flight } from './pet/motion/flight.ts';
import { createDrag, type Drag, type DragCard } from './pet/motion/drag.ts';
import { createPetMulti } from './pet/multi.ts';
import { createMenuActions, type MenuActions } from './pet/menu-actions.ts';
import { makePlaybackReporter } from './pet/playback-report.ts';
import { createPositionFollow, type PositionFollow } from './pet/motion/position-follow.ts';
import { createSquashDriver, type SquashDriver } from './pet/motion/squash.ts';
import { boxToRatio, derivePetMetrics, petRootStyle, petStageStyle } from './pet/motion/geometry.ts';
import { createWalk, type Walk } from './pet/motion/walk.ts';
// 轮询状态：页面唯一的数据来源与渲染入口，拉取、拍平、比对都在 shared。
import { postAction } from '../shared/state.ts';
import { makeBalanceBubble, makeWhisperBubble } from './bubble.ts';
import { ROUTE_PATH } from '../shared/constants.ts';
// 统一右键菜单：与桌面共用同一份组件（src/shared/menu）。
import { buildMenuTree, buildMoreBranch, displayMenuBranch, mountContextMenu, type MenuNode } from '../shared/menu.ts';
// 悬浮提示：与桌面共用样式与摆位判据。
import { TOOLTIP_GAP_RATIO, tooltipPlacement } from '../shared/tooltip.ts';
// 对话弹窗：与桌面共用组件，记忆由 host 的 /chat 读写。
import { mountChatDialog } from '../shared/chat.ts';
import { registerPose } from './pose.ts';
import { registerProgress } from './progress.ts';
// 字体换算只在 shared 一处，与桌面端共用，避免两端漂移。
import { resolveFontPx } from '../shared/fonts.ts';
import { petBridge } from './settings.ts';

// 抛掷物理：初速换算在 shared/physics.ts；飞行帧在 pet/motion/flight.ts，指针拖拽在 pet/motion/drag.ts。
import { landingSquash, throwVelocity } from '../shared/physics.ts';
import type { Animations, Pet, PhysicsParams, Weights } from '../shared/types.ts';
import type * as ReactNS from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 运行期宠物：拍平后的成品实例，条目级字段已补齐且必填。 */
export type RuntimePet = Pet & {
  animations: Animations;
  animationWeights: Weights;
  eventsRefreshSec: Record<string, number>;
  physics: PhysicsParams;
};

/** 制造宠物页面组件（工厂），返回多开容器 PetMulti。
 *  react 能力由运行时注入；容器内部渲染多个 PetCard。
 */
export function makePetUI(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）。
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;
  injectPetCss();

  /** 余额气泡：数据与显隐由 PetCard 传入。 */
  const BalanceBubble = makeBalanceBubble({ h, useState, useEffect });
  /** 碎碎念气泡：文本与显隐由 PetCard 传入。 */
  const WhisperBubble = makeWhisperBubble({ h });
  /** 三种气泡的单槽：显隐、停留计时与优先级都在这里。 */
  const useBubbleSlots = createBubbleSlots(
    { h, useState, useEffect, useRef },
    { balanceBubble: BalanceBubble, whisperBubble: WhisperBubble },
  );
  /** 占用锁的冻结驱动：叶子 → 翻转，解冻定时器在模块里。 */
  const useLockFreeze = createLockFreeze({ useEffect, useRef });
  /** 宠物卡的 DOM 结构：只拼装，不持有状态。 */
  const CardView = makeCardView({ h });
  /** 卡片的状态容器：状态与写入口分离，供指令处理与视图共用。 */
  const useCardState = createCardState({ useState, useRef });
  /** 七条指令的消费与分派。 */
  const useCueEffects = createCueEffects({ useEffect, useRef });
  /** 动画流：掷骰、播完落地、碎碎念联动。 */
  const useAnimationFlow = createAnimationFlow({ useRef });

  /** 单个宠物实例，配置由容器传入；整份 props 也交给指令处理。 */
  function PetCard(props: PetCardProps) {
    const { arena, balance, balanceManual, cfg, lock, lockTick, menuItemsRef, workStatus } = props;

    // 卡片状态容器：动画、朝向、拖拽态、提示与自定义位置；写入口在 pet/card/card-state.ts。
    const card = useCardState({
      size: cfg.size,
      anim: cfg.animations.idle[0] ?? '',
      corner: cfg.position.corner,
      margin: { x: cfg.position.marginX, y: cfg.position.marginY },
    });
    const { actions: cardActions, state: cardState } = card;
    const { anim, corner, cuePlayback, customPos, dragging, facing, margin, once, seq, size, tipOn } = cardState;
    const {
      bumpSeq,
      setAnim,
      setCorner,
      setCuePlayback,
      setCustomPos,
      setDragging,
      setFacing,
      setMargin,
      setOnce,
      setTipOn,
      setSize,
    } = cardActions;

    /**
     * 驱动实例：只建一次。
     * 帧句柄、世代号与排队状态必须跨渲染存活——重建会让 stop 停不住旧循环、onFrontReady 查错实例。
     */
    const walkRef = useRef<Walk | null>(null);
    const posFollowRef = useRef<PositionFollow | null>(null);
    const squashRef = useRef<SquashDriver | null>(null);
    const menuActionRef = useRef<MenuActions | null>(null);
    /** 悬浮提示的最新显隐：拖拽驱动的 getter 在挂载时绑定，必须读 ref 而不是状态快照。 */
    const tipOnRef = useRef(tipOn);
    tipOnRef.current = tipOn;

    // 尺寸与派生几何；度量系数在 pet/motion/geometry.ts，这里只解构使用。
    const { halfW, halfH, bottomPad, sideAllow } = derivePetMetrics(size);
    // 字号按本宠物尺寸算好注入 root，气泡与悬浮提示读它。
    const fontPx = resolveFontPx(cfg.font, size);
    // 动画池与权重已在拍平时吹入 cfg，直接读，不做回落。
    const petAnims = cfg.animations;

    const tipRef = useRef<HTMLDivElement | null>(null);
    // 三种气泡的单槽：显隐、停留计时与优先级都在 pet/card/bubble-slots.ts，这里只喂视图输入。
    const bubbles = useBubbleSlots({
      balance,
      balanceEnabled: cfg.balanceEnabled,
      balanceManual,
      workStatusEnabled: cfg.workStatusEnabled,
      workTerminal: workStatus?.state === 'success' || workStatus?.state === 'error',
      assetRoot: cfg.assetRoot,
    });
    // 右键菜单当前的 close 句柄，卸载或重开前清理。
    const menuRef = useRef<{ close: () => void } | null>(null);
    // 对话弹窗当前的 close 句柄，卸载或重开前清理。
    const chatRef = useRef<{ close: () => void } | null>(null);

    // 配置变化即时跟随，容器重新合并或设置页保存后触发。
    useEffect(() => {
      setSize(cfg.size);
      setCorner(cfg.position.corner);
      setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
      // 三个写入口是卡状态容器转出的 useState setter，身份稳定；进依赖只会让 effect 每次渲染重跑。
      // eslint-disable-next-line react-hooks/exhaustive-deps -- setter 稳定，变化原因只有这四个配置字段
    }, [cfg.size, cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);

    // DOM 与状态 refs。
    const rootRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const videoARef = useRef<HTMLVideoElement | null>(null);
    const videoBRef = useRef<HTMLVideoElement | null>(null);
    const boxPxRef = useRef<{ x: number; y: number } | null>(null);
    // Q 弹挤压：rAF 句柄与待压标记，等新动画成为前台后再压新首帧。
    squashRef.current ??= createSquashDriver({ facing: () => card.facingRef.current });
    const squash = squashRef.current;
    const pendingSquashRef = useRef(false);
    // workStatus 最新值同步：onended 闭包注册时可能早于状态更新，护栏用 ref 读当前值。
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;
    // 成品配置的最新值：动画链在回调里读它，避免捕获某一帧的配置。
    const cfgRef = useRef(cfg);
    cfgRef.current = cfg;

    // 回执在 pet/playback-report.ts：地址、请求体与失败日志都在那里，这里只要一个函数。
    const reportPlayback = makePlaybackReporter({ petId: cfg.id });

    // 动画链只造一次（放进 ref）：它持有 A/B 槽位、世代号与 blob，跨渲染重建会把这些状态清空。
    /** 动画流的转发口：动画链比它先创建，播完回调经它调用。 */
    const flowRef = useRef<AnimationFlow | null>(null);
    const ownAnimRef = useRef<OwnAnimation | null>(null);
    ownAnimRef.current ??= createOwnAnimation({
      videoA: () => videoARef.current,
      videoB: () => videoBRef.current,
      cfg: () => cfgRef.current,
      currentAnim: () => card.animRef.current,
      workStatus: () => workStatusRef.current,
      facing: () => card.facingRef.current,
      report: reportPlayback,
      clearCuePlayback: () => setCuePlayback(null),
      onFrontReady: (el) => {
        // 点击 Q 弹要等新动画就位后才压，压的是新首帧。
        if (pendingSquashRef.current) {
          pendingSquashRef.current = false;
          squash.start(el);
        }
        if (walk.hasPending()) walk.start(el);
      },
      onEnded: (cue) => flowRef.current?.applyEndedCue(cue),
      isDragging: () => drag.isActive(),
      initiallyFrozen: lock?.locked === true && lock.expiresAt > Date.now(),
    });
    const ownAnim = ownAnimRef.current;

    // 状态驱动播放。
    useEffect(() => {
      ownAnim.switchTo(anim, once, cuePlayback);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 anim/once/seq/cuePlayback 的换源身份决定；ownAnim 是稳定引用，补它没有意义
    }, [anim, once, seq, cuePlayback]);
    useEffect(() => {
      // 视口变化要按新尺寸重算根节点位置，否则改窗口大小后宠物停在旧比例上。
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      // 把本页这只宠物的实时位置与朝向注册给只读服务 petApi7340（见 ./pose）；
      // 消费者按需读闭包，拖拽、抛掷中途也能拿到当前值，不是快照。
      const unregisterPose = registerPose(cfg.id, () => ({
        x: currentCenterX() / window.innerWidth,
        y: currentCenterY() / window.innerHeight,
        facing: card.facingRef.current,
      }));
      // 播放进度走同一个 Cordis 入口（见 ./progress）；读前台 video，A/B 切换期间读 back 会跳。
      const unregisterProgress = registerProgress(cfg.id, () => {
        const el = ownAnim.frontVideo();
        const playbackId = ownAnim.playingPlayback();
        const anim = card.animRef.current;
        if (el === null) {
          // 首帧还没挂上元素，给可解析的零值，别让调用方拿到 undefined。
          return { playbackId, anim, currentTime: 0, duration: 0, paused: true, buffering: false };
        }
        // duration 在元数据就绪前是 NaN，统一成 0。
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        return {
          playbackId,
          anim,
          currentTime: el.currentTime,
          duration,
          paused: el.paused,
          buffering: el.readyState < 3 || el.seeking,
        };
      });
      return () => {
        window.removeEventListener('resize', onResize);
        unregisterPose(); // 卸载即摘除：静默失效比读到陈旧值安全。
        unregisterProgress();
        ownAnim.dispose(); // 中断在途素材请求并释放 blob，之后本实例不可复用。
        stopMove();
        drag.stopFollow();
        flight.stop();
        squash.stop();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载/卸载各跑一次：闭包读的是 refs 与稳定 props
    }, []);
    // 卸载时关闭可能开着的右键菜单与对话弹窗。
    useEffect(
      () => () => {
        if (menuRef.current) {
          menuRef.current.close();
          menuRef.current = null;
        }
        if (chatRef.current) {
          chatRef.current.close();
          chatRef.current = null;
        }
      },
      [],
    );

    // 移动系统：自主走位在 pet/motion/walk.ts，位置跟随的弹簧在 pet/motion/position-follow.ts。
    /** 当帧走位参数：走位驱动长期持有，每渲染就地更新，避免把尺寸与动画池闭包进旧实例。 */
    const motionRef = useRef({ size, halfW, halfH, sideAllow, bottomPad, moves: petAnims.moves });
    motionRef.current = { size, halfW, halfH, sideAllow, bottomPad, moves: petAnims.moves };

    /** 当前宠物中心的视口 X 坐标。 */
    const currentCenterX = () => {
      const cp = card.customPosRef.current;
      if (cp) return cp.rx * window.innerWidth;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().left + motionRef.current.halfW;
      return window.innerWidth - 24 - motionRef.current.halfW;
    };
    /** 当前宠物中心的视口 Y 坐标。 */
    const currentCenterY = () => {
      const cp = card.customPosRef.current;
      if (cp) return cp.ry * window.innerHeight;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().top + motionRef.current.halfH;
      return window.innerHeight - 20 - motionRef.current.halfH;
    };

    walkRef.current ??= createWalk({
      root: () => rootRef.current,
      center: () => ({ x: currentCenterX(), y: currentCenterY() }),
      metrics: () => motionRef.current,
      moves: () => motionRef.current.moves,
      facing: () => card.facingRef.current,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      isFlying: () => flight.isFlying(),
      play: (name) => {
        setOnce(true);
        setAnim(name);
      },
      setBox: (box) => {
        boxPxRef.current = box;
      },
      commit: setCustomPos,
    });
    const walk = walkRef.current;

    /** 停止自主走位与位置跟随。 */
    const stopMove = () => {
      walkRef.current?.stop();
      // 位置跟随的弹簧也是自主移动，停走路时必须一并停掉，否则两套运动同时改 DOM 位置。
      posFollowRef.current?.stop();
    };

    // 抛掷飞行在 pet/motion/flight.ts：重力、反弹、宠物互撞与落定提交都在那里。
    const flightRef = useRef<Flight | null>(null);
    flightRef.current ??= createFlight({
      root: () => rootRef.current,
      metrics: () => motionRef.current,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      physics: () => cfgRef.current.physics,
      arena: () => arena.current,
      petId: cfg.id,
      box: () => boxPxRef.current,
      setBox: (box) => {
        boxPxRef.current = box;
      },
      commitLive: (center) => {
        card.customPosRef.current = center;
      },
      commitFinal: setCustomPos,
      onLanding: (impactVy) => {
        // 落地 Q 弹压的是新首帧：等前台视频就位后再压。
        const frontEl = ownAnim.frontVideo();
        if (frontEl) squash.start(frontEl, landingSquash(impactVy));
      },
    });
    const flight = flightRef.current;

    /** 从给定左上角与初速起飞；先停弹簧跟随与走位，免得两套运动同时改位置。 */
    const startThrow = (px: number, py: number, vx: number, vy: number) => {
      drag.stopFollow();
      stopMove();
      flight.start(px, py, vx, vy);
    };
    /** 最新的 startThrow 引用，供碰撞回调转发，避免陈旧闭包。 */
    const startThrowLatestRef = useRef<(px: number, py: number, vx: number, vy: number) => void>(() => {});
    startThrowLatestRef.current = startThrow;

    // 位置与抛掷指令：seq 变化即执行，复用既有运动路径，不新写运动学。
    // 落位动画在 pet/motion/position-follow.ts：三种模式都在像素空间插值，世代号让迟到的帧自弃。
    posFollowRef.current ??= createPositionFollow({
      root: () => rootRef.current,
      box: () => boxPxRef.current,
      setBox: (box) => {
        boxPxRef.current = box;
      },
      commit: setCustomPos,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      half: () => ({ w: motionRef.current.halfW, h: motionRef.current.halfH }),
      spring: () => cfgRef.current.physics.throwPower,
      isDragging: () => drag.isActive(),
      takeOver: () => {
        flightRef.current?.stop();
        walkRef.current?.stop();
        posFollowRef.current?.stop();
      },
    });
    const posFollow = posFollowRef.current;

    /** 执行抛掷指令：角度（度，0 为正右，逆时针为正）与力度倍率换算成初速度，交给 startThrow。
     *  下游物理全部复用，不设死区。
     */
    const applyThrowCue = (angleDeg: number, power: number) => {
      if (drag.isActive()) return; // 用户交互优先。
      const { vx, vy } = throwVelocity(angleDeg, power);
      const box = boxPxRef.current ?? { x: currentCenterX() - halfW, y: currentCenterY() - halfH };
      startThrow(box.x, box.y, vx, vy);
    };
    /** 被撞回调：停当前动作，从落点以新初速抛出去。 */
    const onPetHit = (vx: number, vy: number) => {
      stopMove();
      drag.stopFollow();
      flight.stop();
      const bx = boxPxRef.current;
      let sx = 0;
      let sy = 0;
      if (bx) {
        sx = bx.x;
        sy = bx.y;
      } else {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) {
          sx = r.left;
          sy = r.top;
        }
      }
      startThrowLatestRef.current(sx, sy, vx, vy);
    };
    // 碰撞站场注册：getVel 取最新抛掷状态，onHit 经 ref 转发，避免陈旧闭包。
    useEffect(() => {
      const arenaSlots = arena.current.slots;
      arenaSlots[cfg.id] = {
        size,
        bottomPad,
        getBox: () => {
          if (boxPxRef.current) return boxPxRef.current;
          const r = rootRef.current?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top } : null;
        },
        getVel: () => flight.velocity(),
        onHit: onPetHit,
      };
      return () => {
        delete arenaSlots[cfg.id];
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由碰撞注册身份 cfg.id/size/bottomPad/arena 决定：onPetHit 只经 startThrowLatestRef 转发、不捕获渲染期状态；补 onPetHit（每渲染重建）会让碰撞槽每渲染注销重注册
    }, [cfg.id, size, bottomPad, arena]);

    // 悬浮提示：贴光标显示。
    /** 把提示框摆到光标右下，放不下时翻边并夹回视口。
     *  直接写 DOM style：每次鼠标移动都走 React 状态会让整个 PetCard 重渲染。
     */
    const placeTip = (clientX: number, clientY: number): void => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      const viewport = document.documentElement;
      const p = tooltipPlacement(
        { x: clientX, y: clientY },
        { w: tipEl.offsetWidth, h: tipEl.offsetHeight },
        { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight },
        motionRef.current.size * TOOLTIP_GAP_RATIO,
      );
      tipEl.style.left = p.x + 'px';
      tipEl.style.top = p.y + 'px';
    };

    // 占用锁：宿主靠内存持有，渲染端靠 /state 的 pets.<id>.lock 叶子感知。
    // 宿主不会推「锁没了」，到期时间与解冻定时器在 pet/card/lock-freeze.ts。
    // 冻结只挡自播行为：随机链、当前自播动画、自动来源的余额与工作状态、屏上的任务气泡。
    // 显式指令（say / anim / position / throw）一概不挡，那正是持锁者要保护的内容。
    const lockFreeze = useLockFreeze({
      lock,
      lockTick,
      setFrozen: ownAnim.setFrozen,
      onFrozen: () => {
        // 光堵随机链不够：它只在动画播完时调用，不暂停会把当前这段播完才停。
        stopMove();
        // 任务状态气泡：锁一生效就收掉，解冻不补亮。
        bubbles.hideWork();
      },
      onResumed: () => {
        // 解冻：非终态工作状态回档位循环，否则回 idle 一次，播完由动画链接回随机链。
        if (flowRef.current?.resumeWorkStatusAnim() ?? false) return;
        if (petAnims.idle.length) {
          setAnim(pick(petAnims.idle, card.animRef.current));
          setOnce(true);
          bumpSeq();
        }
      },
    });

    // 右键菜单：独立浮层，只在命中区拦截右键，不改动 DSH 页面自己的菜单。
    // 菜单派发在 pet/menu-actions.ts：一个叶子一次副作用，建菜单与浮层定位留在右键入口。
    menuActionRef.current ??= createMenuActions({
      petId: cfg.id,
      animations: () => cfgRef.current.animations,
      isFacingRight: () => card.facingRef.current === 'right',
      faceLeft: () => setFacing('left'),
      tryMove: walk.tryMove,
      stopMove,
      stopThrow: () => flight.stop(),
      playOnce: (anim, playbackId) => {
        setOnce(true);
        setAnim(anim);
        setCuePlayback(playbackId);
      },
      resetPosition: () => setCustomPos(null),
      openChat: () => {
        // 对话：shared 组件，记忆经 host /chat 读写，浏览器与桌面共用。
        // 弹窗贴在身体命中区右上角，视频框右上角不等于宠物右上角；超出视口夹回。
        if (chatRef.current) chatRef.current.close();
        const hitRect = stageRef.current?.querySelector('.dsh-pet-hit')?.getBoundingClientRect();
        chatRef.current = mountChatDialog({
          petId: cfg.id,
          baseUrl: ROUTE_PATH + '/chat',
          surface: 'web',
          x: hitRect ? hitRect.right + 6 : window.innerWidth - 256,
          y: hitRect ? hitRect.top + 6 : 8,
          onSent: () => {
            // 发送成功：回复已写进 /state，长轮询会立刻返回并弹气泡。
            console.info('[dsh-pet] 对话已发送 pet=' + cfg.id);
          },
          onClose: () => {
            chatRef.current = null;
          },
        });
      },
      report: reportPlayback,
      applyMerged: (merged) => petBridge.reload(merged),
      warn: (message) => console.warn(message),
    });
    const menuActions = menuActionRef.current;
    // 指针拖拽在 pet/motion/drag.ts：松手落点、弹弓、触屏长按与点击都在那里。
    /** 拖拽驱动每次事件取的当帧能力：逐渲染重建，驱动长期持有这个 getter。 */
    const dragCard = (): DragCard => ({
      petId: cfg.id,
      size: motionRef.current.size,
      halfW: motionRef.current.halfW,
      halfH: motionRef.current.halfH,
      bottomPad: motionRef.current.bottomPad,
      physics: cfgRef.current.physics,
      dragAnims: cfgRef.current.animations.drag,
      clickAnims: cfgRef.current.animations.clicks,
      idleAnims: cfgRef.current.animations.idle,
      currentAnim: card.animRef.current,
      setOnce: (on) => setOnce(on),
      playAnim: (name) => setAnim(name),
      bumpSeq: () => bumpSeq(),
      markSquash: () => {
        pendingSquashRef.current = true;
      },
      setDragging,
      resumeWork: () => flowRef.current?.resumeWorkStatusAnim() ?? false,
      stopAutonomy: () => stopMove(),
      stopFlight: () => flight.stop(),
      startFlight: startThrow,
      isFrozen: () => ownAnim.isFrozen(),
      releaseLock: () => {
        lockFreeze.release();
        void postAction(ROUTE_PATH + '/lock/release?pet=' + encodeURIComponent(cfg.id), { force: true });
      },
      grabVelocity: () => (flight.isFlying() ? flight.velocity() : null),
      playClickSound: () => playClickSound(),
      tipOn: () => tipOnRef.current,
      placeTip: (x, y) => placeTip(x, y),
      setTipOn,
      stage: () => stageRef.current,
      root: () => rootRef.current,
      box: () => boxPxRef.current,
      setBox: (box) => {
        boxPxRef.current = box;
      },
      commitPlace: (box) =>
        setCustomPos(
          boxToRatio(
            box,
            { width: window.innerWidth, height: window.innerHeight },
            { w: motionRef.current.halfW, h: motionRef.current.halfH },
          ),
        ),
    });
    const dragDriverRef = useRef<Drag | null>(null);
    dragDriverRef.current ??= createDrag(dragCard);
    const drag = dragDriverRef.current;
    const handleMenuAction = menuActions.run;

    // 共享运行时：状态容器、驱动与跨关注点动作拼成一份，指令处理按需取值。
    const hub: CardHub = {
      anims: () => cfgRef.current.animations,
      applyThrow: applyThrowCue,
      bubbles,
      card,
      cfg: () => cfgRef.current,
      isDragging: () => drag.isActive(),
      ownAnim,
      playByName: (anim, playbackId, keepFacing) => handleMenuAction({ label: anim, anim }, playbackId, keepFacing),
      posFollow,
      speak: (text, image, url, duration, anim) => flowRef.current?.speak(text, image, url, duration, anim),
      stopMotion: stopMove,
      tryWalk: walk.tryMove,
    };
    // 七条指令的分派在 pet/card/cue-effects.ts：这里只把当拍 props 交过去。
    useCueEffects(hub, props);
    // 动画流比指令处理晚一步创建：它要读工作状态，也要经 hub 说话与恢复档位。
    const flow = useAnimationFlow(hub, workStatus);
    flowRef.current = flow;
    /** 打开右键菜单。 */
    const handleContextMenu = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      // 工具项与动作树；「查看余额」无条件显示，手动请求不受开关限制。
      // 第三方菜单项收在「更多」下，0 项不出现，单 owner 单条时平铺（见 buildMoreBranch）。
      const more = buildMoreBranch(menuItemsRef.current);
      const tools: MenuNode[] = [
        { label: '查看余额', action: 'show-balance' },
        { label: '碎碎念', action: 'whisper' },
        { label: '对话', action: 'chat' },
        { label: '回到初始位置', action: 'home' },
        // 显示位置子菜单与桌面端同一份；改成不含 web 的值后本宠物会从页面消失。
        displayMenuBranch(),
      ];
      const tree: MenuNode[] = [...tools, ...buildMenuTree(petAnims), ...(more ? [more] : [])];
      if (!tree.length) return;
      e.preventDefault();
      e.stopPropagation(); // 不触碰 DSH 页面的菜单与右键处理。
      if (drag.isActive() || drag.justDragged()) return;
      flight.stop(); // 菜单弹出前停住飞行中的宠物。
      stopMove(); // 菜单悬停期间宠物不漫游。
      if (menuRef.current) menuRef.current.close();
      menuRef.current = mountContextMenu({
        tree,
        x: e.clientX,
        y: e.clientY,
        onAction: handleMenuAction,
        // 菜单被点外或 Esc 关闭时置空句柄，避免残留引用。
        onClose: () => {
          if (menuRef.current) menuRef.current = null;
        },
      });
    };

    // 渲染。
    const stageStyle = petStageStyle(dragging, bottomPad);
    const rootStyle = petRootStyle(
      customPos,
      { width: window.innerWidth, height: window.innerHeight },
      { w: halfW, h: halfH },
    );
    // 气泡单槽：三种气泡共用同一套定位，按优先级只挂一个。
    const bubbleNode = bubbles.node();
    return h(CardView, {
      rootRef,
      stageRef,
      videoARef,
      videoBRef,
      tipRef,
      corner,
      facing,
      size,
      marginX: margin.x,
      marginY: margin.y,
      fontBubblePx: fontPx.bubble,
      fontTipPx: fontPx.tip,
      rootStyle,
      stageStyle,
      bubble: bubbleNode,
      tipOn,
      name: cfg.name,
      onClick: drag.onClick,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerEnter: (e: ReactNS.PointerEvent<HTMLDivElement>) => {
        placeTip(e.clientX, e.clientY); // 先摆位再显示，否则会先在兜底坐标闪一帧。
        setTipOn(true);
      },
      onPointerLeave: () => setTipOn(false),
      onContextMenu: handleContextMenu,
    });
  }

  /** 多开容器：一次拉取成品配置，拍平后渲染多个 PetCard。 */
  const PetMulti = createPetMulti({ h, useState, useEffect, useRef }, PetCard);

  return PetMulti;
}
