// Phase 4: ladder assignment. Each corridor's members, already ordered by the
// constraint solver, are laid onto an evenly spaced ladder centred on their
// mean perpendicular position, then every polyline is reconstructed from the
// accumulated per-segment offsets.

import { type Orient, type Pt, NODE_HW, clamp } from './types'
import type { NodeSnap } from './types'
import { STACK_SPACING, type SegRec, type EdgeRec } from './corridors'

// Keep a stacked node-attachment point this far from the node's corners.
const STACK_NODE_MARGIN = 4

export type NodeSnapMap = Map<string, NodeSnap>

// Allowed perpendicular range for a segment so its node-attached endpoint(s)
// stay on the node side(s). For a straightened single segment attached to both
// nodes this is the intersection of the two ranges. null = unconstrained.
function segPerpRange(orient: Orient, nodeIds: string[], nodes: NodeSnapMap): { lo: number; hi: number } | null {
  if (nodeIds.length === 0) return null
  let lo = -Infinity, hi = Infinity
  for (const id of nodeIds) {
    const np = nodes.get(id)
    if (!np) continue
    const c = orient === 'H' ? np.y : np.x
    const lim = (orient === 'H' ? np.hh : NODE_HW) - STACK_NODE_MARGIN
    lo = Math.max(lo, c - lim)
    hi = Math.min(hi, c + lim)
  }
  return lo === -Infinity ? null : { lo, hi }
}

// Build the offset map for one ordered corridor: members are laid onto an
// evenly spaced ladder centred on their mean perpendicular position. Spacing is
// reduced when the ladder would otherwise overflow the tightest node edge it
// attaches to.
export function assignLadderOffsets(order: SegRec[], nodes: NodeSnapMap, into: Map<string, number>): void {
  const n = order.length
  const mean = order.reduce((s, m) => s + m.perp, 0) / n

  // Tightest node-edge capacity among node-attached members limits the ladder.
  // Straightened singles are excluded: they are allowed to float out of their
  // node range (the pipeline unstraightens them afterwards if they no longer
  // reach), so they must not crush the spacing of the members that stay put.
  let availableSpan = Infinity
  for (const m of order) {
    if (m.straightSingle) continue
    const r = segPerpRange(m.orient, m.nodeIds, nodes)
    if (r) availableSpan = Math.min(availableSpan, r.hi - r.lo)
  }
  const spacing = n > 1 ? Math.min(STACK_SPACING, Math.max(0, availableSpan) / (n - 1)) : 0

  order.forEach((m, i) => {
    const target = mean + (i - (n - 1) / 2) * spacing
    // Straightened singles take their ladder slot verbatim; whether they can
    // still reach their nodes from there is decided (and unstraightened) by the
    // pipeline. Elbow members are clamped to keep their endpoint on the node.
    if (m.straightSingle) {
      into.set(`${m.edgeId}#${m.segIndex}`, target - m.perp)
      return
    }
    const r = segPerpRange(m.orient, m.nodeIds, nodes)
    const finalPerp = r ? clamp(target, r.lo, r.hi) : target
    into.set(`${m.edgeId}#${m.segIndex}`, finalPerp - m.perp)
  })
}

// Reconstruct an edge's points after applying perpendicular offsets to its
// segments. A horizontal segment's offset shifts y; a vertical segment's offset
// shifts x. Each point is shifted by the offsets of the (≤2) segments incident
// to it; because both ends of a segment receive the same shift, segments stay
// axis-aligned and the polyline stays connected.
export function reconstructPoints(rec: EdgeRec, offsets: Map<string, number>): Pt[] {
  const k = rec.orients.length
  const out: Pt[] = []
  for (let p = 0; p <= k; p++) {
    let dx = 0, dy = 0
    const apply = (si: number): void => {
      const off = offsets.get(`${rec.id}#${si}`)
      if (off === undefined) return
      if (rec.orients[si] === 'H') dy += off
      else dx += off
    }
    if (p > 0) apply(p - 1)
    if (p < k) apply(p)
    out.push({ x: rec.points[p].x + dx, y: rec.points[p].y + dy })
  }
  return out
}
