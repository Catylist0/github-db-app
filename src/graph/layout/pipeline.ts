// Pipeline entry: route every edge, discover corridors, order them via the
// constraint graph, assign ladder offsets and reconstruct the polylines.
// Pure and DOM-free — runs identically in the layout worker, the synchronous
// fallback and the tests.

import {
  type LayoutInput,
  type LayoutResult,
  type EdgeLayout,
  type Orient,
  type Seg,
  type NodeSnap,
  NODE_HW,
  segOrient,
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

// Perpendicular range over which a straightened single can still touch *both*
// of its nodes' facing sides: the intersection of the two node spans. A
// horizontal line must sit at a y inside both nodes' [top, bottom]; a vertical
// one at an x inside both [left, right]. Used to decide, after stacking, whether
// the line still reaches its nodes or must be unstraightened.
function connectablePerpRange(orient: Orient, f: NodeSnap, t: NodeSnap): { lo: number; hi: number } {
  if (orient === 'H') {
    return { lo: Math.max(f.y - f.hh, t.y - t.hh), hi: Math.min(f.y + f.hh, t.y + t.hh) }
  }
  return { lo: Math.max(f.x - NODE_HW, t.x - NODE_HW), hi: Math.min(f.x + NODE_HW, t.x + NODE_HW) }
}

// A straightened edge we may have to revert: its lane perp, the range it must
// stay within to keep reaching both nodes, and the diagonal geometry to fall
// back to when the stack pushes it out of that range.
interface StraightenedEdge {
  orient: Orient
  perp: number
  lo: number
  hi: number
  diagonal: EdgeLayout
}

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
  const straightenedEdges = new Map<string, StraightenedEdge>()
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

    if (straightened) {
      const orient = segOrient(segs[0])
      const range = connectablePerpRange(orient, from, to)
      straightenedEdges.set(edge.id, {
        orient,
        perp: orient === 'H' ? segs[0].y1 : segs[0].x1,
        lo: range.lo,
        hi: range.hi,
        // Diagonal route to fall back to, straight from one node side to the other.
        diagonal: { segments: geo.segments, midX: geo.midX, midY: geo.midY },
      })
    }

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

    // Unstraighten step: a straightened line was stacked as if infinite, so its
    // slot may have drifted past where it can still reach both nodes. If so, drop
    // back to the diagonal route into the node side rather than leave a line
    // floating off its node edge.
    const straight = straightenedEdges.get(edge.id)
    if (straight) {
      const finalPerp = straight.perp + (offsets.get(`${edge.id}#0`) ?? 0)
      if (finalPerp < straight.lo || finalPerp > straight.hi) {
        out[edge.id] = straight.diagonal
        continue
      }
    }

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
