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
  /** time：value 本身必须是带时区的有效 ISO 时间戳，否则不归入此属性。 */
  readonly valueType?: 'time'
}

export const FOLLOWUP_ATTRIBUTES: readonly AttributeDef[] = [
  { id: 'runTarget', kind: 'commitment', scope: 'task', description: '要跟进、运行或统计的对象和范围的一般描述；样本数、基线版本和实验标识分别记入各自属性', valueHint: '如 "local_regression_suite"；不以此替代 sampleCount、baselineVersion 或 experimentId', aliases: ['targetSpec', 'targetDescription'] },
  { id: 'sampleCount', kind: 'commitment', scope: 'task', description: '本任务约定使用的样本数量；与基线版本、实验标识相互独立', valueHint: 'JSON 数字，如 64', aliases: ['sampleSize', 'numSamples', 'numberOfSamples'] },
  { id: 'baselineVersion', kind: 'commitment', scope: 'task', description: '本任务采用的基线或配置版本；不是样本数量、实验标识或结果修订号', valueHint: '如 "v2" 或 "config-b"', aliases: ['baseline', 'config', 'configVersion', 'version'] },
  { id: 'experimentId', kind: 'commitment', scope: 'task', description: '本任务所跟进实验的标识；不是基线版本或任务作用域 id', valueHint: '如 "E-LANTERN"', aliases: ['experiment', 'experimentCode', 'experimentIdentifier'] },
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
  // other.* is an explicit unmapped/downgraded namespace. In particular, an
  // invalid time demoted to other.deadline must not later satisfy deadline.
  if (/^other\./i.test(key)) return { attribute: null, via: 'unmapped', original: key }
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

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/
/** 只验证 value；有效期或原话中出现时间，不能为无效的槽位值背书。 */
export function timeLike(value: unknown, _validUntil: string | null, _quoteTexts: readonly string[]): boolean {
  if (typeof value !== 'string') return false
  const match = ISO_WITH_ZONE.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHour, zoneMinute] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return false
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? 0) > 59) return false
  if (zone !== 'Z' && (Number(zoneHour) > 23 || Number(zoneMinute) > 59)) return false
  return Number.isFinite(Date.parse(value))
}
