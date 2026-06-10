// Per-edge routing: straight lines and one/two-joint orthogonal elbows, picked
// to avoid crossing other nodes. Pure — obstacle lookups go through an
// ObstacleSource (normally the spatial grid) instead of scanning node lists.

import type { Edge, EdgeRouting, MidAxis } from '../../types'
import { NODE_HW, NODE_HH, type Pt, type Seg, type NodeSnap } from './types'
import type { ObstacleSource } from './grid'

export interface EdgeGeometry {
  d: string
  midX: number
  midY: number
  segments: Seg[]
}

type PosHH = { x: number; y: number; hh?: number }
type ElbowShape = { d: string; midX: number; midY: number; segments: Seg[] }

// Clearance kept between a routed bend line and the node row/column it skirts.
const ELBOW_GAP = 30

const STRAIGHTEN_MAX_ANGLE_DEG = 5
const STRAIGHTEN_MAX_ANGLE_TAN = Math.tan((STRAIGHTEN_MAX_ANGLE_DEG * Math.PI) / 180)

export function segPathLength(segs: Seg[]): number {
  return segs.reduce((sum, s) => {
    const dx = s.x2 - s.x1
    const dy = s.y2 - s.y1
    return sum + Math.sqrt(dx * dx + dy * dy)
  }, 0)
}

export function edgeEndpoint(fx: number, fy: number, tx: number, ty: number, hh: number = NODE_HH): Pt {
  const dx = fx - tx
  const dy = fy - ty
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1) return { x: tx, y: ty }
  const ux = dx / len
  const uy = dy / len
  const t = Math.min(
    Math.abs(ux) > 1e-9 ? NODE_HW / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity,
  )
  return { x: tx + t * ux, y: ty + t * uy }
}

export function lineBoxIntersect(
  ax: number, ay: number, bx: number, by: number,
  rx: number, ry: number, rw: number, rh: number,
): { tIn: number; tOut: number } | null {
  const dx = bx - ax, dy = by - ay
  const p = [-dx, dx, -dy, dy]
  const q = [ax - rx, rx + rw - ax, ay - ry, ry + rh - ay]
  let tIn = 0, tOut = 1
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-10) {
      if (q[i] < 0) return null
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) tIn = Math.max(tIn, t)
      else tOut = Math.min(tOut, t)
    }
  }
  return tIn <= tOut ? { tIn, tOut } : null
}

export function segIntersectT(
  p1x: number, p1y: number, p2x: number, p2y: number,
  p3x: number, p3y: number, p4x: number, p4y: number,
): number | null {
  const d1x = p2x - p1x, d1y = p2y - p1y
  const d2x = p4x - p3x, d2y = p4y - p3y
  const cross = d1x * d2y - d1y * d2x
  if (Math.abs(cross) < 1e-10) return null
  const dx = p3x - p1x, dy = p3y - p1y
  const t = (dx * d2y - dy * d2x) / cross
  const s = (dx * d1y - dy * d1x) / cross
  return t >= 0 && t <= 1 && s >= 0 && s <= 1 ? t : null
}

function seg(a: Pt, b: Pt): Seg {
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}

// Single-joint (two-segment) L-shaped elbow bending at the given corner.
function elbow1Shape(fc: Pt, tc: Pt, fromHH: number, toHH: number, bend: Pt): ElbowShape {
  const start = edgeEndpoint(bend.x, bend.y, fc.x, fc.y, fromHH)
  const end = edgeEndpoint(bend.x, bend.y, tc.x, tc.y, toHH)
  return {
    d: `M ${start.x} ${start.y} L ${bend.x} ${bend.y} L ${end.x} ${end.y}`,
    midX: bend.x,
    midY: bend.y,
    segments: [seg(start, bend), seg(bend, end)],
  }
}

// Horizontal-first two-joint elbow: exits/enters the left or right sides, with
// the vertical run placed at x = bx.
function elbow2Horizontal(fc: Pt, tc: Pt, fromHH: number, toHH: number, bx: number): ElbowShape {
  const bend1 = { x: bx, y: fc.y }
  const bend2 = { x: bx, y: tc.y }
  const start = edgeEndpoint(bend1.x, bend1.y, fc.x, fc.y, fromHH)
  const end = edgeEndpoint(bend2.x, bend2.y, tc.x, tc.y, toHH)
  return {
    d: `M ${start.x} ${start.y} L ${bend1.x} ${bend1.y} L ${bend2.x} ${bend2.y} L ${end.x} ${end.y}`,
    midX: bx,
    midY: (bend1.y + bend2.y) / 2,
    segments: [seg(start, bend1), seg(bend1, bend2), seg(bend2, end)],
  }
}

// Vertical-first two-joint elbow: exits/enters the top or bottom sides, with the
// horizontal run placed at y = by.
function elbow2Vertical(fc: Pt, tc: Pt, fromHH: number, toHH: number, by: number): ElbowShape {
  const bend1 = { x: fc.x, y: by }
  const bend2 = { x: tc.x, y: by }
  const start = edgeEndpoint(bend1.x, bend1.y, fc.x, fc.y, fromHH)
  const end = edgeEndpoint(bend2.x, bend2.y, tc.x, tc.y, toHH)
  return {
    d: `M ${start.x} ${start.y} L ${bend1.x} ${bend1.y} L ${bend2.x} ${bend2.y} L ${end.x} ${end.y}`,
    midX: (bend1.x + bend2.x) / 2,
    midY: by,
    segments: [seg(start, bend1), seg(bend1, bend2), seg(bend2, end)],
  }
}

// Length of the portion of a segment that lies inside the given box.
function segBoxOverlap(s: Seg, rx: number, ry: number, rw: number, rh: number): number {
  const hit = lineBoxIntersect(s.x1, s.y1, s.x2, s.y2, rx, ry, rw, rh)
  if (!hit) return 0
  return (hit.tOut - hit.tIn) * Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

// Penalty score for an elbow candidate: crossing an unrelated node is heavily
// penalised; running through the interior of the origin/destination node is a
// lighter penalty (the path legitimately touches their borders at its ends, so
// a slightly shrunk box is used to ignore that border contact).
function elbowScore(
  shape: ElbowShape,
  obstacles: ObstacleSource,
  fromId: string,
  toId: string,
  fromPos: PosHH,
  toPos: PosHH,
): number {
  let score = 0
  for (const s of shape.segments) {
    const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2)
    const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2)
    for (const n of obstacles.query(minX, minY, maxX, maxY)) {
      if (n.id === fromId || n.id === toId) continue
      if (segBoxOverlap(s, n.x - NODE_HW, n.y - n.hh, NODE_HW * 2, n.hh * 2) > 1) score += 100
    }
    for (const p of [fromPos, toPos]) {
      const hh = (p.hh ?? NODE_HH) - 1
      if (segBoxOverlap(s, p.x - NODE_HW + 1, p.y - hh, (NODE_HW - 1) * 2, hh * 2) > 2) score += 40
    }
  }
  return score
}

// Pick the candidate with the lowest collision penalty. The per-candidate `pref`
// (a small bias < any real collision cost) decides ties so the natural shape
// wins when nothing is in the way.
function pickElbow(
  candidates: { shape: ElbowShape; pref: number }[],
  obstacles: ObstacleSource,
  fromId: string,
  toId: string,
  fromPos: PosHH,
  toPos: PosHH,
): ElbowShape {
  let best = candidates[0]
  let bestScore = elbowScore(best.shape, obstacles, fromId, toId, fromPos, toPos) + best.pref
  for (const cand of candidates.slice(1)) {
    const score = elbowScore(cand.shape, obstacles, fromId, toId, fromPos, toPos) + cand.pref
    if (score < bestScore) { best = cand; bestScore = score }
  }
  return best.shape
}

// Manual override for an elbow2 middle segment: pin it at `pos` on `axis`.
export type MidOverride = { axis: MidAxis; pos: number }

// The persisted manual middle-segment placement of an edge, when it applies.
export function edgeMidOverride(edge?: Partial<Edge> | null): MidOverride | null {
  if (!edge || edge.routing !== 'elbow2') return null
  if (edge.midAxis !== 'x' && edge.midAxis !== 'y') return null
  if (edge.midPos === null || edge.midPos === undefined) return null
  return { axis: edge.midAxis, pos: edge.midPos }
}

export function computeEdgeGeometry(
  fromPos: PosHH,
  toPos: PosHH,
  routing: EdgeRouting = 'straight',
  obstacles: ObstacleSource,
  mid: MidOverride | null = null,
  fromId = '',
  toId = '',
): EdgeGeometry {
  const fc = fromPos
  const tc = toPos
  const fromHH = fromPos.hh ?? NODE_HH
  const toHH = toPos.hh ?? NODE_HH

  if (routing === 'elbow1') {
    // A single-joint L-shape has exactly two forms: bend at (tc.x, fc.y) —
    // horizontal-first, exiting left/right of the origin — or bend at
    // (fc.x, tc.y) — vertical-first, exiting top/bottom. Default to the one
    // matching the dominant axis, but switch if it would cross another node
    // (or pass through the endpoints' interiors).
    const dx = tc.x - fc.x
    const dy = tc.y - fc.y
    const preferH = Math.abs(dx) >= Math.abs(dy)
    return pickElbow([
      { shape: elbow1Shape(fc, tc, fromHH, toHH, { x: tc.x, y: fc.y }), pref: preferH ? 0 : 1 },
      { shape: elbow1Shape(fc, tc, fromHH, toHH, { x: fc.x, y: tc.y }), pref: preferH ? 1 : 0 },
    ], obstacles, fromId, toId, fromPos, toPos)
  }

  if (routing === 'elbow2') {
    // A manually placed middle segment overrides the automatic candidate
    // search: the user dragged it to this position, so render exactly there.
    if (mid) {
      return mid.axis === 'x'
        ? elbow2Horizontal(fc, tc, fromHH, toHH, mid.pos)
        : elbow2Vertical(fc, tc, fromHH, toHH, mid.pos)
    }

    // A two-joint (three-segment) orthogonal elbow is either horizontal-first
    // (exits/enters left or right) or vertical-first (exits/enters top or
    // bottom). For each orientation the bend line can sit *between* the nodes
    // (an S/Z shape) or *outside* both of them (a C shape) — together these
    // cover every combination of origin/destination sides. We default to the
    // shape that matches the dominant axis, then, if it would cross another
    // node (or run through the endpoints' interiors), fall back to whichever
    // candidate has the lowest collision penalty.
    const dx = tc.x - fc.x
    const dy = tc.y - fc.y
    const preferH = Math.abs(dx) >= Math.abs(dy)

    const minX = Math.min(fc.x, tc.x), maxX = Math.max(fc.x, tc.x)
    const rightBend = maxX + NODE_HW + ELBOW_GAP
    const leftBend = minX - NODE_HW - ELBOW_GAP
    const downBend = Math.max(fc.y + fromHH, tc.y + toHH) + ELBOW_GAP
    const upBend = Math.min(fc.y - fromHH, tc.y - toHH) - ELBOW_GAP

    return pickElbow([
      { shape: elbow2Horizontal(fc, tc, fromHH, toHH, (fc.x + tc.x) / 2), pref: preferH ? 0 : 1 },
      { shape: elbow2Vertical(fc, tc, fromHH, toHH, (fc.y + tc.y) / 2), pref: preferH ? 1 : 0 },
      { shape: elbow2Horizontal(fc, tc, fromHH, toHH, rightBend), pref: preferH ? 2 : 4 },
      { shape: elbow2Horizontal(fc, tc, fromHH, toHH, leftBend), pref: preferH ? 3 : 5 },
      { shape: elbow2Vertical(fc, tc, fromHH, toHH, downBend), pref: preferH ? 4 : 2 },
      { shape: elbow2Vertical(fc, tc, fromHH, toHH, upBend), pref: preferH ? 5 : 3 },
    ], obstacles, fromId, toId, fromPos, toPos)
  }

  // straight
  const start = edgeEndpoint(tc.x, tc.y, fc.x, fc.y, fromHH)
  const end = edgeEndpoint(fc.x, fc.y, tc.x, tc.y, toHH)
  return {
    d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
    midX: (start.x + end.x) / 2,
    midY: (start.y + end.y) / 2,
    segments: [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }],
  }
}

// A straight edge within STRAIGHTEN_MAX_ANGLE_DEG of horizontal or vertical —
// and whose snapped axis-aligned form would still land on both nodes' sides
// (their perpendicular ranges overlap) — is snapped to that axis and returned as
// a single axis-aligned segment so it can join a stack. Steeper diagonals return
// null and stay as drawn.
export function straightenStraight(f: NodeSnap, t: NodeSnap): Seg[] | null {
  const dx = t.x - f.x
  const dy = t.y - f.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  const yLo = Math.max(f.y - f.hh, t.y - t.hh)
  const yHi = Math.min(f.y + f.hh, t.y + t.hh)
  const xLo = Math.max(f.x - NODE_HW, t.x - NODE_HW)
  const xHi = Math.min(f.x + NODE_HW, t.x + NODE_HW)
  const nearHorizontal = adx > 1 && ady / adx <= STRAIGHTEN_MAX_ANGLE_TAN
  const nearVertical = ady > 1 && adx / ady <= STRAIGHTEN_MAX_ANGLE_TAN

  if (nearHorizontal && yLo <= yHi) {
    const y = Math.max(yLo, Math.min(yHi, (f.y + t.y) / 2))
    const fromX = f.x + (dx > 0 ? NODE_HW : -NODE_HW)
    const toX = t.x + (dx > 0 ? -NODE_HW : NODE_HW)
    return [{ x1: fromX, y1: y, x2: toX, y2: y }]
  }
  if (nearVertical && xLo <= xHi) {
    const x = Math.max(xLo, Math.min(xHi, (f.x + t.x) / 2))
    const fromY = f.y + (dy > 0 ? f.hh : -f.hh)
    const toY = t.y + (dy > 0 ? -t.hh : t.hh)
    return [{ x1: x, y1: fromY, x2: x, y2: toY }]
  }
  return null
}
