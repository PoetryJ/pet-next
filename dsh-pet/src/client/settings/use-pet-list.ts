/**
 * 设置页的宠物列表状态：编辑列表（可增删改）与当前选中项，以及「哪只被选中」的所有权。
 * 列表初值来自容器拍平的成品，加载完成前先显示它；`replace` 供加载与同步后整体刷新。
 * 删除要确认，所以这里只发「请求删除」，真的删由调用方在弹窗确认后调 `remove`。
 * @module dsh-pet/src/client/settings/use-pet-list
 */
import type { Pet } from '../../shared/types.ts';
import type { DialogState } from './dialog.ts';
import { petBridge } from './bridge.ts';
import { draftPet, nextPetId } from './pet-draft.ts';
import type { PetPatch } from './pet-card.ts';
import type { SettingsRuntime } from './runtime.ts';

/** 宠物列表状态与操作。 */
export interface PetList {
  /** 可编辑的宠物列表（不含 pet/ 目录里的文件宠物）。 */
  pets: Pet[];
  /** 当前选中的宠物 id。 */
  selId: string;
  /** pet/ 目录里由文件定义的宠物数量，只用于标题提示。 */
  extraCount: number;
  /** 切到另一只。 */
  select: (id: string) => void;
  /** 改选中宠物的字段。 */
  update: (patch: PetPatch) => void;
  /** 按模板加一只并选中它。 */
  add: () => void;
  /** 请求删除当前宠物（交给弹窗确认）。 */
  requestRemove: () => void;
  /** 确认后真的删除；只剩一只时由调用方拦住。 */
  remove: () => void;
  /** 用成品里的列表整体替换（加载 / 同步后），尽量保持当前选中项。 */
  replace: (pets: Pet[]) => void;
}

/**
 * 管理宠物列表状态。
 *
 * @param rt - 只用到 `useState` 与 `useCallback`。
 * @param requestDialog - 打开确认弹窗（`lastOne` 或 `remove`）。
 * @returns 列表状态与全部操作。
 */
export function usePetList(
  rt: Pick<SettingsRuntime, 'useState' | 'useCallback'>,
  requestDialog: (dialog: DialogState) => void,
): PetList {
  const { useState, useCallback } = rt;
  // 初值取容器拍平的成品：加载完成前先显示这份，避免整页闪空白。
  const initial = petBridge.current.filter((pet) => !pet.extra);
  const [pets, setPets] = useState<Pet[]>(initial.map((pet) => ({ ...pet, position: { ...pet.position } })));
  const [selId, setSelId] = useState<string>(initial[0]?.id ?? '');
  const extraCount = petBridge.current.filter((pet) => pet.extra).length;

  // 更新选中的宠物：size 走顶层；position 子字段整体替换
  const update = (patch: PetPatch): void =>
    setPets((list) =>
      list.map((pet) => {
        if (pet.id !== selId) return pet;
        const { position: posPatch, ...rest } = patch;
        return { ...pet, ...rest, position: posPatch ? { ...pet.position, ...posPatch } : pet.position };
      }),
    );

  const add = (): void => {
    const template = petBridge.template;
    if (!template) return;
    const id = nextPetId(pets);
    setPets((list) => [...list, draftPet(template, id)]);
    setSelId(id);
  };

  const remove = (): void => {
    const list = pets.filter((pet) => pet.id !== selId);
    setPets(list);
    setSelId(list[0]?.id ?? '');
  };

  // 只有 setState，跨渲染稳定：放进 applyConfig 的依赖里不会反复重拉配置。
  const replace = useCallback((loaded: Pet[]): void => {
    setPets(loaded);
    setSelId((id) => (loaded.some((pet) => pet.id === id) ? id : (loaded[0]?.id ?? '')));
  }, []);

  return {
    pets,
    selId,
    extraCount,
    select: setSelId,
    update,
    add,
    requestRemove: () => requestDialog({ kind: pets.length <= 1 ? 'lastOne' : 'remove' }),
    remove,
    replace,
  };
}
