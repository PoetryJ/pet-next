/**
 * 时钟端口实现。真实时钟用于 CLI/watch；假时钟用于回放与评估，不 sleep 12 小时。
 *
 * R4.1 起点：可控时钟严格单调。
 * - FakeClock.set 只允许前进；倒退/重复冲突直接抛错，保留原始时间值，不做 max() 掩盖。
 * - RealClock 不能“逻辑前进”；advance(>0) 显式失败，避免把宿主时间假装成未来。
 *
 * @module pet-next/experiments/task-followup/runtime/clock
 */
import type { ClockPort } from '../contracts.ts'

export class RealClock implements ClockPort {
  readonly kind = 'real' as const

  now(): string {
    return new Date().toISOString()
  }

  advance(ms: number): string {
    if (ms > 0) {
      throw new Error('real clock cannot advance; pass an explicit --clock for time travel')
    }
    return this.now()
  }
}

export class FakeClock implements ClockPort {
  readonly kind = 'fake' as const
  private t: number
  private readonly travel: { readonly from: string; readonly to: string }[] = []

  constructor(start: string) {
    const parsed = Date.parse(start)
    if (!Number.isFinite(parsed)) throw new Error(`invalid fake clock start: ${start}`)
    this.t = parsed
  }

  now(): string {
    return new Date(this.t).toISOString()
  }

  advance(ms: number): string {
    if (ms < 0) throw new Error(`clock advance must be non-negative: ${ms}`)
    this.t += ms
    return this.now()
  }

  /** 绝对时间设定；只允许前进，倒退必须失败并保留双方原始值。 */
  set(iso: string): string {
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) throw new Error(`invalid fake clock time: ${iso}`)
    if (parsed < this.t) {
      throw new Error(`clock_regression: ${iso} < current ${this.now()}`)
    }
    this.travel.push({ from: this.now(), to: new Date(parsed).toISOString() })
    this.t = parsed
    return this.now()
  }

  /** 回放记录，用于交付里的旧/新时轴说明。 */
  history(): readonly { readonly from: string; readonly to: string }[] {
    return [...this.travel]
  }
}
