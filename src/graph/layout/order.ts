// Phase 3: ladder ordering. For each bundle of corridors a weighted dependency
// graph over the participating edges is built ("A must sit below B on the
// ladder, or they cross"), condensed into strongly-connected components, and
// topologically sorted with Kahn's algorithm. Cycles are genuinely conflicting
// requirements — an unavoidable crossing — and are resolved *optimally* by an
// exact minimum-weight feedback-arc solve inside each component, so the layout
// always accepts the cheapest possible set of crossings, deterministically.

import { type Seg, pointsToSegs } from './types'
import { segIntersectT } from './route'
import { STACK_SPACING, type SegRec, type EdgeRec } from './corridors'
import { reconstructPoints } from './offsets'

// SCCs up to this size are solved exactly (bitmask DP, O(2^k·k²)); anything
// larger — far beyond what real corridors produce — falls back to a
// deterministic greedy ordering.
const MFAS_EXACT_LIMIT = 12

// Perpendicular nudge used in pairwise simulations: half a ladder rung, enough
// to make "A above B" vs "B above A" geometrically distinct.
const PROBE = STACK_SPACING / 2

// Signed turn at the corner after segment segIndex (screen coords: y grows down).
// Negative ⇒ clockwise; positive ⇒ counter-clockwise.
function cornerCrossZ(rec: EdgeRec, segIndex: number): number | null {
  if (segIndex < 0 || segIndex + 2 >= rec.points.length) return null
  if (rec.orients[segIndex] === rec.orients[segIndex + 1]) return null
  const ax = rec.points[segIndex + 1].x - rec.points[segIndex].x
  const ay = rec.points[segIndex + 1].y - rec.points[segIndex].y
  const bx = rec.points[segIndex + 2].x - rec.points[segIndex + 1].x
  const by = rec.points[segIndex + 2].y - rec.points[segIndex + 1].y
  return ax * by - ay * bx
}

// At a corner the incoming parallel corridor must flip its edge order relative
// to the outgoing corridor on clockwise turns (e.g. right-then-up), but keep it
// on counter-clockwise turns (e.g. right-then-down). This is the convention for
// mapping the bundle's canonical edge order onto each corridor's ladder; the
// pairwise simulations below evaluate geometry through the same mapping, so
// corner consistency is structural rather than a post-hoc fix-up.
export function corridorReversed(corridor: SegRec[], recById: Map<string, EdgeRec>): boolean {
  const m = corridor[0]
  const rec = recById.get(m.edgeId)
  if (!rec) return false
  const i = m.segIndex
  if (i + 1 >= rec.orients.length || rec.orients[i] === rec.orients[i + 1]) return false
  const cross = cornerCrossZ(rec, i)
  return cross !== null && cross < 0
}

function countPolylineCrossings(a: Seg[], b: Seg[]): number {
  let n = 0
  for (const sa of a) {
    for (const sb of b) {
      if (segIntersectT(sa.x1, sa.y1, sa.x2, sa.y2, sb.x1, sb.y1, sb.x2, sb.y2) !== null) n++
    }
  }
  return n
}

// Crossings between edges a and b when a is canonically ordered before b
// (aFirst) or after. Both edges' segments in every shared corridor are nudged
// to the perp side the canonical order assigns them (through each corridor's
// reversal flag), the polylines are reconstructed, and actual intersections
// are counted. This is ground truth for the pair — it inherently covers the
// continuation, corner and same-side-attachment cases.
function pairCrossings(
  a: string,
  b: string,
  bundle: SegRec[][],
  reversed: boolean[],
  recById: Map<string, EdgeRec>,
  aFirst: boolean,
): number {
  const offsets = new Map<string, number>()
  for (let i = 0; i < bundle.length; i++) {
    const aSegs = bundle[i].filter(m => m.edgeId === a)
    const bSegs = bundle[i].filter(m => m.edgeId === b)
    if (aSegs.length === 0 || bSegs.length === 0) continue
    const aLower = aFirst !== reversed[i]
    for (const m of aSegs) offsets.set(`${m.edgeId}#${m.segIndex}`, aLower ? -PROBE : PROBE)
    for (const m of bSegs) offsets.set(`${m.edgeId}#${m.segIndex}`, aLower ? PROBE : -PROBE)
  }
  const recA = recById.get(a)
  const recB = recById.get(b)
  if (!recA || !recB) return 0
  return countPolylineCrossings(
    pointsToSegs(reconstructPoints(recA, offsets)),
    pointsToSegs(reconstructPoints(recB, offsets)),
  )
}

// ── Tarjan SCC ────────────────────────────────────────────────────────────────

function tarjanSCC(n: number, adj: number[][]): number[][] {
  const index = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const onStack = new Array<boolean>(n).fill(false)
  const stack: number[] = []
  const sccs: number[][] = []
  let counter = 0

  // Iterative Tarjan: each frame remembers which neighbour to visit next.
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    const frames: { v: number; i: number }[] = [{ v: root, i: 0 }]
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = true

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const v = frame.v
      if (frame.i < adj[v].length) {
        const w = adj[v][frame.i++]
        if (index[w] === -1) {
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = true
          frames.push({ v: w, i: 0 })
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        frames.pop()
        if (frames.length > 0) {
          const parent = frames[frames.length - 1].v
          low[parent] = Math.min(low[parent], low[v])
        }
        if (low[v] === index[v]) {
          const comp: number[] = []
          let w: number
          do {
            w = stack.pop()!
            onStack[w] = false
            comp.push(w)
          } while (w !== v)
          sccs.push(comp)
        }
      }
    }
  }
  return sccs
}

// ── Minimum-weight feedback arc set within one SCC ───────────────────────────

// Exact: Held-Karp-style DP over subsets. dp[S] = minimum violated weight over
// all orderings of S as a prefix; appending v after prefix P violates every
// constraint v→u with u ∈ P. Vertices are iterated in priority order so equal-
// cost solutions resolve deterministically.
function exactMfasOrder(members: number[], w: (a: number, b: number) => number): number[] {
  const k = members.length
  const size = 1 << k
  const dp = new Float64Array(size).fill(Infinity)
  const choice = new Int32Array(size).fill(-1)
  dp[0] = 0
  for (let S = 1; S < size; S++) {
    for (let vi = 0; vi < k; vi++) {
      if (!(S & (1 << vi))) continue
      const prev = S & ~(1 << vi)
      if (dp[prev] === Infinity) continue
      let cost = dp[prev]
      for (let ui = 0; ui < k; ui++) {
        if (prev & (1 << ui)) cost += w(members[vi], members[ui])
      }
      if (cost < dp[S]) { dp[S] = cost; choice[S] = vi }
    }
  }
  const order: number[] = []
  let S = size - 1
  while (S !== 0) {
    const vi = choice[S]
    order.push(members[vi])
    S &= ~(1 << vi)
  }
  return order.reverse()
}

// Deterministic greedy fallback (Eades–Lin–Smyth) for SCCs beyond the exact
// limit: peel sinks to the back, sources to the front, otherwise the vertex
// with the best out-minus-in weight balance.
function greedyMfasOrder(members: number[], w: (a: number, b: number) => number): number[] {
  const remaining = new Set(members)
  const front: number[] = []
  const back: number[] = []
  const outW = (v: number): number => { let s = 0; for (const u of remaining) { if (u !== v) s += w(v, u) } return s }
  const inW = (v: number): number => { let s = 0; for (const u of remaining) { if (u !== v) s += w(u, v) } return s }

  while (remaining.size > 0) {
    let progressed = true
    while (progressed && remaining.size > 0) {
      progressed = false
      for (const v of remaining) {
        if (outW(v) === 0) { back.unshift(v); remaining.delete(v); progressed = true; break }
      }
      for (const v of remaining) {
        if (remaining.has(v) && inW(v) === 0) { front.push(v); remaining.delete(v); progressed = true; break }
      }
    }
    if (remaining.size > 0) {
      let best = -1, bestScore = -Infinity
      for (const v of remaining) {
        const score = outW(v) - inW(v)
        if (score > bestScore) { best = v; bestScore = score }
      }
      front.push(best)
      remaining.delete(best)
    }
  }
  return [...front, ...back]
}

// ── Bundle ordering ───────────────────────────────────────────────────────────

// Produce each corridor's members in final ladder order (ascending perp slot).
export function orderBundle(bundle: SegRec[][], recById: Map<string, EdgeRec>): SegRec[][] {
  // Participating edges, with the deterministic priority used for every
  // tie-break: mean perpendicular position across the bundle, then id. This is
  // what keeps layouts stable frame-to-frame.
  const perpSum = new Map<string, { sum: number; count: number }>()
  for (const corridor of bundle) {
    for (const m of corridor) {
      const e = perpSum.get(m.edgeId)
      if (e) { e.sum += m.perp; e.count++ }
      else perpSum.set(m.edgeId, { sum: m.perp, count: 1 })
    }
  }
  const edgeIds = [...perpSum.keys()].sort((a, b) => {
    const pa = perpSum.get(a)!, pb = perpSum.get(b)!
    return pa.sum / pa.count - pb.sum / pb.count || (a < b ? -1 : 1)
  })
  const idx = new Map(edgeIds.map((id, i) => [id, i]))
  const n = edgeIds.length

  const reversed = bundle.map(c => corridorReversed(c, recById))

  // Pairwise constraints: only pairs that actually share a corridor can
  // interact through this bundle's ordering.
  const sharedPairs = new Set<number>()
  for (const corridor of bundle) {
    const ids = [...new Set(corridor.map(m => m.edgeId))]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = idx.get(ids[i])!, b = idx.get(ids[j])!
        sharedPairs.add(a < b ? a * n + b : b * n + a)
      }
    }
  }

  const weight = new Map<number, number>()  // a*n+b → weight of constraint a→b
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const key of sharedPairs) {
    const ai = Math.floor(key / n), bi = key % n
    const a = edgeIds[ai], b = edgeIds[bi]
    const cAB = pairCrossings(a, b, bundle, reversed, recById, true)
    const cBA = pairCrossings(a, b, bundle, reversed, recById, false)
    if (cAB < cBA) {
      weight.set(ai * n + bi, cBA - cAB)
      adj[ai].push(bi)
    } else if (cBA < cAB) {
      weight.set(bi * n + ai, cAB - cBA)
      adj[bi].push(ai)
    }
  }
  const w = (a: number, b: number): number => weight.get(a * n + b) ?? 0

  // Condense, order inside each component optimally, then Kahn's over the DAG.
  const sccs = tarjanSCC(n, adj)
  const compOf = new Array<number>(n).fill(0)
  sccs.forEach((comp, ci) => { for (const v of comp) compOf[v] = ci })

  const compOrder: number[][] = sccs.map(comp => {
    if (comp.length === 1) return comp
    const sorted = [...comp].sort((a, b) => a - b)  // priority order (idx == priority rank)
    return sorted.length <= MFAS_EXACT_LIMIT ? exactMfasOrder(sorted, w) : greedyMfasOrder(sorted, w)
  })

  const compCount = sccs.length
  const indeg = new Array<number>(compCount).fill(0)
  const compAdj: Set<number>[] = Array.from({ length: compCount }, () => new Set())
  for (let a = 0; a < n; a++) {
    for (const b of adj[a]) {
      const ca = compOf[a], cb = compOf[b]
      if (ca !== cb && !compAdj[ca].has(cb)) {
        compAdj[ca].add(cb)
        indeg[cb]++
      }
    }
  }

  // Kahn's algorithm. The ready set is drained lowest-priority-first (priority
  // of a component = its smallest member rank), so the result is deterministic
  // and tracks the natural perp order wherever constraints leave freedom.
  const compPrio = sccs.map(comp => Math.min(...comp))
  const ready: number[] = []
  for (let c = 0; c < compCount; c++) { if (indeg[c] === 0) ready.push(c) }
  const canonical: string[] = []
  while (ready.length > 0) {
    let pick = 0
    for (let i = 1; i < ready.length; i++) {
      if (compPrio[ready[i]] < compPrio[ready[pick]]) pick = i
    }
    const c = ready.splice(pick, 1)[0]
    for (const v of compOrder[c]) canonical.push(edgeIds[v])
    for (const next of compAdj[c]) {
      if (--indeg[next] === 0) ready.push(next)
    }
  }

  // Apply the canonical order to each corridor's ladder (reversed at clockwise
  // corners), members of the same edge ordered by segment index.
  const rank = new Map(canonical.map((id, i) => [id, i]))
  return bundle.map((corridor, i) => {
    const sign = reversed[i] ? -1 : 1
    return [...corridor].sort((a, b) =>
      sign * ((rank.get(a.edgeId) ?? 0) - (rank.get(b.edgeId) ?? 0)) || a.segIndex - b.segIndex,
    )
  })
}
