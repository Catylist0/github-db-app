// Main-thread side of the async layout: owns the worker, the generation
// counter and the supersede/staleness rules.
//
// - Every request bumps the generation; at most one job is in flight.
// - A request issued while a job runs replaces any queued snapshot (only the
//   newest matters) and is dispatched when the running job returns.
// - A result is applied only if no newer request exists (gen match), so the
//   DOM never moves backwards in time.
// - If workers are unavailable (or the worker script fails to load), the same
//   pipeline runs on the main thread in a macrotask — still asynchronous to
//   callers, just not parallel.

import type { LayoutInput, LayoutResult, LayoutResponse } from './types'
import { layoutEdges, createLayoutCache, type LayoutCache } from './pipeline'

export type ApplyLayoutFn = (result: LayoutResult, gen: number) => void

export class LayoutScheduler {
  private worker: Worker | null = null
  private gen = 0
  private inFlight = false
  private pending: LayoutInput | null = null
  private fallbackCache: LayoutCache | null = null
  private disposed = false

  constructor(private apply: ApplyLayoutFn) {
    try {
      this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
        this.onResult(e.data.gen, e.data.result)
      }
      this.worker.onerror = () => {
        // Worker script failed — fall back to main-thread execution and rerun
        // whatever was queued or lost in flight.
        this.worker?.terminate()
        this.worker = null
        const retry = this.pending
        this.pending = null
        this.inFlight = false
        if (retry) this.dispatch(retry)
      }
    } catch {
      this.worker = null
    }
  }

  // Returns the generation assigned to this snapshot. Callers should request a
  // fresh layout after every model change so generation === model state.
  request(input: LayoutInput): number {
    this.gen++
    if (this.inFlight) {
      this.pending = input
    } else {
      this.dispatch(input)
    }
    return this.gen
  }

  get currentGen(): number {
    return this.gen
  }

  private dispatch(input: LayoutInput): void {
    this.inFlight = true
    const gen = this.gen
    if (this.worker) {
      this.worker.postMessage({ gen, input })
    } else {
      setTimeout(() => {
        if (this.disposed) return
        if (!this.fallbackCache) this.fallbackCache = createLayoutCache()
        this.onResult(gen, layoutEdges(input, this.fallbackCache))
      }, 0)
    }
  }

  private onResult(gen: number, result: LayoutResult): void {
    if (this.disposed) return
    this.inFlight = false
    if (gen === this.gen) this.apply(result, gen)
    if (this.pending) {
      const next = this.pending
      this.pending = null
      this.dispatch(next)
    }
  }

  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
  }
}
