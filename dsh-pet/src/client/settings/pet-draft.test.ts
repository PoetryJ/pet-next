/**
 * 「添加宠物」草稿构造（src/client/settings/pet-draft.ts）的契约测试。
 *
 * 两条契约：
 *   1. 新 id 从 pet-2 起找第一个空位，绝不覆盖已有 id；
 *   2. 新宠物用自己的 id 当名字（不继承模板名字，否则两只同名），位置深拷贝，改新宠物不污染模板。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { draftPet, nextPetId } from './pet-draft.ts';
import type { Pet } from '../../shared/types.ts';

const pet = (id: string): Pet =>
  ({ id, name: id, size: 200, position: { corner: 'bottom-right', marginX: 10, marginY: 20 } }) as unknown as Pet;

const template = {
  id: 'pet-1',
  name: '小桌宠',
  size: 260,
  balanceEnabled: true,
  whisperEnabled: false,
  workStatusEnabled: true,
  fixedEnabled: false,
  display: 'front',
  position: { corner: 'bottom-left', marginX: 40, marginY: 60 },
} as unknown as Pet;

describe('nextPetId —— 新 id 分配', () => {
  test('空列表从 pet-2 开始', () => {
    assert.equal(nextPetId([]), 'pet-2');
  });

  test('跳过已占用的 id，取第一个空位', () => {
    assert.equal(nextPetId([pet('pet-2'), pet('pet-3')]), 'pet-4');
    assert.equal(nextPetId([pet('pet-1'), pet('pet-3')]), 'pet-2');
  });

  test('不因为列表里有别的前缀就撞车', () => {
    assert.equal(nextPetId([pet('cat'), pet('pet-2')]), 'pet-3');
  });
});

describe('draftPet —— 新宠物草稿', () => {
  test('名字用自己的 id，不继承模板名字', () => {
    const draft = draftPet(template, 'pet-2');
    assert.equal(draft.id, 'pet-2');
    assert.equal(draft.name, 'pet-2');
  });

  test('拷贝模板的实例字段与位置，位置是深拷贝', () => {
    const draft = draftPet(template, 'pet-2');
    assert.equal(draft.size, 260);
    assert.equal(draft.balanceEnabled, true);
    assert.equal(draft.display, 'front');
    assert.deepEqual(draft.position, { corner: 'bottom-left', marginX: 40, marginY: 60 });

    draft.position.marginX = 1;
    assert.equal(template.position.marginX, 40, '改新宠物不能动到模板');
  });
});
