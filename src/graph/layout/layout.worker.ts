// Layout worker entry: receives graph snapshots, runs the pure pipeline and
// posts back the polylines tagged with the request's generation. The bundle
// cache persists across messages so mid-interaction passes only re-solve the
// bundles whose inputs actually changed.

import type { LayoutRequest, LayoutResponse } from './types'
import { layoutEdges, createLayoutCache } from './pipeline'

// Typed view of the dedicated-worker global scope (tsconfig targets the DOM
// lib, so DedicatedWorkerGlobalScope isn't available by name).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<LayoutRequest>) => void) | null
  postMessage(message: LayoutResponse): void
}

const cache = createLayoutCache()

ctx.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { gen, input } = e.data
  ctx.postMessage({ gen, result: layoutEdges(input, cache) })
}
