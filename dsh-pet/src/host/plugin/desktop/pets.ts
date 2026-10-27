/**
 * 桌面宠物列表：按成品配置算出哪些实例参与桌面窗，并在显示档变化时刷新。
 *
 * 不拉进程、不管重启时序（归 ./spawn 与 ./sync）。
 * 依赖显式传入（见输入类型），模块内不读全局。
 * @module dsh-pet/src/host/plugin/desktop/pets
 */
import { flattenPetList, readAllConfig } from '../../config.ts';
import type { DesktopHelperDeps } from './types.ts';

/** DesktopPets的输入。 */
export type DesktopPetsInput = Pick<DesktopHelperDeps, 'configPaths' | 'effectivePetList' | 'log'>;

/**
 * 创建DesktopPets。
 */
/** 该宠物是否参与桌面模式（Electron 透明窗）。 */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

export function createDesktopPets(deps: DesktopPetsInput) {
  const { configPaths, effectivePetList, log } = deps;

  let hasDesktopPet = false;

  let trayOn = true;

  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      const merged = readAllConfig(configPaths);
      const pets = flattenPetList(merged);
      const desktopPets = pets.filter((p) => isDesktopVisible(p.display));
      hasDesktopPet = desktopPets.length > 0;
      trayOn = merged.main?.trayEnabled !== false;
      // 诊断日志（issue #168）：设置页显示「仅桌面」却没有 helper 进程时，这一行能分辨宿主读到
      // 的 display 到底是 web 还是 desktop；托盘开关同样只在这里可见。
      log.info(
        `[dsh-pet] 桌面判定：pets=${pets.length}，桌面可见=${desktopPets.length}` +
          `（${desktopPets.map((p) => String(p.id)).join(',') || '无'}）→ hasDesktopPet=${hasDesktopPet} tray=${trayOn}`,
      );
    } catch (e) {
      log.warn(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  refreshDesktop();

  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return effectivePetList()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  /** 托盘是否可见：refreshDesktop 会改它，故以取值函数对外，避免下游拿到过期快照。 */
  const getTrayOn = (): boolean => trayOn;

  return { hasDesktopPet, refreshDesktop, desktopPetList, getTrayOn };
}

/** DesktopPets的产出。 */
export type DesktopPets = ReturnType<typeof createDesktopPets>;
