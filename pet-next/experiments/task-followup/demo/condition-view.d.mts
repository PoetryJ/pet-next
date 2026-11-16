/** 类型声明：demo/condition-view.mjs（R6 条件面板纯渲染）。 */
export interface ConditionSummaryLike {
  readonly available?: boolean
  readonly state?: 'true' | 'false' | 'unknown' | null
  readonly action?: string | null
  readonly why?: readonly string[]
  readonly satisfied?: readonly string[]
  readonly waiting?: readonly string[]
  readonly unknown?: readonly string[]
  readonly quotes?: readonly { readonly turnId?: string; readonly text?: string }[]
  readonly at?: string | null
  readonly dev?: {
    readonly compilationKey?: string | null
    readonly evidenceKey?: string | null
    readonly compilerSha256?: string | null
    readonly planRevision?: number | null
  } | null
}

export interface ConditionView {
  readonly label: string
  readonly state: string
  readonly action: string | null
  readonly showQuestion: boolean
  readonly why: string[]
  readonly satisfied: string[]
  readonly waiting: string[]
  readonly unknown: string[]
  readonly quotes: string[]
  readonly dev: ConditionSummaryLike['dev']
  readonly at: string | null
}

export declare function conditionView(summary: ConditionSummaryLike | null | undefined): ConditionView | null
export declare function conditionCardHtml(summary: ConditionSummaryLike | null | undefined, esc?: (text: unknown) => string): string
export declare function mountCondition(container: { innerHTML: string; hidden: boolean } | null, summary: ConditionSummaryLike | null | undefined, esc?: (text: unknown) => string): boolean
