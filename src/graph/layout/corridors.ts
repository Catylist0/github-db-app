// Phase 2: corridor discovery. A corridor is a maximal set of parallel,
// proximate, axially-overlapping segments that visually share a lane and must
// be spread onto a ladder. Built with a deterministic sort-and-sweep — output
// is independent of input edge order, unlike the old greedy union-find merge.

import { type Orient, type Pt, type Seg, segOrient } from './types'

// Centre-to-centre distance between neighbouring lines in a stack: the 2px
// stroke plus ~2px of clear gap ("one line-width" of separation).
export const STACK_SPACING = 4
// Max perpendicular gap for two parallel segments to be treated as the same
// stack (i.e. visually overlapping / crowded).
export const STACK_PROXIMITY = 6
// Straighter single-segment lines snap to node sides while elbow buses run
// further out — use a wider capture band when pulling them into a stack.
export const STACK_STRAIGHT_PROXIMITY = 64
// Min axial overlap before two parallel segments count as running "alongside".
export const STACK_MIN_OVERLAP = 8

export interface SegRec {
  edgeId: string
  segIndex: number
  orient: Orient
  perp: number            // shared coord: y for H, x for V
  lo: number              // axial span start
  hi: number              // axial span end
  nodeIds: string[]       // node(s) this segment's endpoint(s) attach to (0–2)
  straightSingle: boolean // axis-aligned / straightened routing === 'straight'
}

// An edge's full routed polyline, kept for offset reconstruction and for the
// pairwise crossing simulations in the ordering phase.
export interface EdgeRec {
  id: string
  points: Pt[]            // length k+1
  orients: Orient[]       // length k, alternating
}

export function buildEdgeRec(id: string, segs: Seg[]): EdgeRec {
  const points: Pt[] = segs.length
    ? [{ x: segs[0].x1, y: segs[0].y1 }, ...segs.map(s => ({ x: s.x2, y: s.y2 }))]
    : []
  return { id, points, orients: segs.map(segOrient) }
}

export function buildSegRecs(
  edgeId: string,
  fromId: string,
  toId: string,
  segs: Seg[],
  straightSingle: boolean,
): SegRec[] {
  const recs: SegRec[] = []
  segs.forEach((s, i) => {
    const orient = segOrient(s)
    const len = orient === 'H' ? Math.abs(s.x2 - s.x1) : Math.abs(s.y2 - s.y1)
    if (len < 1) return
    const perp = orient === 'H' ? s.y1 : s.x1
    const lo = orient === 'H' ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2)
    const hi = orient === 'H' ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2)
    const nodeIds: string[] = []
    if (i === 0) nodeIds.push(fromId)
    if (i === segs.length - 1) nodeIds.push(toId)  // single segment ⇒ both
    recs.push({ edgeId, segIndex: i, orient, perp, lo, hi, nodeIds, straightSingle })
  })
  return recs
}

interface Cluster {
  members: SegRec[]
  maxPerp: number       // members arrive in ascending perp, so this is the closest
  lo: number            // axial envelope
  hi: number
  hasStraight: boolean
}

function proximity(seg: SegRec, cluster: Cluster): number {
  return (seg.straightSingle || cluster.hasStraight) ? STACK_STRAIGHT_PROXIMITY : STACK_PROXIMITY
}

// Sweep one orientation's segments in ascending perp order, attaching each to
// every open cluster whose lane it continues (close enough in perp to the
// cluster's nearest member, and overlapping the cluster's axial envelope).
// A segment matching several clusters bridges them into one. Sorting first
// makes the result a pure function of the segment set.
function sweep(pool: SegRec[]): SegRec[][] {
  const sorted = [...pool].sort((a, b) =>
    a.perp - b.perp || a.lo - b.lo ||
    (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0) || a.segIndex - b.segIndex,
  )

  const clusters: Cluster[] = []
  for (const seg of sorted) {
    // A straightened single is treated as extending infinitely along its axis,
    // so it overlaps any lane it is perpendicularly close to and never falls out
    // of a stack it belongs in. (Its real, finite span is kept on the SegRec for
    // the ordering phase — only corridor membership sees the infinite extent.)
    const segLo = seg.straightSingle ? -Infinity : seg.lo
    const segHi = seg.straightSingle ? Infinity : seg.hi
    const matches: Cluster[] = []
    for (const c of clusters) {
      if (seg.perp - c.maxPerp > proximity(seg, c)) continue
      const overlap = Math.min(segHi, c.hi) - Math.max(segLo, c.lo)
      if (overlap < STACK_MIN_OVERLAP) continue
      matches.push(c)
    }
    if (matches.length === 0) {
      clusters.push({
        members: [seg], maxPerp: seg.perp, lo: seg.lo, hi: seg.hi,
        hasStraight: seg.straightSingle,
      })
      continue
    }
    const target = matches[0]
    for (const other of matches.slice(1)) {
      target.members.push(...other.members)
      target.lo = Math.min(target.lo, other.lo)
      target.hi = Math.max(target.hi, other.hi)
      target.hasStraight = target.hasStraight || other.hasStraight
      clusters.splice(clusters.indexOf(other), 1)
    }
    target.members.push(seg)
    target.maxPerp = seg.perp
    // The cluster's axial envelope tracks the members' real spans, not the
    // infinite extent used above for the join test — so a straightened line
    // joins lanes it overlaps without dragging axially-distant segments in.
    target.lo = Math.min(target.lo, seg.lo)
    target.hi = Math.max(target.hi, seg.hi)
    target.hasStraight = target.hasStraight || seg.straightSingle
  }

  const out: SegRec[][] = []
  for (const c of clusters) {
    if (c.members.length < 2) continue
    out.push(c.members.sort((a, b) =>
      a.perp - b.perp || (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0) || a.segIndex - b.segIndex,
    ))
  }
  return out
}

export function buildCorridors(segRecs: SegRec[]): SegRec[][] {
  return [
    ...sweep(segRecs.filter(s => s.orient === 'H')),
    ...sweep(segRecs.filter(s => s.orient === 'V')),
  ]
}

// Corridors that share any edge belong to the same bundle (e.g. horizontal run
// feeding into a vertical run on the same elbow edges). They must be ordered
// with a single edge permutation or corner joints cross.
export function buildBundles(corridors: SegRec[][]): SegRec[][][] {
  const n = corridors.length
  if (n === 0) return []
  const parent = corridors.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a: number, b: number): void => { parent[find(a)] = find(b) }
  for (let i = 0; i < n; i++) {
    const ids = new Set(corridors[i].map(m => m.edgeId))
    for (let j = i + 1; j < n; j++) {
      if (corridors[j].some(m => ids.has(m.edgeId))) union(i, j)
    }
  }
  const groups = new Map<number, SegRec[][]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(corridors[i])
    else groups.set(r, [corridors[i]])
  }
  return [...groups.values()]
}
