// Pipeline entry: route every edge, discover corridors, order them via the
// constraint graph, assign ladder offsets and reconstruct the polylines.
// Pure and DOM-free — runs identically in the layout worker, the synchronous
// fallback and the tests.

import {
  type LayoutInput,
  type LayoutResult,
  type EdgeLayout,
  type Seg,
  pointsToSegs,
} from './types'
import { SpatialGrid } from './grid'
import { computeEdgeGeometry, edgeMidOverride, straightenStraight } from './route'
import { buildCorridors, buildBundles, buildSegRecs, buildEdgeRec, type EdgeRec, type SegRec } from './corridors'
import { orderBundle } from './order'
import { assignLadderOffsets, reconstructPoints, type NodeSnapMap } from './offsets'

// Bundles whose inputs are byte-identical to a previous pass (nothing in them
// moved) reuse their offsets verbatim — this is what makes mid-interaction
// passes local: only bundles touched by the dragged edges are re-solved.
export interface LayoutCache {
  bundles: Map<string, [string, number][]>
}

const BUNDLE_CACHE_LIMIT = 512

export function createLayoutCache(): LayoutCache {
  return { bundles: new Map() }
}

function isAxisAlignedSeg(s: Seg): boolean {
  const adx = Math.abs(s.x2 - s.x1)
  const ady = Math.abs(s.y2 - s.y1)
  return Math.max(adx, ady) >= 1 && (ady < 0.5 || adx < 0.5)
}

const r2 = (v: number): number => Math.round(v * 100) / 100

// Everything the bundle's offsets depend on: its members, the full polylines
// of the member edges (ordering probes them), and the attached node boxes
// (ladder clamping). Node movement, rerouting or membership change all
// invalidate the key naturally.
function bundleKey(bundle: SegRec[][], recById: Map<string, EdgeRec>, nodes: NodeSnapMap): string {
  const parts: string[] = []
  const edgeIds = new Set<string>()
  const nodeIds = new Set<string>()
  for (const corridor of bundle) {
    const members = corridor.map(m => `${m.edgeId}#${m.segIndex}:${m.straightSingle ? 1 : 0}`)
    parts.push(members.join('|'))
    for (const m of corridor) {
      edgeIds.add(m.edgeId)
      for (const id of m.nodeIds) nodeIds.add(id)
    }
  }
  for (const id of [...edgeIds].sort()) {
    const rec = recById.get(id)
    if (rec) parts.push(`${id}=${rec.points.map(p => `${r2(p.x)},${r2(p.y)}`).join(';')}`)
  }
  for (const id of [...nodeIds].sort()) {
    const n = nodes.get(id)
    if (n) parts.push(`${id}@${r2(n.x)},${r2(n.y)},${r2(n.hh)}`)
  }
  return parts.join('\n')
}

export function layoutEdges(input: LayoutInput, cache?: LayoutCache): LayoutResult {
  const nodes: NodeSnapMap = new Map(input.nodes.map(n => [n.id, n]))
  const grid = new SpatialGrid(input.nodes)

  // Phase 1: route. Elbows are already axis-aligned; near-straight straight
  // edges are snapped so they too can stack. Diagonals pass through unchanged.
  const recById = new Map<string, EdgeRec>()
  const segRecs: SegRec[] = []
  for (const edge of input.edges) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to) continue
    const geo = computeEdgeGeometry(from, to, edge.routing, grid, edgeMidOverride(edge), edge.from, edge.to)

    let segs = geo.segments
    let straightened = false
    if (edge.routing === 'straight') {
      const snapped = straightenStraight(from, to)
      if (snapped) { segs = snapped; straightened = true }
    }
    recById.set(edge.id, buildEdgeRec(edge.id, segs))

    const stackable = segs.length >= 1 && (
      edge.routing !== 'straight' ||
      (segs.length === 1 && (straightened || isAxisAlignedSeg(segs[0])))
    )
    if (!stackable) continue
    const straightSingle = edge.routing === 'straight' && segs.length === 1
    segRecs.push(...buildSegRecs(edge.id, edge.from, edge.to, segs, straightSingle))
  }

  // Phases 2–4: corridors → constraint ordering → ladder offsets.
  const offsets = new Map<string, number>()
  for (const bundle of buildBundles(buildCorridors(segRecs))) {
    const key = cache ? bundleKey(bundle, recById, nodes) : ''
    if (cache) {
      const hit = cache.bundles.get(key)
      if (hit) {
        // Refresh LRU position.
        cache.bundles.delete(key)
        cache.bundles.set(key, hit)
        for (const [k, v] of hit) offsets.set(k, v)
        continue
      }
    }

    const bundleOffsets = new Map<string, number>()
    for (const ladder of orderBundle(bundle, recById)) {
      assignLadderOffsets(ladder, nodes, bundleOffsets)
    }
    for (const [k, v] of bundleOffsets) offsets.set(k, v)

    if (cache) {
      cache.bundles.set(key, [...bundleOffsets])
      while (cache.bundles.size > BUNDLE_CACHE_LIMIT) {
        cache.bundles.delete(cache.bundles.keys().next().value!)
      }
    }
  }

  // Reconstruct every edge from the accumulated offsets (unstacked edges have
  // no offsets and pass through unchanged).
  const out: Record<string, EdgeLayout> = {}
  for (const edge of input.edges) {
    const rec = recById.get(edge.id)
    if (!rec || rec.points.length < 2) continue
    const pts = reconstructPoints(rec, offsets)
    const segments = pointsToSegs(pts)
    const k = segments.length
    let midX: number, midY: number
    if (k === 2) {
      midX = pts[1].x; midY = pts[1].y                 // elbow1: the bend
    } else {
      const mi = Math.floor(k / 2)                     // straight / elbow2: mid of central segment
      midX = (pts[mi].x + pts[mi + 1].x) / 2
      midY = (pts[mi].y + pts[mi + 1].y) / 2
    }
    out[edge.id] = { segments, midX, midY }
  }
  return { edges: out }
}
