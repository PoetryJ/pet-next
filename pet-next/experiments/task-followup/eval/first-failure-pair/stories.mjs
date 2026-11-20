/**
 * R8 配对故事：四组 × 两条承诺 × 三臂 = 24 次。
 * 运行器只读 history/steps；expectation 仅供独立评分。
 * 自然措辞与开发九格不同；不把故事名/oracle 送入编译器。
 */

const FILLER = [
  '共享盘的日志按日期分目录，别混在一起。',
  '昨天那版脚本快一点，但结果还没对。',
  '另一个任务也在等构建，数字不要合并。',
  '有报错先把原始栈留下，不要只看摘要。',
  '下午提醒我看一眼磁盘占用。',
  '中文路径这次要带上空格目录。',
  '缓存先清一下，别占着实验机。',
  '这轮先只跑主流程，附加实验等稳定。',
  '报告里保留命令和退出码，方便复现。',
  '这个结论先别写进周报，等第二轮。',
  '两份材料分开存，别放同一个目录。',
  '把上周的样本清单再核一遍，别丢条目。',
]

const at = (n) => new Date(Date.UTC(2026, 10, 20, 2, 0, 0) + n * 60_000).toISOString()

function history(promiseText, seed) {
  const turns = [{ target: 'A', text: promiseText, at: at(0) }]
  for (let i = 0; i < 95; i += 1) {
    turns.push({ target: i % 7 === 0 ? 'B' : 'A', text: FILLER[(i + seed) % FILLER.length], at: at(i + 1) })
  }
  return turns
}

export const PROMISES = {
  G1: {
    F: { id: 'F', label: '先失败先问', text: '这两份 CI 报告，哪一份先失败都马上来问我，别等另一份；两份都过了就安静归档，不用再跟。' },
    S: { id: 'S', label: '成功才问', text: '两份 CI 都过了再来问我是否继续；只要有一份没过，就直接归档，别再问。' },
  },
  G2: {
    W: { id: 'W', label: '先失败先问', text: '这两份 CI 报告，哪一份先失败都马上来问我；另一份没到就先等我决定，别自己开始。两份都过就归档。' },
    S: { id: 'S', label: '成功才问', text: '两份 CI 都过了再来问我是否继续；只要有一份没过，就直接归档，别再问。' },
  },
  G3: {
    E: { id: 'E', label: '本轮结束', text: '任何一份 CI 失败就问我是否分析；这一轮两份都过了就归档，不用再跟下一轮。' },
    C: { id: 'C', label: '继续下一轮', text: '任何一份 CI 失败就问我是否分析；这一轮两份都过了先安静，继续跟下一轮重跑。' },
  },
  G4: {
    AF: { id: 'AF', label: '原为失败才问', text: 'A 那份 CI 失败就马上问我是否分析；B 只做参考，不影响是否问我。' },
    AS: { id: 'AS', label: '原为成功才问', text: 'A 那份 CI 成功就马上问我是否继续；B 只做参考，不影响是否问我。' },
  },
}

export const TRAJECTORIES = {
  G1: {
    id: 'G1', label: 'A 先失败，B 整轮不来', seed: 1,
    steps: [
      { op: 'produce', key: 'A', status: 'failed', tag: 'r1' },
      { op: 'await', timeoutMs: 240000 },
      { op: 'answer', option: 'analyze_this', when: 'ask' },
      { op: 'await-analysis', timeoutMs: 240000 },
      { op: 'late-produce', key: 'B', status: 'succeeded', tag: 'r1' },
      { op: 'check-artifact-stable' },
      { op: 'late-check', ms: 20000 },
    ],
  },
  G2: {
    id: 'G2', label: 'B 先失败，选等 A，重启后 A 才到', seed: 2,
    steps: [
      { op: 'produce', key: 'B', status: 'failed', tag: 'r1' },
      { op: 'await', timeoutMs: 240000 },
      { op: 'answer', option: 'wait_other', when: 'ask' },
      { op: 'restart' },
      { op: 'quiet-check', ms: 20000, note: '重启后不得重复追问' },
      { op: 'produce', key: 'A', status: 'succeeded', tag: 'r1' },
      { op: 'await', timeoutMs: 240000 },
      { op: 'answer', option: 'continue_now', when: 'ask' },
      { op: 'await-analysis', timeoutMs: 240000 },
    ],
  },
  G3: {
    id: 'G3', label: '相同成功前缀：本轮结束 vs 继续下一轮', seed: 3,
    steps: [
      { op: 'produce', key: 'A', status: 'succeeded', tag: 'r1' },
      { op: 'produce', key: 'B', status: 'succeeded', tag: 'r1' },
      { op: 'await', timeoutMs: 90000 },
      { op: 'produce', key: 'A', status: 'failed', tag: 'r2' },
      { op: 'await', timeoutMs: 240000 },
      { op: 'answer', option: 'continue_now', when: 'ask' },
      { op: 'await-analysis', timeoutMs: 240000 },
    ],
  },
  G4: {
    id: 'G4', label: 'A 条件改反，重启后 B 迟到、A 成功', seed: 4,
    steps: [
      { op: 'say', target: 'A', text: '更正：A 的询问条件反过来；A 成功再来问我，A 失败就归档。B 仍然只做参考。' },
      { op: 'produce', key: 'B', status: 'failed', tag: 'late' },
      { op: 'restart' },
      { op: 'produce', key: 'A', status: 'succeeded', tag: 'r1' },
      { op: 'await', timeoutMs: 240000 },
      { op: 'answer', option: 'continue_now', when: 'ask' },
      { op: 'await-analysis', timeoutMs: 240000 },
    ],
  },
  X: {
    id: 'X', label: '取消后 B 失败迟到（回归）', seed: 5,
    steps: [
      { op: 'cancel', target: 'A' },
      { op: 'produce', key: 'B', status: 'failed', tag: 'late' },
      { op: 'late-check', ms: 45000, note: '取消后主任务不得再提醒或动作' },
    ],
  },
}

/** 独立评分用；运行器不读。 */
export const EXPECTATIONS = {
  'G1-F': { action: 'ask', option: 'analyze_this', analysis: 'partial', lateNoAsk: true },
  'G1-S': { action: 'archive', analysis: false, lateNoAsk: true },
  'G2-W': { action: 'ask', option: 'continue_now', waitOption: 'wait_other', waitThenAsk: true, restartNoAsk: true, analysis: 'full' },
  'G2-S': { action: 'archive', analysis: false, restartNoAsk: true },
  'G3-E': { action: 'archive', analysis: false, round2NoAsk: true },
  'G3-C': { action: 'ask', option: 'analyze_failing', analysis: 'full', round1Quiet: true },
  'G4-AF': { action: 'ask', option: 'continue_now', analysis: 'full', correction: 'success' },
  'G4-AS': { action: 'archive', analysis: false, correction: 'failure' },
  'X-F': { action: 'cancelled' },
}

export const ARMS = {
  'V-R': { assessor: 'capability-need-rule', adapter: 'versioned', label: '版本记忆+强规则', path: 'rule' },
  'V-C': { assessor: 'capability-conditions', adapter: 'versioned', label: '版本记忆+条件', path: 'condition' },
  'T-C': { assessor: 'capability-conditions', adapter: 'text', label: '文本摘要+条件', path: 'condition' },
}

export function storyFor(groupId, promiseId) {
  const group = TRAJECTORIES[groupId]
  const promise = PROMISES[groupId]?.[promiseId]
  if (!group || !promise) throw new Error(`unknown group/promise ${groupId}/${promiseId}`)
  return {
    schema: 'pet-r8-first-failure-story/v1',
    id: `${groupId}-${promiseId}`,
    group: groupId,
    promise: promiseId,
    title: `${group.label} · ${promise.label}`,
    history: history(promise.text, group.seed),
    steps: group.steps,
    bindings: ['B'],
    expectation: EXPECTATIONS[`${groupId}-${promiseId}`],
  }
}

export const MATRIX = ['G1', 'G2', 'G3', 'G4'].flatMap((group) =>
  Object.keys(PROMISES[group]).map((promise) => ({ group, promise, id: `${group}-${promise}` })))
