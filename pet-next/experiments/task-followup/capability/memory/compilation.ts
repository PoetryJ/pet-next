/**
 * Task-scoped single-flight memory compilation. An assessment is a consumer,
 * not the owner of the compilation lifetime: cancelling that assessment must
 * not throw away a still-useful extraction. The host owns close(), and must
 * await it before closing the shared database.
 */
export type CompilationWork<T> = (signal: AbortSignal) => Promise<T>

interface Flight<T> {
  readonly controller: AbortController
  readonly promise: Promise<T>
}

export class MemoryCompilationClosedError extends Error {
  constructor() { super('Memory compilation is closed'); this.name = 'MemoryCompilationClosedError' }
}

function abortedError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class MemoryCompilation<T = unknown> {
  private readonly flights = new Map<string, Flight<T>>()
  private isClosed = false
  private closing: Promise<void> | null = null

  get closed(): boolean { return this.isClosed }
  get inFlightCount(): number { return this.flights.size }
  has(taskId: string): boolean { return this.flights.has(taskId) }

  /**
   * Returns the exact existing promise for a busy task. A later caller's work
   * is not invoked; after this flight settles, a later call can compile the
   * next delta. No caller/assessment AbortSignal is accepted here by design.
   */
  run(taskId: string, work: CompilationWork<T>): Promise<T> {
    if (this.isClosed) return Promise.reject(new MemoryCompilationClosedError())
    if (!taskId) return Promise.reject(new TypeError('Compilation taskId is required'))
    const existing = this.flights.get(taskId)
    if (existing) return existing.promise
    const controller = new AbortController()
    const flight: Flight<T> = {
      controller,
      promise: Promise.resolve().then(() => {
        // close() may happen before this work's first microtask.
        if (controller.signal.aborted) throw controller.signal.reason
        return work(controller.signal)
      }).finally(() => {
        // A finished generation must not remove a replacement generation.
        if (this.flights.get(taskId) === flight) this.flights.delete(taskId)
      }),
    }
    this.flights.set(taskId, flight)
    return flight.promise
  }

  /**
   * Cancel and await the flights present at entry. Entries stay registered
   * until work settles, so another caller cannot overlap a second writer for
   * the same task while the cancelled writer is still unwinding.
   * Individual run() promises retain their original success/error.
   * New work is allowed after settlement; use close() for host shutdown.
   */
  async abortAll(reason: unknown = abortedError('Memory compilation aborted')): Promise<void> {
    const pending = [...this.flights.values()]
    for (const flight of pending) flight.controller.abort(reason)
    await Promise.allSettled(pending.map((flight) => flight.promise))
  }

  /** Idempotent shutdown barrier; no new work can start once called. */
  close(reason: unknown = abortedError('Memory compilation host closed')): Promise<void> {
    if (this.closing) return this.closing
    this.isClosed = true
    this.closing = this.abortAll(reason)
    return this.closing
  }
}
