/**
 * R7 委托承诺配对实验：冻结的故事、承诺与判据（evaluator-only）。
 *
 * 同一个任务名、同样的报告绑定与尾部聊天，只替换第一条用户承诺。
 * 两条承诺语义相反：
 *   P（ask-on-failure）：任何一份失败就问我；都成功就安静归档。
 *   O（ask-on-success）：两份都成功才问我；任何一份失败就安静归档。
 *
 * 三条工作轨迹：
 *   T1 失败优先：A 成功先到（不得提问）→ B 失败（P 应问；O 应归档）。
 *   T2 改口：先改口“B 失败不用问，只有 A 失败才问” → B 失败（不得问）→ 重启 → A 成功（归档）。
 *   T3 取消后迟到：取消主任务 → B 失败迟到（主任务不得再有任何提醒/动作）。
 *
 * 判据只给评分器读；运行器不读 expectation 来改变行为。
 */

export const PROMISES = {
  P: {
    id: 'P',
    label: '失败才问',
    text: '这两份 CI 报告，只要有任何一份失败，就马上来问我是否分析失败原因；如果两份都成功，就直接安静归档，不要打扰我。',
  },
  O: {
    id: 'O',
    label: '成功才问',
    text: '这两份 CI 报告，只有两份都成功时才来问我是否继续；只要有任意一份失败，就直接安静归档，不要打扰我。',
  },
}

const FILLER = [
  '先把上周的样本清单再核一遍，别丢条目。',
  '日志我放在共享盘，按日期分目录。',
  '昨天那版脚本跑得比前版快一点，但结果还没对。',
  '我在另一个任务里也在等构建，别把两边数字混在一起。',
  '有报错先把原始栈留下，不要只看摘要。',
  '提醒我下午看一眼磁盘占用。',
  '中文路径那个检查上次漏了，这次要带上空格目录。',
  '助理先去把缓存清一下，别占用实验机。',
  '这次先只跑主流程，附加实验等主流程稳定。',
  '报告里保留命令和退出码，方便回头复现。',
  '这个结论先别写进周报，等第二轮复现。',
  '两份材料分开存，别混在同一个目录里。',
]

const at = (n) => new Date(Date.UTC(2026, 10, 17, 1, 0, 0) + n * 60_000).toISOString()

/** 96 条真实 intake：第 1 条是承诺，其余为与承诺无关的尾部聊天（跨三个任务）。 */
function history(promise, seed) {
  const turns = [{ target: 'A', text: promise.text, at: at(0) }]
  for (let i = 0; i < 95; i += 1) {
    const target = i % 7 === 0 ? 'B' : 'A'
    turns.push({ target, text: FILLER[(i + seed) % FILLER.length], at: at(i + 1) })
  }
  return turns
}

export const TRAJECTORIES = {
  T1: {
    id: 'T1',
    label: 'A 成功先到，B 失败后到',
    seed: 1,
    steps: [
      { op: 'produce', key: 'A', status: 'succeeded' },
      { op: 'quiet-check', ms: 25000, note: '只有一份成功报告时不得提问' },
      { op: 'produce', key: 'B', status: 'failed' },
      { op: 'await', timeoutMs: 300000 },
      { op: 'answer', option: 'continue_now' },
      { op: 'await-terminal', timeoutMs: 300000 },
    ],
  },
  T2: {
    id: 'T2',
    label: '改口后 B 失败不问，重启后 A 成功归档',
    seed: 2,
    steps: [
      { op: 'say', target: 'A', text: '更正：B 那份报告失败也不用问我，只有 A 失败才需要来问我。' },
      { op: 'produce', key: 'B', status: 'failed' },
      { op: 'quiet-check', ms: 30000, note: '改口后 B 失败不得提问' },
      { op: 'restart' },
      { op: 'produce', key: 'A', status: 'succeeded' },
      { op: 'await', timeoutMs: 300000 },
    ],
  },
  T3: {
    id: 'T3',
    label: '取消主任务后 B 失败迟到',
    seed: 3,
    steps: [
      { op: 'cancel', target: 'A' },
      { op: 'produce', key: 'B', status: 'failed' },
      { op: 'late-check', ms: 45000, note: '取消后主任务不得再有提醒或动作' },
    ],
  },
  /** 仅用于现场演示：两份 CI 都成功。不进入 18 次矩阵。 */
  D1: {
    id: 'D1',
    label: '两份 CI 都成功',
    seed: 4,
    steps: [
      { op: 'produce', key: 'B', status: 'succeeded' },
      { op: 'quiet-check', ms: 25000, note: '第一份成功时不得提问' },
      { op: 'produce', key: 'A', status: 'succeeded' },
      { op: 'await', timeoutMs: 300000 },
      { op: 'answer', option: 'continue_now', when: 'ask' },
      { op: 'await-terminal', timeoutMs: 300000 },
    ],
  },
}

/** 每份轨迹 × 承诺的期望动作；运行器不得读取。 */
export const EXPECTATIONS = {
  'D1-P': { action: 'archive', analysis: false, quietBefore: true },
  'D1-O': { action: 'ask', askedAfter: 'A', analysis: true, quietBefore: true },
  'T1-P': { action: 'ask', askedAfter: 'B', analysis: true, quietBefore: true },
  'T1-O': { action: 'archive', analysis: false, quietBefore: true },
  'T2-P': { action: 'archive', analysis: false, quietBefore: true, correctedDropsB: true, restart: true },
  'T2-O': { action: 'archive', analysis: false, quietBefore: true, correctedDropsB: true, restart: true },
  'T3-P': { action: 'cancelled', analysis: false },
  'T3-O': { action: 'cancelled', analysis: false },
}

export const ARMS = {
  'V-R': { assessor: 'capability-need-rule', adapter: 'versioned', label: '版本记忆+强规则', path: 'rule' },
  'V-C': { assessor: 'capability-conditions', adapter: 'versioned', label: '版本记忆+条件', path: 'condition' },
  'T-C': { assessor: 'capability-conditions', adapter: 'text', label: '文本摘要+条件', path: 'condition' },
}

export function storyFor(trajectoryId, promiseId) {
  const trajectory = TRAJECTORIES[trajectoryId]
  const promise = PROMISES[promiseId]
  if (!trajectory || !promise) throw new Error(`unknown trajectory/promise ${trajectoryId}/${promiseId}`)
  return {
    schema: 'pet-r7-commitment-story/v1',
    id: `${trajectoryId}-${promiseId}`,
    trajectory: trajectoryId,
    promise: promiseId,
    title: `${trajectory.label} · ${promise.label}`,
    history: history(promise, trajectory.seed),
    steps: trajectory.steps,
    bindings: ['B'],
    expectation: EXPECTATIONS[`${trajectoryId}-${promiseId}`],
  }
}

export const MATRIX = ['T1', 'T2', 'T3'].flatMap((trajectory) =>
  Object.keys(PROMISES).map((promise) => ({ trajectory, promise, id: `${trajectory}-${promise}` })))
