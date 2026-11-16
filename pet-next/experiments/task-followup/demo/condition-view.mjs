/**
 * R6-E 条件面板视图：只把宿主给出的 Evaluation 摘要翻成人话。
 *
 * 约束（见 CONTRACT）：
 * - 解释只来自宿主返回的 state/reads/watch 与用户原话，不让模型自由编造“为什么”。
 * - 主区域不显示内部 id/hash；这些只在开发区的 <details class="dev"> 里。
 * - 没有 conditionSummary 时返回 null：旧模式布局与行为完全不变。
 */

const STATE_LABEL = {
  true: '条件已满足',
  false: '条件还不满足',
  unknown: '还在等证据',
}

export function conditionView(summary) {
  if (!summary || summary.available !== true) return null
  const state = summary.state ?? 'unknown'
  return {
    label: STATE_LABEL[state] ?? STATE_LABEL.unknown,
    state,
    action: summary.action ?? null,
    showQuestion: summary.action === 'ask',
    why: Array.isArray(summary.why) ? summary.why.slice() : [],
    satisfied: Array.isArray(summary.satisfied) ? summary.satisfied.slice() : [],
    waiting: Array.isArray(summary.waiting) ? summary.waiting.slice() : [],
    unknown: Array.isArray(summary.unknown) ? summary.unknown.slice() : [],
    quotes: (Array.isArray(summary.quotes) ? summary.quotes : []).map((q) => String(q.text ?? '')).filter(Boolean),
    dev: summary.dev && typeof summary.dev === 'object'
      ? {
        compilationKey: summary.dev.compilationKey ?? null,
        evidenceKey: summary.dev.evidenceKey ?? null,
        compilerSha256: summary.dev.compilerSha256 ?? null,
        planRevision: summary.dev.planRevision ?? null,
      }
      : null,
    at: summary.at ?? null,
  }
}

const defaultEsc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const list = (items, esc, empty) => (items.length ? items.map((x) => `<span class="chip">${esc(x)}</span>`).join(' ') : `<span class="muted">${esc(empty)}</span>`)

/** 渲染条件卡片。summary 缺省/不可用 → 空串（旧布局不变）。 */
export function conditionCardHtml(summary, esc = defaultEsc) {
  const view = conditionView(summary)
  if (!view) return ''
  const dev = view.dev && (view.dev.compilationKey || view.dev.evidenceKey || view.dev.compilerSha256 || view.dev.planRevision !== null)
    ? `<details class="dev"><summary>开发区：条件计划 hash / 证据版本 / 编译版本</summary><pre>${esc(JSON.stringify(view.dev, null, 2))}</pre></details>`
    : ''
  const quotes = view.quotes.length
    ? `<div class="quotes"><b>依据你的原话</b>${view.quotes.map((q) => `<div>「${esc(q)}」</div>`).join('')}</div>`
    : ''
  return `<div class="card condition" data-state="${esc(view.state)}" data-action="${esc(view.action ?? 'none')}">
    <h3>条件跟进（实验）· ${esc(view.label)}${view.showQuestion ? ' · 现在需要你选择' : ''}</h3>
    <div class="kv">
      <div>为什么</div><div>${list(view.why, esc, '（暂无）')}</div>
      <div>已满足</div><div>${list(view.satisfied, esc, '还没有已满足的字段')}</div>
      <div>还在等</div><div>${list(view.waiting, esc, '没有其它等待项')}</div>
      <div>缺什么证据</div><div>${list(view.unknown, esc, '证据齐全')}</div>
    </div>
    ${quotes}
    ${dev}
  </div>`
}

/** 挂载到某容器；summary 不可用时清空并隐藏容器。 */
export function mountCondition(container, summary, esc) {
  if (!container) return false
  const html = conditionCardHtml(summary, esc)
  container.innerHTML = html
  container.hidden = html === ''
  return html !== ''
}
