/**
 * 抛掷飞行：重力、边缘反弹与落地摩擦，飞行中只改 DOM 位置，落定后才提交 normalized 中心。
 * 不负责起点与初速（拖拽松手、抛掷指令与宠物互撞各自决定），也不负责落地挤压的动画本身。
 * 依赖注入的取值函数与物理参数；rAF 句柄与飞行状态由本模块持有。
 * 不变量：每帧先积分、再处理互撞、最后写 DOM 与提交位置；落定那一帧才调 commitFinal。
 * @module dsh-pet/src/client/pet/motion/flight
 */
import {
  bodyPixelBox,
  collidePet,
  rectsOverlap,
  throwBounds,
  throwStep,
  throwSubsteps,
  type PetCollisionSlot,
  type ThrowState,
} from '../../../shared/physics.ts';
import type { BoxPoint, Center, Viewport } from './geometry.ts';
import type { PhysicsParams } from '../../../shared/types.ts';

/** 飞行需要的当帧几何（px）。 */
export interface FlightMetrics {
  /** 宠物宽度。 */
  size: number;
  /** 盒半宽。 */
  halfW: number;
  /** 盒半高。 */
  halfH: number;
  /** 身体相对视频盒左右各留的透明边。 */
  sideAllow: number;
  /** 舞台脚底垫高：互撞用的身体框按它上移。 */
  bottomPad: number;
}

/** 飞行驱动的依赖：全部用取值函数，避免捕获渲染期的快照。 */
export interface FlightDeps {
  /** 宠物根节点；`null` 表示还没挂载。 */
  root(): HTMLDivElement | null;
  /** 当帧几何。 */
  metrics(): FlightMetrics;
  /** 当前视口尺寸。 */
  viewport(): Viewport;
  /** 该宠物的物理参数。 */
  physics(): PhysicsParams;
  /** 宠物间碰撞站场。 */
  arena(): { slots: Record<string, PetCollisionSlot> };
  /** 本宠物 id：碰撞时用来跳过自己。 */
  petId: string;
  /** 当前包围盒位置。 */
  box(): BoxPoint | null;
  /** 写回包围盒位置（每帧调用）。 */
  setBox(box: BoxPoint): void;
  /** 每帧写回归一化中心：刷新或重渲染时按它重排位置，不能用 React 状态（会慢一拍）。 */
  commitLive(center: Center): void;
  /** 落定后提交归一化中心，交给 React 收尾。 */
  commitFinal(center: Center): void;
  /** 落地挤压：入参是本帧落地前的竖直速度（冲击速度）。 */
  onLanding(impactVy: number): void;
}

/** 飞行驱动：一个宠物一个实例。 */
export interface Flight {
  /**
   * 从给定左上角与初速起飞。
   *
   * @param px - 包围盒左边缘（px）。
   * @param py - 包围盒上边缘（px）。
   * @param vx - 水平初速（px/s）。
   * @param vy - 竖直初速（px/s）。
   */
  start(px: number, py: number, vx: number, vy: number): void;
  /** 停飞：取消在跑的帧并清空飞行状态。 */
  stop(): void;
  /** 是否在飞。 */
  isFlying(): boolean;
  /** 最近一帧的速度；没在飞时为 0。 */
  velocity(): { vx: number; vy: number };
}

/** 一帧积分的产出：状态加两个标志。 */
type FlightStep = ReturnType<typeof throwStep>;

/** 抛掷边界：由视口与宠物尺寸算出。 */
type FlightBounds = ReturnType<typeof throwBounds>;

/**
 * 一帧的细分积分。
 *
 * 一帧可能跨过上百 px，不拆会跳过落地与反弹帧，漏掉落地挤压与落定判定。
 *
 * @param state - 本帧起点的飞行状态。
 * @param dt - 本帧时长（秒）。
 * @param bounds - 碰撞边界。
 * @param physics - 物理参数。
 * @returns 本帧终点的状态，附带是否碰边与是否落定。
 */
function integrate(state: ThrowState, dt: number, bounds: FlightBounds, physics: PhysicsParams): FlightStep {
  const substeps = throwSubsteps(state.vx, state.vy, dt);
  let res = throwStep(state, dt / substeps, bounds, physics);
  for (let i = 1; i < substeps && !res.atRest; i++) res = throwStep(res, dt / substeps, bounds, physics);
  return res;
}

/**
 * 造飞行驱动。
 *
 * @param deps - 取几何、写位置与落地回调。
 * @returns 可反复调用的驱动。
 */
export function createFlight(deps: FlightDeps): Flight {
  /** 在跑的 rAF；`null` = 没在飞。 */
  let frame: number | null = null;
  /** 世代号：起飞或停飞 +1，迟到的帧据此自弃。 */
  let token = 0;
  /** 最近一帧的飞行状态；`null` = 没在飞。 */
  let state: ThrowState | null = null;

  const stop = (): void => {
    token++;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    state = null;
  };
  /**
   * 宠物互撞：飞行方按动量弹开，被撞方回调以新初速抛出。
   *
   * @param current - 当前飞行状态。
   * @param metrics - 当帧几何。
   * @returns 碰撞后的状态；没撞上时原样返回。
   */
  const resolveCollisions = (current: ThrowState, metrics: FlightMetrics): ThrowState => {
    const slots = deps.arena().slots;
    const myBody = bodyPixelBox({ x: current.x, y: current.y, size: metrics.size, bottomPad: metrics.bottomPad });
    for (const slotId of Object.keys(slots)) {
      if (slotId === deps.petId) continue;
      const slot = slots[slotId];
      const otherBox = slot.getBox();
      if (!otherBox) continue;
      const otherBody = bodyPixelBox({ x: otherBox.x, y: otherBox.y, size: slot.size, bottomPad: slot.bottomPad });
      if (!rectsOverlap(myBody, otherBody)) continue;
      const vel = slot.getVel();
      const hit = collidePet(
        { x: current.x, y: current.y, vx: current.vx, vy: current.vy, size: metrics.size },
        { x: otherBox.x, y: otherBox.y, vx: vel.vx, vy: vel.vy, size: slot.size },
      );
      if (!hit) continue;
      // 飞行方按动量继续弹开；被撞方回调，以新初速抛出去。一帧只处理一次，避免连锁抖动。
      slot.onHit(hit.hvx, hit.hvy);
      return { x: current.x, y: current.y, vx: hit.fvx, vy: hit.fvy };
    }
    return current;
  };

  const start = (px: number, py: number, vx: number, vy: number): void => {
    const metrics = deps.metrics();
    const viewport = deps.viewport();
    const physics = deps.physics();
    const bounds = throwBounds({
      W: viewport.width,
      H: viewport.height,
      size: metrics.size,
      sideAllow: metrics.sideAllow,
    });
    const own = ++token;
    let current: ThrowState = { x: px, y: py, vx, vy };
    let last = performance.now();
    let prevGrounded = false; // 落地挤压只在空中到地面的转换帧触发一次。
    const rootEl = deps.root();

    /** 写回本帧位置：DOM、包围盒与归一化中心（后者供重渲染时按它重排）。 */
    const commitPose = (res: FlightStep): Center => {
      if (rootEl) {
        rootEl.style.left = res.x + 'px';
        rootEl.style.top = res.y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      deps.setBox({ x: res.x, y: res.y });
      const center = { rx: (res.x + metrics.halfW) / viewport.width, ry: (res.y + metrics.halfH) / viewport.height };
      deps.commitLive(center);
      return center;
    };

    const step = (): void => {
      if (token !== own) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const fallingVy = current.vy; // 本帧积分前的竖直速度，即落地冲击速度。
      const res = integrate(current, dt, bounds, physics);
      current = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      if (physics.petCollision) current = resolveCollisions(current, metrics);
      state = current;
      const center = commitPose(res);
      // 落地挤压：只在空中到地面的转换帧触发，力度随冲击速度。
      const grounded = res.y >= bounds.maxY - 1;
      if (res.bounced && grounded && !prevGrounded) deps.onLanding(fallingVy);
      prevGrounded = grounded;
      if (res.atRest) {
        frame = null;
        state = null;
        deps.commitFinal(center);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  return {
    isFlying: () => frame !== null,
    start,
    stop,
    velocity: () => (frame !== null && state !== null ? { vx: state.vx, vy: state.vy } : { vx: 0, vy: 0 }),
  };
}
