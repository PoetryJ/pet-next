/**
 * 位置 / 抛掷指令（`POST /dsh-pet-7340/position`、`POST /dsh-pet-7340/throw`）的**纯决策层**。
 *
 * 与 ./anim 同一分工：只判定"该不该受理、受理成什么"，不碰 HTTP、不碰 S，可完全离线单测。
 *
 * 这两条接口**不引入任何新行为**：位置复用前端的弹簧跟随（目标从指针换成参数），抛掷复用前端的
 * `startThrow`（参数换算成初速度）。重力、反弹、地面摩擦、落地 Q 弹、宠物间碰撞等全部是既有
 * 行为，本层一概不管。所以这里只剩两件事：**参数校验**与**坐标夹取**。
 */

import { flattenPetList } from './config';

/** 受理失败的分类（路由原样透出给调用方，与 ./anim 用同一套词汇） */
export type MotionFailure = 'bad-request' | 'unknown-pet';

/** 位置决策结论：通过则给出最终要写进 S 的内容 */
export type PositionDecision =
  | { ok: true; petId: string; x: number; y: number; smooth: boolean }
  | { ok: false; reason: MotionFailure; message: string };

/** 抛掷决策结论 */
export type ThrowDecision =
  { ok: true; petId: string; angle: number; power: number } | { ok: false; reason: MotionFailure; message: string };

/** 夹到 0~1：归一化坐标的合法范围，**越界夹取而不是拒绝**（调用方拿响应里的实际值即可） */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 有限数字收窄：字符串 / 布尔 / NaN / Infinity 一律不算（配置里也这么判） */
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 目标宠物解析（与 ./anim 同一口径）：`?pet=` 优先，空则当前桌宠，再空兜底 `main`；
 * 该 id 必须**真实存在**，否则 `unknown-pet`——绝不猜、绝不退到列表第一只。
 */
function resolvePet(
  cfg: Record<string, Record<string, unknown>>,
  requested: string,
  active: string,
): { ok: true; petId: string } | { ok: false; reason: MotionFailure; message: string } {
  const petId = String(requested || active || 'main');
  if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) {
    return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
  }
  return { ok: true, petId };
}

/**
 * 把外部给的位置请求核对成一个结论。
 *
 * `x`/`y` 是宠物**中心**的归一化坐标（0~1）。选中心而不是左上角：前端持久位置 `customPos`
 * 存的就是中心（`rx = (px + halfW) / W`），且调用方不必知道宠物多大。
 * `smooth` 缺省 `true`——瞬移看起来像 bug；显式 `false` 才立即到位。
 */
export function decidePosition(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  active: string;
  x: unknown;
  y: unknown;
  /** 可选：缺省（`undefined`）按 `true` 处理——只有严格 `false` 才是"立即到位" */
  smooth?: unknown;
}): PositionDecision {
  const x = finite(args.x);
  if (x === null) return { ok: false, reason: 'bad-request', message: 'x 必须是有限数字' };
  const y = finite(args.y);
  if (y === null) return { ok: false, reason: 'bad-request', message: 'y 必须是有限数字' };

  const pet = resolvePet(args.cfg, args.requested, args.active);
  if (!pet.ok) return pet;

  return { ok: true, petId: pet.petId, x: clamp01(x), y: clamp01(y), smooth: args.smooth !== false };
}

/**
 * 把外部给的抛掷请求核对成一个结论。
 *
 * `angle` 单位度，`0` = 正右、**逆时针为正**（屏幕坐标 y 向下，所以这是数学惯例而非屏幕惯例：
 * "往上抛"写 90）。这里**不做角度归一化**——前端换算成 vx/vy 时 sin/cos 对任意实数都成立。
 *
 * `power` 是力度倍率（`1.0` = 1200 px/s 软钳速**前**，实际初速会被既有软上限压到约 1021）。
 * **不设死区**：拖拽松手时低于 500 px/s 算"温柔放下"，那是拖拽语义；接口是明确命令，再小也照抛。
 */
export function decideThrow(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  active: string;
  angle: unknown;
  power: unknown;
}): ThrowDecision {
  const angle = finite(args.angle);
  if (angle === null) return { ok: false, reason: 'bad-request', message: 'angle 必须是有限数字' };
  const power = finite(args.power);
  if (power === null || power <= 0) {
    return { ok: false, reason: 'bad-request', message: 'power 必须是大于 0 的有限数字' };
  }

  const pet = resolvePet(args.cfg, args.requested, args.active);
  if (!pet.ok) return pet;

  return { ok: true, petId: pet.petId, angle, power };
}
