/**
 * 共享任务属性定义（抽取、检索、assessment 共用同一份）。
 * 适用于产品唯一的任务模板“跟进本地测试/实验结果，失败时让我选择是否分析”。
 * - 任务身份只放 scope，不进 key（禁止 taskA/taskB 之类谓词名）。
 * - 抽取必须从这里选 key；不在表中的写 other.<自拟名>，进入 unmapped 而不是被当成某个槽位。
 * - readForDecision 的 requiredSlots 也用这里的 id；alias 只用于把调用方/历史命名映射到同一属性，并记录映射路径。
 */
export interface AttributeDef {
  readonly id: string
  readonly kind: 'fact' | 'preference' | 'commitment' | 'outcome'
  readonly scope: 'global' | 'task' | 'either'
  readonly description: string
  readonly valueHint: string
  readonly aliases: readonly string[]
  /** time：值必须是时间（ISO 或原话含明确时间表达），否则不归入此属性 */
  readonly valueType?: 'time'
}

export const FOLLOWUP_ATTRIBUTES: readonly AttributeDef[] = [
  { id: 'runTarget', kind: 'commitment', scope: 'task', description: '要跑/要统计的范围：样本数、配置或基线版本、实验号', valueHint: '如 "64"、"v2"、"E-LANTERN"；数字写数字', aliases: ['sampleCount', 'baselineVersion', 'baseline', 'config', 'version', 'experimentId', 'targetSpec'] },
  { id: 'deliverable', kind: 'commitment', scope: 'task', description: '最终应交付什么、放在哪里（如本地分析文件）', valueHint: '如 "local_analysis_file"', aliases: ['output', 'outputFormat', 'format', 'artifact', 'report'] },
  { id: 'allowedActions', kind: 'commitment', scope: 'either', description: '用户明确允许自动执行的工具/动作', valueHint: '如 "local_failure_analysis"', aliases: ['authorizedActions', 'permission', 'authorization', 'allowedTools'] },
  { id: 'forbiddenActions', kind: 'commitment', scope: 'either', description: '用户明确禁止的动作（发送、上传、重跑、改代码…）', valueHint: '如 "rerun,modify_code,send"', aliases: ['prohibited', 'forbidden', 'restrictions', 'doNot'] },
  { id: 'decisionOwner', kind: 'commitment', scope: 'either', description: '哪些决定必须由用户本人做（如是否重跑、是否分析）', valueHint: '如 "user_chooses_rerun"', aliases: ['needsUserChoice', 'userDecides', 'approval'] },
  { id: 'notificationPolicy', kind: 'preference', scope: 'either', description: '什么时候提醒/打断用户；正常进度如何处理', valueHint: '如 "only_when_user_choice_needed"', aliases: ['reminderPreference', 'notifyWhen', 'notification', 'interruptPolicy', 'reminder'] },
  { id: 'availability', kind: 'preference', scope: 'global', description: '用户暂时不可用/忙碌的时段及期间希望的处理方式（validUntil 写结束时间）', valueHint: '如 "busy_progress_only"', aliases: ['busy', 'meeting', 'unavailable', 'screenSharing', 'doNotDisturb'] },
  { id: 'waitPolicy', kind: 'commitment', scope: 'either', description: '在什么条件下应先等待更正/后续结果而不是提问', valueHint: '如 "wait_if_eta_before_decision_deadline"', aliases: ['waitCondition', 'waitRule'] },
  { id: 'decisionDeadline', kind: 'commitment', scope: 'task', description: '用户需要做决定或结论必须给出的最晚时间', valueHint: 'ISO8601 带时区', aliases: ['deadline', 'dueAt', 'cutoff', 'decisionDue'], valueType: 'time' },
  { id: 'expectedUpdateAt', kind: 'fact', scope: 'task', description: '已知的下一份结果/更正预计到达时间', valueHint: 'ISO8601 带时区', aliases: ['eta', 'nextResultAt', 'correctionEta'], valueType: 'time' },
  { id: 'taskSeparation', kind: 'commitment', scope: 'task', description: '本任务与其他任务必须分开统计/不得混用的约束', valueHint: '如 "separate_from_other_tasks"', aliases: ['isolation', 'doNotMerge'] },
  { id: 'reportRequirements', kind: 'commitment', scope: 'task', description: '分析/报告内容要求（保留样本编号、同一修订统计等）', valueHint: '短字符串', aliases: ['analysisRequirements', 'reportContent'] },
  { id: 'taskStatus', kind: 'commitment', scope: 'task', description: '用户对任务本身的指令：取消/暂停/继续', valueHint: '"cancelled" | "paused" | "active"', aliases: ['cancel', 'cancelled', 'status', 'taskState'] },
  { id: 'resultObserved', kind: 'outcome', scope: 'task', description: '宿主已验证的最新执行结果（运行/修订/状态/指标/产物SHA），由宿主直接写入', valueHint: '"<runId>-r<rev>:<status>"', aliases: ['latestResult', 'runResult'] },
  { id: 'analysisArtifact', kind: 'outcome', scope: 'task', description: '已生成并经回执核验的分析产物（路径与SHA），由宿主直接写入', valueHint: '产物相对路径', aliases: ['artifactReceipt'] },
  { id: 'userChoice', kind: 'commitment', scope: 'task', description: '用户对某个具体选择的明确答复', valueHint: '如 "analyze_failing"', aliases: ['choice', 'answer', 'decision'] },
]

const norm = (s: string) => s.replace(/^other\./, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
const byNorm = new Map<string, AttributeDef>()
for (const a of FOLLOWUP_ATTRIBUTES) {
  byNorm.set(norm(a.id), a)
  for (const al of a.aliases) if (!byNorm.has(norm(al))) byNorm.set(norm(al), a)
}

export interface KeyResolution {
  readonly attribute: string | null
  readonly via: 'exact' | 'alias' | 'unmapped'
  readonly original: string
}

/** 把任意 key（抽取输出或调用方槽位）解析到共享属性；不做模糊猜测，只走 id/alias 精确规范化。 */
export function resolveKey(key: string, attributes: readonly AttributeDef[] = FOLLOWUP_ATTRIBUTES): KeyResolution {
  const k = norm(key)
  const exact = attributes.find((a) => norm(a.id) === k)
  if (exact) return { attribute: exact.id, via: 'exact', original: key }
  const al = attributes.find((a) => a.aliases.some((x) => norm(x) === k))
  if (al) return { attribute: al.id, via: 'alias', original: key }
  return { attribute: null, via: 'unmapped', original: key }
}

export function attributesForPrompt(attributes: readonly AttributeDef[] = FOLLOWUP_ATTRIBUTES) {
  return attributes.map((a) => ({ key: a.id, kind: a.kind, scope: a.scope, meaning: a.description, value: a.valueHint }))
}

const TIME_EXPR = /(\d{4}-\d{2}-\d{2}|\d{1,2}[:：]\d{2}|\d{1,2}\s*[点时]|\d+\s*(分钟|小时|天)|今天|明天|今晚|下班|周[一二三四五六日天]|星期)/
/** 时间型属性的值校验：值可解析为时间，或 validUntil 给出，或引用原话含明确时间表达。 */
export function timeLike(value: unknown, validUntil: string | null, quoteTexts: readonly string[]): boolean {
  if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return true
  if (validUntil) return true
  return quoteTexts.some((q) => TIME_EXPR.test(q))
}
