// Pure geometry for grouping regions. Given the rectangles of a group's member
// nodes (and the rectangles of every other, non-member node), this computes an
// Euler-diagram-style rectilinear outline.
//
// The shape is solved holistically rather than by carving cut-outs from a
// bounding box: the region is assembled as the union of a few large
// obstacle-free rectangles, picked greedily so that every member is contained
// and the union stays connected. Because each rectangle contributes at most
// four corners, minimising the rectangle count keeps the vertex count as small
// as the obstacle layout allows; an intruding obstacle shows up as a notch or a
// C-shape simply because no chosen rectangle covers it, not because anything
// was cut out afterwards. Extra enclosed empty space is fine; jagged or spindly
// boundaries are not.
//
//   • No exclaves: members that cannot be reached through obstacle-free space
//     are reported in `excluded` so the caller can drop them from the group.
//   • Enclaves are avoided structurally — a hole can only appear when members
//     surround an obstacle on every side, so the connected union is forced into
//     a ring. That is the one permitted enclave case.
//
// Edges whose two endpoints are both non-members are treated as obstacles too,
// unless honouring them would cost members ("unless it's not possible"), in
// which case they are ignored.
//
// Nothing here touches the DOM, so it can be unit-tested in node. The result is
// an SVG path `d` string with only horizontal/vertical edges and rounded
// corners; ring holes are extra sub-paths and rely on fill-rule: evenodd.

export interface GroupRect {
  x: number // centre
  y: number
  hw: number // half width
  hh: number // half height
}

export interface GroupExcludeSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GroupOutlineOptions {
  memberPad?: number // margin grown around each member before the boundary sits
  excludePad?: number // keep-out margin around each non-member node or edge
  corner?: number // corner radius
  excludeSegments?: GroupExcludeSegment[] // edges whose endpoints are both non-members
}

const DEFAULTS = { memberPad: 26, excludePad: 16, corner: 14 }

export type Pt = { x: number; y: number }

// The computed shape of a group: its rectilinear outline loops plus the indices
// (into the `members` array passed in) of members that could not be reached
// without forming an exclave and so were excluded from the rendered region.
export interface GroupShape {
  loops: Pt[][]
  excluded: number[]
}

// Build the outline path. Returns '' when there are no members.
export function computeGroupOutline(
  members: GroupRect[],
  nonMembers: GroupRect[],
  options: GroupOutlineOptions = {},
): string {
  const corner = options.corner ?? DEFAULTS.corner
  return loopsToPath(computeGroupLoops(members, nonMembers, options), corner)
}

// Render simplified rectilinear loops to a single SVG path `d` string with
// rounded corners. Multiple sub-paths (outer boundary plus ring holes) rely on
// fill-rule: evenodd in the caller.
export function loopsToPath(loops: Pt[][], corner: number = DEFAULTS.corner): string {
  return loops.map(loop => roundedRectilinearPath(loop, corner)).filter(Boolean).join(' ')
}

// Even-odd point-in-polygon over a set of loops (so holes read as outside).
export function pointInLoops(loops: Pt[][], px: number, py: number): boolean {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j]
      if ((a.y > py) !== (b.y > py)) {
        const xCross = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x)
        if (px < xCross) inside = !inside
      }
    }
  }
  return inside
}

// Backward-compatible helper: just the outline loops of the region.
export function computeGroupLoops(
  members: GroupRect[],
  nonMembers: GroupRect[],
  options: GroupOutlineOptions = {},
): Pt[][] {
  return computeGroupShape(members, nonMembers, options).loops
}

// The rectilinear boundary loops (simplified to real corners only), in screen
// coordinates, plus the indices of members excluded as exclaves. Each loop is a
// closed polygon whose consecutive vertices differ in exactly one axis.
export function computeGroupShape(
  members: GroupRect[],
  nonMembers: GroupRect[],
  options: GroupOutlineOptions = {},
): GroupShape {
  if (members.length === 0) return { loops: [], excluded: [] }
  const memberPad = options.memberPad ?? DEFAULTS.memberPad
  const excludePad = options.excludePad ?? DEFAULTS.excludePad

  // Outer envelope: one padded axis-aligned box around every member. Everything
  // is solved inside it.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x - m.hw - memberPad)
    minY = Math.min(minY, m.y - m.hh - memberPad)
    maxX = Math.max(maxX, m.x + m.hw + memberPad)
    maxY = Math.max(maxY, m.y + m.hh + memberPad)
  }

  // Only obstacles that can actually intrude on the envelope matter.
  const obstacles = nonMembers.filter(n =>
    n.x + n.hw + excludePad > minX && n.x - n.hw - excludePad < maxX &&
    n.y + n.hh + excludePad > minY && n.y - n.hh - excludePad < maxY)
  const segments = (options.excludeSegments ?? []).filter(s =>
    Math.max(s.x1, s.x2) + excludePad > minX && Math.min(s.x1, s.x2) - excludePad < maxX &&
    Math.max(s.y1, s.y2) + excludePad > minY && Math.min(s.y1, s.y2) - excludePad < maxY)

  // Coordinate-compressed grid: cell boundaries only at meaningful x/y values,
  // so candidate rectangles snap to the geometry and stay few.
  const xCuts: number[] = []
  const yCuts: number[] = []
  for (const m of members) {
    xCuts.push(m.x - m.hw, m.x + m.hw)
    yCuts.push(m.y - m.hh, m.y + m.hh)
  }
  for (const n of obstacles) {
    xCuts.push(n.x - n.hw - excludePad, n.x + n.hw + excludePad)
    yCuts.push(n.y - n.hh - excludePad, n.y + n.hh + excludePad)
  }
  for (const s of segments) {
    xCuts.push(Math.min(s.x1, s.x2) - excludePad, Math.max(s.x1, s.x2) + excludePad)
    yCuts.push(Math.min(s.y1, s.y2) - excludePad, Math.max(s.y1, s.y2) + excludePad)
  }
  const xs = compressCuts(xCuts, minX, maxX)
  const ys = compressCuts(yCuts, minY, maxY)
  const cols = xs.length - 1
  const rows = ys.length - 1
  if (cols <= 0 || rows <= 0) return { loops: [], excluded: [] }

  const inRect = (px: number, py: number, r: GroupRect, pad: number): boolean =>
    Math.abs(px - r.x) <= r.hw + pad && Math.abs(py - r.y) <= r.hh + pad

  // Free cells (sampled at the centre): not covered by any keep-out. A member's
  // own core rectangle is always free, so members are never blocked by a
  // non-member sitting on top of them.
  const buildFree = (withSegments: boolean): Uint8Array => {
    const free = new Uint8Array(cols * rows)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i
        const px = (xs[i] + xs[i + 1]) / 2
        const py = (ys[j] + ys[j + 1]) / 2
        let isCore = false
        for (const m of members) {
          if (inRect(px, py, m, 0)) { isCore = true; break }
        }
        if (isCore) { free[idx] = 1; continue }
        let blocked = false
        for (const n of obstacles) {
          if (inRect(px, py, n, excludePad)) { blocked = true; break }
        }
        if (!blocked && withSegments) {
          for (const s of segments) {
            // Strictly inside the capsule: cells the capsule only grazes stay free.
            if (segRectDist(s, xs[i], ys[j], xs[i + 1], ys[j + 1]) < excludePad - 1e-7) { blocked = true; break }
          }
        }
        free[idx] = blocked ? 0 : 1
      }
    }
    return free
  }

  let result = assembleRegion(members, buildFree(segments.length > 0), cols, rows, xs, ys)
  // Non-member edges are avoided only when that costs nothing: if honouring
  // them excludes members that would otherwise fit, drop the edges instead.
  if (segments.length > 0 && result.excluded.length > 0) {
    const relaxed = assembleRegion(members, buildFree(false), cols, rows, xs, ys)
    if (relaxed.excluded.length < result.excluded.length) result = relaxed
  }
  return result
}

// A candidate rectangle in cell indices: columns [i0, i1) × rows [j0, j1).
type CellRect = { i0: number; i1: number; j0: number; j1: number; area: number }

// The holistic solve: pick the fewest large free rectangles whose union
// contains every reachable member and is connected, then trace its outline.
function assembleRegion(
  members: GroupRect[],
  free: Uint8Array,
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
): GroupShape {
  const memberCell = members.map(m =>
    cellIndex(ys, m.y, rows) * cols + cellIndex(xs, m.x, cols))

  // Members unreachable through free space can never join the region: keep the
  // free component holding the most members, exclude the rest up front.
  const freeComp = labelComponents(free, cols, rows)
  const main = dominantComponent(freeComp, memberCell)
  const excluded = new Set<number>()
  const work: number[] = []
  for (let m = 0; m < members.length; m++) {
    if (freeComp.label[memberCell[m]] === main) work.push(m)
    else excluded.add(m)
  }

  const cands = maximalFreeRects(free, cols, rows, xs, ys)

  const eps = 1e-7
  const containsCore = (r: CellRect, m: GroupRect): boolean =>
    xs[r.i0] <= m.x - m.hw + eps && xs[r.i1] >= m.x + m.hw - eps &&
    ys[r.j0] <= m.y - m.hh + eps && ys[r.j1] >= m.y + m.hh - eps

  // Greedy cover: repeatedly take the rectangle containing the most uncovered
  // member cores (ties: larger area). Fewer rectangles ⇒ fewer vertices.
  const chosen: CellRect[] = []
  const uncovered = new Set(work)
  while (uncovered.size > 0) {
    let best: CellRect | null = null
    let bestCnt = 0
    for (const r of cands) {
      let cnt = 0
      for (const m of uncovered) if (containsCore(r, members[m])) cnt++
      if (cnt > bestCnt || (cnt === bestCnt && cnt > 0 && best !== null && r.area > best.area)) {
        best = r
        bestCnt = cnt
      }
    }
    if (!best) {
      // No free rectangle holds a remaining core (degenerate overlap) — treat
      // those members as unreachable rather than emitting a broken shape.
      for (const m of uncovered) excluded.add(m)
      break
    }
    chosen.push(best)
    for (const m of [...uncovered]) if (containsCore(best, members[m])) uncovered.delete(m)
  }
  const inRegion = work.filter(m => !excluded.has(m))

  const mark = new Uint8Array(cols * rows)
  const fill = (r: CellRect): void => {
    for (let j = r.j0; j < r.j1; j++) {
      for (let i = r.i0; i < r.i1; i++) mark[j * cols + i] = 1
    }
  }
  for (const r of chosen) fill(r)

  // Connect the union: while members sit in different pieces, add the single
  // rectangle that bridges the most pieces (ties: larger area). When no one
  // rectangle spans a junction, fall back to fattening a shortest free path
  // with the largest rectangles that contain it.
  for (let guard = 0; guard < 64 && inRegion.length > 1; guard++) {
    const comp = labelComponents(mark, cols, rows)
    const memberComps = new Set<number>()
    for (const m of inRegion) memberComps.add(comp.label[memberCell[m]])
    if (memberComps.size <= 1) break

    let best: CellRect | null = null
    let bestCnt = 0
    for (const r of cands) {
      const seen = new Set<number>()
      for (let j = r.j0; j < r.j1; j++) {
        for (let i = r.i0; i < r.i1; i++) {
          const l = comp.label[j * cols + i]
          if (l >= 0 && memberComps.has(l)) seen.add(l)
        }
      }
      if (seen.size >= 2 &&
          (seen.size > bestCnt || (seen.size === bestCnt && best !== null && r.area > best.area))) {
        best = r
        bestCnt = seen.size
      }
    }
    if (best) { fill(best); continue }

    const path = bridgePath(mark, free, comp.label, memberComps, memberCell[inRegion[0]], cols, rows)
    if (!path) break // cannot happen: all inRegion members share one free component
    for (const idx of path) {
      if (mark[idx]) continue
      const ci = idx % cols, cj = (idx - ci) / cols
      let fat: CellRect | null = null
      for (const r of cands) {
        if (ci >= r.i0 && ci < r.i1 && cj >= r.j0 && cj < r.j1 && (!fat || r.area > fat.area)) fat = r
      }
      if (fat) fill(fat)
      else mark[idx] = 1
    }
  }

  // Defensive: drop any piece that ended up holding no member.
  {
    const comp = labelComponents(mark, cols, rows)
    const keep = new Set<number>()
    for (const m of inRegion) keep.add(comp.label[memberCell[m]])
    for (let s = 0; s < mark.length; s++) {
      if (mark[s] && !keep.has(comp.label[s])) mark[s] = 0
    }
  }

  const loops = traceBoundaryLoops(mark, cols, rows, xs, ys)
  return {
    loops: loops.map(simplifyCollinear).filter(loop => loop.length >= 3),
    excluded: [...excluded].sort((a, b) => a - b),
  }
}

// All maximal axis-aligned rectangles of free cells: for every row band, the
// maximal horizontal runs of fully-free columns, kept only when the band cannot
// be extended up or down across the full run. Prefix sums keep this
// O(rows² · cols).
function maximalFreeRects(
  free: Uint8Array,
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
): CellRect[] {
  const colPref = new Int32Array((rows + 1) * cols)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      colPref[(j + 1) * cols + i] = colPref[j * cols + i] + free[j * cols + i]
    }
  }
  const rowPref = new Int32Array(rows * (cols + 1))
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      rowPref[j * (cols + 1) + i + 1] = rowPref[j * (cols + 1) + i] + free[j * cols + i]
    }
  }
  const rowHasBlocked = (j: number, i0: number, i1: number): boolean =>
    rowPref[j * (cols + 1) + i1] - rowPref[j * (cols + 1) + i0] < i1 - i0

  const out: CellRect[] = []
  for (let j0 = 0; j0 < rows; j0++) {
    for (let j1 = j0 + 1; j1 <= rows; j1++) {
      const bandFree = (i: number): boolean =>
        colPref[j1 * cols + i] - colPref[j0 * cols + i] === j1 - j0
      let i = 0
      while (i < cols) {
        if (!bandFree(i)) { i++; continue }
        let i1 = i
        while (i1 < cols && bandFree(i1)) i1++
        const upMax = j0 === 0 || rowHasBlocked(j0 - 1, i, i1)
        const downMax = j1 === rows || rowHasBlocked(j1, i, i1)
        if (upMax && downMax) {
          out.push({ i0: i, i1, j0, j1, area: (xs[i1] - xs[i]) * (ys[j1] - ys[j0]) })
        }
        i = i1
      }
    }
  }
  return out
}

// 4-connected components over truthy cells.
function labelComponents(
  mask: Uint8Array,
  cols: number,
  rows: number,
): { label: Int32Array; cellCount: number[] } {
  const label = new Int32Array(cols * rows).fill(-1)
  const cellCount: number[] = []
  let nComp = 0
  const stack: number[] = []
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue
    const cid = nComp++
    cellCount[cid] = 0
    label[s] = cid
    stack.push(s)
    while (stack.length) {
      const idx = stack.pop()!
      cellCount[cid]++
      const i = idx % cols, j = (idx - i) / cols
      const nbrs = [
        i > 0 ? idx - 1 : -1,
        i < cols - 1 ? idx + 1 : -1,
        j > 0 ? idx - cols : -1,
        j < rows - 1 ? idx + cols : -1,
      ]
      for (const nb of nbrs) {
        if (nb >= 0 && mask[nb] && label[nb] < 0) { label[nb] = cid; stack.push(nb) }
      }
    }
  }
  return { label, cellCount }
}

// The component holding the most member cells (ties: more cells).
function dominantComponent(
  comp: { label: Int32Array; cellCount: number[] },
  memberCell: number[],
): number {
  const memberCount = new Map<number, number>()
  for (const c of memberCell) {
    const l = comp.label[c]
    if (l >= 0) memberCount.set(l, (memberCount.get(l) ?? 0) + 1)
  }
  let best = -1
  for (const [l, cnt] of memberCount) {
    if (best < 0) { best = l; continue }
    const bestCnt = memberCount.get(best)!
    if (cnt > bestCnt || (cnt === bestCnt && comp.cellCount[l] > comp.cellCount[best])) best = l
  }
  return best
}

// BFS through free cells from one union component to the nearest cell of any
// other member-holding component; returns the path cells, or null.
function bridgePath(
  mark: Uint8Array,
  free: Uint8Array,
  label: Int32Array,
  memberComps: Set<number>,
  startCell: number,
  cols: number,
  rows: number,
): number[] | null {
  const startComp = label[startCell]
  const parent = new Int32Array(cols * rows).fill(-2) // -2 unvisited, -1 source
  const queue: number[] = []
  for (let s = 0; s < mark.length; s++) {
    if (mark[s] && label[s] === startComp) { parent[s] = -1; queue.push(s) }
  }
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head]
    if (label[idx] >= 0 && label[idx] !== startComp && memberComps.has(label[idx])) {
      const path: number[] = []
      for (let cur = idx; cur >= 0 && parent[cur] !== -1; cur = parent[cur]) path.push(cur)
      return path
    }
    const i = idx % cols, j = (idx - i) / cols
    const nbrs = [
      i > 0 ? idx - 1 : -1,
      i < cols - 1 ? idx + 1 : -1,
      j > 0 ? idx - cols : -1,
      j < rows - 1 ? idx + cols : -1,
    ]
    for (const nb of nbrs) {
      if (nb >= 0 && free[nb] && parent[nb] === -2) { parent[nb] = idx; queue.push(nb) }
    }
  }
  return null
}

function cellIndex(breaks: number[], v: number, count: number): number {
  for (let i = 0; i < count; i++) {
    if (v >= breaks[i] && v <= breaks[i + 1]) return i
  }
  if (v < breaks[0]) return 0
  return count - 1
}

// Sorted unique cell boundaries clamped to [lo, hi], endpoints always included.
function compressCuts(values: number[], lo: number, hi: number): number[] {
  const rLo = round(lo), rHi = round(hi)
  const set = new Set<number>([rLo, rHi])
  for (const v of values) {
    const r = round(v)
    if (r > rLo && r < rHi) set.add(r)
  }
  return [...set].sort((a, b) => a - b)
}

// Collect directed boundary edges using each inside cell's own clockwise
// winding (screen coords: x→right, y→down) and walk them into closed loops.
// A unit cell border is a boundary exactly when its outward neighbour is
// outside; only the inside cell emits it, so the whole boundary is consistently
// wound (outer loops clockwise, holes counter-clockwise).
function traceBoundaryLoops(
  grid: Uint8Array,
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
): Pt[][] {
  const at = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows && grid[j * cols + i] !== 0

  const key = (i: number, j: number): number => j * (cols + 1) + i
  const out = new Map<number, Array<{ i: number; j: number }>>()
  const addEdge = (ai: number, aj: number, bi: number, bj: number): void => {
    const k = key(ai, aj)
    const list = out.get(k)
    if (list) list.push({ i: bi, j: bj })
    else out.set(k, [{ i: bi, j: bj }])
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!grid[j * cols + i]) continue
      if (!at(i, j - 1)) addEdge(i, j, i + 1, j)         // top edge, →
      if (!at(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1) // right edge, ↓
      if (!at(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1) // bottom edge, ←
      if (!at(i - 1, j)) addEdge(i, j + 1, i, j)         // left edge, ↑
    }
  }

  // At a degree-4 corner (two regions kissing diagonally) prefer the sharpest
  // clockwise turn so loops stay simple and non-crossing.
  const loops: Pt[][] = []
  for (const [startKey, startList] of out) {
    while (startList.length > 0) {
      const start = { i: startKey % (cols + 1), j: Math.floor(startKey / (cols + 1)) }
      const first = startList.shift()!
      const loop: Array<{ i: number; j: number }> = [start]
      let prev = start
      let cur = first
      while (cur.i !== start.i || cur.j !== start.j) {
        loop.push(cur)
        const list = out.get(key(cur.i, cur.j))
        if (!list || list.length === 0) break
        const inDir = { x: cur.i - prev.i, y: cur.j - prev.j }
        let bestIdx = 0
        if (list.length > 1) bestIdx = pickClockwise(inDir, cur, list)
        const next = list.splice(bestIdx, 1)[0]
        prev = cur
        cur = next
      }
      loops.push(loop.map(p => ({ x: xs[p.i], y: ys[p.j] })))
    }
  }
  return loops
}

// Choose the outgoing edge that turns most clockwise relative to the incoming
// direction (keeps the traced region on a consistent side at junctions).
function pickClockwise(
  inDir: { x: number; y: number },
  cur: { i: number; j: number },
  list: Array<{ i: number; j: number }>,
): number {
  // Clockwise turn order, starting from a right turn: right, straight, left, back.
  const score = (d: { x: number; y: number }): number => {
    // cross > 0 => clockwise turn in screen coords; dot orders within.
    const cross = inDir.x * d.y - inDir.y * d.x
    const dot = inDir.x * d.x + inDir.y * d.y
    if (cross > 0) return 0 // clockwise (right)
    if (cross === 0 && dot > 0) return 1 // straight
    if (cross < 0) return 2 // counter-clockwise (left)
    return 3 // reverse
  }
  let bestIdx = 0
  let best = 99
  for (let k = 0; k < list.length; k++) {
    const d = { x: list[k].i - cur.i, y: list[k].j - cur.j }
    const s = score(d)
    if (s < best) { best = s; bestIdx = k }
  }
  return bestIdx
}

// Drop collinear interior points so each retained vertex is a real corner.
function simplifyCollinear(loop: Pt[]): Pt[] {
  const n = loop.length
  if (n < 3) return loop
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]
    const cur = loop[i]
    const next = loop[(i + 1) % n]
    const ax = cur.x - prev.x, ay = cur.y - prev.y
    const bx = next.x - cur.x, by = next.y - cur.y
    if (ax * by - ay * bx !== 0) out.push(cur) // turn here
  }
  return out.length >= 3 ? out : loop
}

// Minimum distance from a segment to an axis-aligned rectangle (0 on overlap).
function segRectDist(s: GroupExcludeSegment, rx0: number, ry0: number, rx1: number, ry1: number): number {
  const inR = (x: number, y: number): boolean => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1
  if (inR(s.x1, s.y1) || inR(s.x2, s.y2)) return 0
  const corners = [
    { x: rx0, y: ry0 }, { x: rx1, y: ry0 },
    { x: rx1, y: ry1 }, { x: rx0, y: ry1 },
  ]
  let best = Infinity
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4]
    if (segmentsCross(s.x1, s.y1, s.x2, s.y2, a.x, a.y, b.x, b.y)) return 0
    best = Math.min(
      best,
      pointSegDist(a.x, a.y, s.x1, s.y1, s.x2, s.y2),
      pointSegDist(b.x, b.y, s.x1, s.y1, s.x2, s.y2),
      pointSegDist(s.x1, s.y1, a.x, a.y, b.x, b.y),
      pointSegDist(s.x2, s.y2, a.x, a.y, b.x, b.y),
    )
  }
  return best
}

function segmentsCross(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px)
  const d1 = o(bx1, by1, bx2, by2, ax1, ay1)
  const d2 = o(bx1, by1, bx2, by2, ax2, ay2)
  const d3 = o(ax1, ay1, ax2, ay2, bx1, by1)
  const d4 = o(ax1, ay1, ax2, ay2, bx2, by2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function pointSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Emit a closed sub-path with rounded corners. Each corner is replaced by a
// quadratic bezier whose radius is clamped to half the shorter adjacent edge.
function roundedRectilinearPath(poly: Pt[], radius: number): string {
  const n = poly.length
  if (n < 3) return ''
  const seg = (a: Pt, b: Pt): { len: number; ux: number; uy: number } => {
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    return { len, ux: len ? dx / len : 0, uy: len ? dy / len : 0 }
  }
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]
    const cur = poly[i]
    const next = poly[(i + 1) % n]
    const inSeg = seg(prev, cur)
    const outSeg = seg(cur, next)
    const r = Math.min(radius, inSeg.len / 2, outSeg.len / 2)
    const start = { x: cur.x - inSeg.ux * r, y: cur.y - inSeg.uy * r }
    const end = { x: cur.x + outSeg.ux * r, y: cur.y + outSeg.uy * r }
    if (i === 0) d += `M ${round(start.x)} ${round(start.y)}`
    else d += ` L ${round(start.x)} ${round(start.y)}`
    d += ` Q ${round(cur.x)} ${round(cur.y)} ${round(end.x)} ${round(end.y)}`
  }
  return d + ' Z'
}

const round = (v: number): number => Math.round(v * 100) / 100
