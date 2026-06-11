// Phase 3: ladder ordering. Each corridor is ordered independently by simple,
// purely geometric rules driven by where — and in which perpendicular
// direction — every member joins and leaves the shared lane:
//
//  1. Leave-direction rule: a member that turns off the lane clearly inside
//     another member's axial span must sit on the side it departs towards,
//     otherwise its perpendicular run cuts straight through the member that
//     continues past it. "Clearly inside" is measured against the ladder
//     spread, because the ladder itself moves corners by a few pixels and
//     sub-spread offsets are routing noise, not structure.
//  2. Heading rule: members whose joints coincide (the common case — a fan of
//     elbows emerging from one node) are ordered by the perpendicular position
//     of what they are heading to. For a fan of 2-joint elbows this makes the
//     stacked order at the origin match the vertical order of the destination
//     nodes, which is exactly the crossing-free nesting; the same argument
//     applies orthogonally to 1-joint elbows.
//  3. Joint-nesting tie-break: when headings tie (e.g. two parallel Z-shaped
//     edges translated a few pixels apart), the member that departs deeper
//     into the corridor takes the side it departs towards — the sub-spread
//     analogue of rule 1.
//
// Corner consistency between corridors of the same bundle emerges naturally:
// all rules are evaluated against the same routed geometry, so the order a
// fan leaves its horizontal lane in agrees with the order its verticals stack
// in, without any cross-corridor constraint propagation.

import type { Pt } from './types'
import { STACK_SPACING, type SegRec, type EdgeRec } from './corridors'

// Ends closer together than this are the same joint.
const POS_EPS = 0.5
// Keys / perps closer than this are treated as equal (routing noise).
const KEY_EPS = 0.25

interface EndInfo {
  pos: number          // axial coordinate of this end of the segment
  dir: -1 | 0 | 1      // perpendicular direction the line departs in (0 = node terminal / straight-through)
  target: number       // perpendicular coordinate the line heads to beyond this end
}

interface MemberInfo {
  m: SegRec
  lo: EndInfo | null   // end at the smaller axial coordinate
  hi: EndInfo | null
  key: number          // mean heading target — the rule-2 sort key
}

function memberInfo(m: SegRec, recById: Map<string, EdgeRec>): MemberInfo {
  const rec = recById.get(m.edgeId)
  if (!rec || m.segIndex + 1 >= rec.points.length) return { m, lo: null, hi: null, key: m.perp }
  const i = m.segIndex
  const last = rec.orients.length - 1
  const axial = (p: Pt): number => (m.orient === 'H' ? p.x : p.y)
  const perpOf = (p: Pt): number => (m.orient === 'H' ? p.y : p.x)
  const mk = (endPt: Pt, farPt: Pt | null): EndInfo => {
    // A node terminal heads nowhere: it stays at the lane's perp.
    const target = farPt ? perpOf(farPt) : m.perp
    const d = target - m.perp
    return { pos: axial(endPt), dir: d > 0.5 ? 1 : d < -0.5 ? -1 : 0, target }
  }
  const start = mk(rec.points[i], i > 0 ? rec.points[i - 1] : null)
  const end = mk(rec.points[i + 1], i < last ? rec.points[i + 2] : null)
  const [lo, hi] = start.pos <= end.pos ? [start, end] : [end, start]
  return { m, lo, hi, key: (start.target + end.target) / 2 }
}

// Rule 1: the side `a` must take relative to `b` because one of `a`'s ends
// departs perpendicular-wards clearly inside `b`'s axial span. 0 = no vote
// (or `a`'s own ends disagree — a genuinely unavoidable conflict).
function leaveSide(a: MemberInfo, b: MemberInfo, deep: number): number {
  let side = 0
  for (const e of [a.lo, a.hi]) {
    if (!e || e.dir === 0) continue
    if (e.pos <= b.m.lo + deep || e.pos >= b.m.hi - deep) continue
    if (side !== 0 && side !== e.dir) return 0
    side = e.dir
  }
  return side
}

// Rule 3: at a shared joint where both members depart the same way, the one
// departing deeper inside the corridor takes the departure side. Negative ⇒
// a takes the smaller perp slot; 0 = no preference (or the two joints clash).
function nestSide(a: MemberInfo, b: MemberInfo): number {
  let side = 0
  if (a.lo && b.lo && a.lo.dir !== 0 && a.lo.dir === b.lo.dir && Math.abs(a.lo.pos - b.lo.pos) > POS_EPS) {
    side = (a.lo.pos > b.lo.pos ? 1 : -1) * a.lo.dir
  }
  if (a.hi && b.hi && a.hi.dir !== 0 && a.hi.dir === b.hi.dir && Math.abs(a.hi.pos - b.hi.pos) > POS_EPS) {
    const s = (a.hi.pos < b.hi.pos ? 1 : -1) * a.hi.dir
    if (side !== 0 && side !== s) return 0
    side = s
  }
  return side
}

// Negative ⇒ a takes the smaller perp slot (above for H corridors, left for V).
function compareMembers(a: MemberInfo, b: MemberInfo, deep: number): number {
  const fromA = leaveSide(a, b, deep)   // a relative to b, from a's departures
  const fromB = -leaveSide(b, a, deep)  // a relative to b, from b's departures
  const side = fromA !== 0 ? (fromB === 0 || fromB === fromA ? fromA : 0) : fromB
  if (side !== 0) return side
  if (Math.abs(a.key - b.key) > KEY_EPS) return a.key - b.key
  const nested = nestSide(a, b)
  if (nested !== 0) return nested
  if (Math.abs(a.m.perp - b.m.perp) > KEY_EPS) return a.m.perp - b.m.perp
  if (a.m.edgeId !== b.m.edgeId) return a.m.edgeId < b.m.edgeId ? -1 : 1
  return a.m.segIndex - b.m.segIndex
}

// Insertion sort: well-defined for any comparator (the rules can in rare
// degenerate layouts vote cyclically), and the input arrives in the sweep's
// canonical member order, so the result is a pure function of the corridor.
function orderCorridor(corridor: SegRec[], recById: Map<string, EdgeRec>): SegRec[] {
  // Corners move by up to the ladder spread when offsets are applied, so only
  // containment beyond that spread is structural (rule 1); anything closer is
  // treated as a shared joint and handled by rules 2 and 3.
  const deep = STACK_SPACING * corridor.length
  const placed: MemberInfo[] = []
  for (const m of corridor) {
    const info = memberInfo(m, recById)
    let at = placed.length
    for (let i = 0; i < placed.length; i++) {
      if (compareMembers(info, placed[i], deep) < 0) { at = i; break }
    }
    placed.splice(at, 0, info)
  }
  return placed.map(p => p.m)
}

// Produce each corridor's members in final ladder order (ascending perp slot).
export function orderBundle(bundle: SegRec[][], recById: Map<string, EdgeRec>): SegRec[][] {
  return bundle.map(corridor => orderCorridor(corridor, recById))
}
