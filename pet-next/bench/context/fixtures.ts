/**
 * M3-4 冻结 fixtures：3 场景 × 3 轮的用户文本与观测点（2026-11-03 冻结，禁止按结果换题）。
 * 每场景 on/off 两臂使用完全相同的用户文本；S3 两臂第三问前执行同一 reset 事件。
 * 预期观测点只描述“上下文管道语义是否被模型利用”，评分细则归 bench/context/review（D 持）。
 */
import { createHash } from 'node:crypto';

export interface ScenarioFixture {
  /** 场景代号（进账本与证据，不可改）。 */
  id: 'S1' | 'S2' | 'S3';
  /** 场景主题（人读）。 */
  title: string;
  /** 三轮用户文本（两臂相同）。 */
  turns: [string, string, string];
  /** 第三问前是否 reset（S3 两臂同一事件）。 */
  resetBeforeThird: boolean;
  /** 观测点：第三问回复文本的人工检查关键词（D 评分参考，非自动判卷）。 */
  probe: { expectKeywordsOnArmUsedContext: string[]; mustNotAppearWhenNoContext: string[] };
}

export const SCENARIOS: readonly ScenarioFixture[] = [
  {
    id: 'S1',
    title: '姓名延续',
    turns: ['你好，我叫林小满，请记住我的名字。', '我今天走了八千步，有点累。', '还记得我叫什么名字吗？'],
    resetBeforeThird: false,
    probe: { expectKeywordsOnArmUsedContext: ['林小满'], mustNotAppearWhenNoContext: [] },
  },
  {
    id: 'S2',
    title: '偏好纠正',
    turns: ['我最喜欢的颜色是绿色。', '刚才说错了，其实我最喜欢的是橙色，不是绿色。', '我现在最喜欢的颜色是什么？'],
    resetBeforeThird: false,
    probe: { expectKeywordsOnArmUsedContext: ['橙'], mustNotAppearWhenNoContext: [] },
  },
  {
    id: 'S3',
    title: 'reset 后不保留旧信息',
    turns: ['我养了一只猫，名字叫豆包。', '豆包今年三岁了。', '我养的宠物叫什么名字？'],
    resetBeforeThird: true,
    probe: { expectKeywordsOnArmUsedContext: [], mustNotAppearWhenNoContext: ['豆包'] },
  },
] as const;

/** 固定执行顺序（预先交错冻结；禁止根据结果重排/重跑）。 */
export const PLAN: readonly { case: 'S1' | 'S2' | 'S3'; arm: 'off' | 'on' }[] = [
  { case: 'S1', arm: 'off' },
  { case: 'S1', arm: 'on' },
  { case: 'S2', arm: 'off' },
  { case: 'S2', arm: 'on' },
  { case: 'S3', arm: 'off' },
  { case: 'S3', arm: 'on' },
] as const;

export function fixturesHash(): string {
  return createHash('sha256').update(JSON.stringify({ SCENARIOS, PLAN })).digest('hex');
}
