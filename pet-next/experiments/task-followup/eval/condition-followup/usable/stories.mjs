/**
 * R6-usable 三个真实工作故事（冻结）。
 *
 * 与上一轮的差别：
 * - 96 条历史**全部经真实 /api/say 逐条进入**（不在宿主停机时写库、不预标抽取/摘要）。
 * - 关键承诺只在第 1 条出现，后续历史不重述；每段前缀只让模型看已到达内容。
 * - S2 的改口是当轮自然语言（“只等 A”），并故意永不产出 B。
 * - S3 有等待中的任务 + 真实进程重启 + 取消，另一任务仍要正常交付。
 */
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

function history(seed, first, extra = []) {
  const turns = [{ target: 'A', text: first, at: at(0) }]
  for (let i = 0; i < 95; i += 1) {
    const target = i % 7 === 0 ? 'B' : i % 5 === 0 ? 'C' : 'A'
    turns.push({ target, text: FILLER[(i + seed) % FILLER.length], at: at(i + 1) })
  }
  for (const item of extra) turns.splice(item.index, 0, { ...item })
  return turns
}

export const STORIES = {
  S1: {
    schema: 'pet-r6-usable-story/v1',
    id: 'S1',
    title: '早期承诺：两份真实报告到齐再问',
    history: history(1, '这两份检查报告都回来以后再问我是否继续，不要提前打断。'),
    steps: [
      { op: 'produce', key: 'B' },
      { op: 'wait-for-question-check', note: '只有一份时不得提问' },
      { op: 'produce', key: 'A' },
      { op: 'await-question', expect: true },
      { op: 'answer', option: 'continue_now' },
      { op: 'await-completion' },
    ],
    bindings: ['B'],
    expectation: { primary: 'A', requiredKeys: ['A', 'B'], askedAfterAll: true, maxReminders: 1, mustVerify: true },
  },
  S2: {
    schema: 'pet-r6-usable-story/v1',
    id: 'S2',
    title: '改口只等 A：B 永不产出',
    history: history(2, '两份报告都齐了再问我。'),
    steps: [
      { op: 'say', target: 'A', text: '更正：B 那份不用等了，只等 A 的报告就问我。' },
      { op: 'produce', key: 'A' },
      { op: 'await-question', expect: true },
      { op: 'answer', option: 'continue_now' },
      { op: 'await-completion' },
      { op: 'assert', what: 'no-question-before-a' },
    ],
    bindings: ['B'],
    expectation: { primary: 'A', requiredKeys: ['A'], askedAfterAll: true, maxReminders: 1, mustVerify: true, correctionDropsB: true },
  },
  S3: {
    schema: 'pet-r6-usable-story/v1',
    id: 'S3',
    title: '等待中的任务重启后取消；另一任务照常交付',
    history: history(3, '主报告到了再问我；干扰任务的结果不用提醒我。'),
    steps: [
      { op: 'cancel', target: 'C' },
      { op: 'restart' },
      { op: 'produce', key: 'C' },
      { op: 'produce', key: 'A' },
      { op: 'await-question', expect: true },
      { op: 'answer', option: 'continue_now' },
      { op: 'await-completion' },
      { op: 'assert', what: 'cancelled-silent' },
    ],
    // S3 的承诺只说主报告：B 不是依赖（干扰任务是 C，且被取消）。
    bindings: [],
    expectation: { primary: 'A', requiredKeys: ['A'], askedAfterAll: true, maxReminders: 1, mustVerify: true, cancelled: 'C' },
  },
}

export const ARMS = {
  'V-R': { assessor: 'capability-need-rule', adapter: 'versioned', label: '版本记忆+强规则' },
  'V-L': { assessor: 'capability', adapter: 'versioned', label: '版本记忆+逐事件模型' },
  'V-C': { assessor: 'capability-conditions', adapter: 'versioned', label: '版本记忆+条件' },
  'T-L': { assessor: 'capability', adapter: 'text', label: '文本摘要检索+逐事件模型' },
  'T-C': { assessor: 'capability-conditions', adapter: 'text', label: '文本摘要检索+条件' },
}
