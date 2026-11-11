/**
 * 时钟端口实现。真实时钟用于 CLI/watch；假时钟用于回放与评估，不 sleep 12 小时。
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
    // 真实时钟只能等待；演示里不阻塞，直接返回当前时刻。
    return new Date(Date.now() + Math.max(0, ms)).toISOString()
  }
}

export class FakeClock implements ClockPort {
  readonly kind = 'fake' as const
  private t: number

  constructor(start: string) {
    const parsed = Date.parse(start)
    if (!Number.isFinite(parsed)) throw new Error(`invalid fake clock start: ${start}`)
    this.t = parsed
  }

  now(): string {
    return new Date(this.t).toISOString()
  }

  advance(ms: number): string {
    this.t += ms
    return this.now()
  }

  set(iso: string): string {
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) throw new Error(`invalid fake clock time: ${iso}`)
    this.t = parsed
    return this.now()
  }
}
