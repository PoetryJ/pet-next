/** 类型声明：producer/import-test-report.mjs（R6-C 报告导入器）。 */
export declare const RESULT_SCHEMA: 'pet-followup-result/v1'
export declare const REPORT_SCHEMA: 'pet-followup-junit-report/v1'

export interface ImportOptions {
  readonly report: string
  readonly out: string
  readonly source?: string
  readonly experiment?: string
  readonly command?: string
  readonly exitCode?: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly workspace?: string
}

export interface ImportCounts {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

export interface ImportOutcome {
  readonly resultPath: string
  readonly resultSha: string
  readonly artifactPath: string
  readonly revision: number
  readonly status: 'succeeded' | 'failed' | 'partial'
  readonly counts: ImportCounts
  readonly sameAsPrevious: boolean
}

export interface JunitCase {
  readonly name: string
  readonly classname: string
  readonly time: number
  readonly state: 'passed' | 'failed' | 'skipped'
  readonly message?: string
}

export declare function collectCases(parsed: unknown): JunitCase[]
export declare function importTestReport(options: ImportOptions): ImportOutcome
