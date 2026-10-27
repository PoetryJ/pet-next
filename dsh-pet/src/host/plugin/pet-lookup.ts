/**
 * 宠物定位与访问守卫：按 ?pet= 找实例、按 surface 判占用锁，并给出可直接返回的失败应答。
 *
 * 不读配置以外的介质，只经 onChange 同步锁状态到 S。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/pet-lookup
 */
import { LockStore } from '../lock.ts';
import { PoseStore } from '../pose.ts';
import { SURFACE_TEXT, displayCovers, normalizeSurface, type Surface } from '../surface.ts';
import { type RouteResult } from '../http.ts';
import { failResult } from '../routes/result.ts';
import { findPetInstance } from '../config.ts';
import type { HostSetup } from './setup.ts';

/** 宠物定位与访问守卫的输入：装配期对象与更早的工厂。 */
export type PetLookupInput = {} & Pick<HostSetup, 'state'>;

/**
 * 创建宠物定位与访问守卫。
 */
export function createPetLookup(deps: PetLookupInput) {
  const { state } = deps;
  // 占用锁（issue #122 第 4 项）：内存态一把锁 + TTL，第三方联动期间独占这只宠物——除持锁者外
  // 随机链、碎碎念、余额、工作状态一概让路。
  // 它自己不带定时器：过期是懒判的，叶子里的 `expiresAt` 是唯一真相，渲染端据此自己解除静止；
  // 这里只负责把状态变化同步进 S 的 `pets.<id>.lock`。
  const lock = new LockStore({
    onChange: (petId, data) => state.writePet(petId, 'lock', data),
  });

  // 实况快照（issue #122 第 1 条）：桌面渲染端变化时上报，第三方用 GET /pose 读。
  // 网页端不走这里——它的位置天生每个页面一份，走页面内的 Cordis 服务 `petApi7340`。
  const pose = new PoseStore();

  /**
   * `?surface=` 的参数级校验（缺省 / 非法 → `bad-request`）。放在读盘之前：必然失败的请求不碰磁盘；
   * 通过则给出收窄后的取值。
   */
  const surfaceParam = (params: URLSearchParams): { ok: true; want: Surface } | { ok: false; res: RouteResult } => {
    const want = normalizeSurface(params.get('surface'));
    if (want !== null) return { ok: true, want };
    return { ok: false, res: failResult('bad-request', SURFACE_TEXT) };
  };

  /**
   * `?surface=` 与该宠物 `display` 的对齐校验：不满足 → `pet-not-displayed`，并把实际 display
   * 原样回给调用方；放行回 null。
   * 这是前置校验，不是按面分发——指令照旧写进同一个叶子、两端内容完全一致。
   */
  const surfaceMismatch = (pet: Record<string, unknown>, petId: string, want: Surface): RouteResult | null => {
    const display = String(pet.display ?? '');
    if (displayCovers(want, display)) return null;
    return failResult('pet-not-displayed', petId + ' 的显示模式是 ' + display + '，不满足 surface=' + want, {
      display,
    });
  };

  /**
   * 决策函数之后的 surface 校验（/anim、/broadcast、/bubble/clear、/position、/throw 共用）：
   * 这几条的 pet 解析住在各自决策模块里，所以按 petId 再查一次实例取 display。
   * 位置与 lockBlocked 一致——都在决策函数之后、任何副作用之前，顺序是「body → pet → surface → 锁」。
   */
  const surfaceBlocked = (
    cfg: Record<string, Record<string, unknown>>,
    petId: string,
    params: URLSearchParams,
  ): RouteResult | null => {
    const p = surfaceParam(params);
    if (!p.ok) return p.res;
    return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, p.want);
  };

  /**
   * 路由层的 pet 参数解析（/lock、/lock/release、/whisper、/chat 用；其余动作端点的同一套校验
   * 住在各自决策模块里，口径一致）：必填且必须真实存在。
   *
   * 两种失败分开报：没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
   * 绝不默认退到列表第一只——落点会随用户 /pet 操作漂移，失败也不报，第三方无从预期。
   *
   * `cfg` 传惰性读取：pet 空串时不必碰磁盘（routes.test.ts 的「配置不可达」断言靠这个顺序钉住）。
   * `opts.surface` 只对会产生渲染端可见效果的端点开；/lock/release 与 /chat 的 GET 不开——
   * 释放必须永远能成功，读记忆与显示在哪一端无关。
   */
  const requirePet = (
    params: URLSearchParams,
    cfg: () => Record<string, Record<string, unknown>>,
    opts?: { surface?: boolean },
  ):
    | { ok: true; petId: string; entry: string; conf: Record<string, unknown>; pet: Record<string, unknown> }
    | { ok: false; res: RouteResult } => {
    const fail = (reason: 'pet-required' | 'unknown-pet', message: string): { ok: false; res: RouteResult } => ({
      ok: false,
      res: failResult(reason, message),
    });
    const petId = String(params.get('pet') ?? '').trim();
    if (!petId) return fail('pet-required', 'pet 必填：要指定操作哪只桌宠');
    // surface 分两步：参数级校验在读盘之前（必然失败的请求不碰磁盘），显示模式校验在找到宠物之后。
    let want: Surface | null = null;
    if (opts?.surface === true) {
      const p = surfaceParam(params);
      if (!p.ok) return { ok: false, res: p.res };
      want = p.want;
    }
    // 一次查找同时给出「存在性」与「所属条目」（entry 即素材根，/chat 读记忆分桶要用）+ 条目配置
    // （/chat 取 chatMemoryRounds 要用）——调用方拿到的就是校验时那份快照里的值，不必再查一次。
    const found = findPetInstance(cfg(), petId);
    if (!found) return fail('unknown-pet', '没有这只桌宠：' + petId);
    if (want !== null) {
      const mismatch = surfaceMismatch(found.pet, petId, want);
      if (mismatch) return { ok: false, res: mismatch };
    }
    return { ok: true, petId, entry: found.entry, conf: found.conf, pet: found.pet };
  };

  /**
   * 动作端点的占用门禁（/anim、/broadcast、/position、/throw、/bubble/clear 共用）：放行回 null。
   * 无锁时按「有没有带 lock」分流：没带 → 放行（既有调用方零改动）；带了但查不到 → `lock-lost`。
   * 位置在决策函数之后：petId 要先解析出来才知道问哪只宠物的锁，而那时还没有任何副作用。
   */
  const lockBlocked = (petId: string, params: URLSearchParams): RouteResult | null => {
    const g = lock.gate(petId, String(params.get('lock') ?? ''));
    if (g.ok) return null;
    return failResult(g.reason, g.message, g.reason === 'lock-lost' ? { cause: g.cause } : undefined);
  };
  return { lock, pose, surfaceBlocked, requirePet, lockBlocked };
}
/** 宠物定位与访问守卫的产出（供下游工厂按需 Pick）。 */
export type PetLookup = ReturnType<typeof createPetLookup>;
