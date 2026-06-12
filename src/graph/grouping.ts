// Pure geometry for grouping regions. Given the rectangles of a group's member
// nodes (and the rectangles of every other, non-member node), this computes an
// Euler-diagram-style rectilinear outline.
//
// The region is the simplest reasonable axis-aligned shape: the padded bounding
// box of all members, minus keep-out boxes around non-members — conceptually the
// cheap version of unioning the members' rectangular voronoi cells. Two hard
// rules shape the result:
//
//   • No enclaves: the region never contains an interior hole. When a carved
//     keep-out would be fully surrounded, a channel is opened from it to the
//     nearest boundary — but only for genuinely enclosed cutouts, and along the
//     cheapest direction that keeps the members connected.
//   • No exclaves: the region is a single connected shape. If carving splits it,
//     the component holding the most members wins and the rest are reported as
//     `excluded` so the caller can drop them from the group.
//
// Edges whose two endpoints are both non-members are avoided softly: their
// capsule is carved out unless doing so would disconnect the members, in which
// case the edge is ignored ("unless it's not possible").
//
// Nothing here touches the DOM, so it can be unit-tested in node. The result is
// an SVG path `d` string with only horizontal/vertical edges and rounded corners.

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
// rounded corners (sub-paths joined).
export function loopsToPath(loops: Pt[][], corner: number = DEFAULTS.corner): string {
  return loops.map(loop => roundedRectilinearPath(loop, corner)).filter(Boolean).join(' ')
}

// Even-odd point-in-polygon over a set of loops.
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
  const segments = options.excludeSegments ?? []

  // Outer envelope: one padded axis-aligned box around every member. The grid
  // spans exactly this box, so every cell is implicitly "in the bbox".
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x - m.hw - memberPad)
    minY = Math.min(minY, m.y - m.hh - memberPad)
    maxX = Math.max(maxX, m.x + m.hw + memberPad)
    maxY = Math.max(maxY, m.y + m.hh + memberPad)
  }

  // Coordinate-compressed grid: cell boundaries only at meaningful x/y values,
  // so the traced outline has as few vertices as the geometry allows.
  const xCuts: number[] = []
  const yCuts: number[] = []
  for (const m of members) {
    xCuts.push(m.x - m.hw, m.x + m.hw)
    yCuts.push(m.y - m.hh, m.y + m.hh)
  }
  for (const n of nonMembers) {
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

  // Fill: a cell is inside unless a non-member keep-out covers it. A member's
  // own core rectangle is always kept (and can never be carved later), so
  // members are never cut out by anything sitting on top of them.
  const grid: boolean[] = new Array(cols * rows)
  const core = new Uint8Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i
      const px = (xs[i] + xs[i + 1]) / 2
      const py = (ys[j] + ys[j + 1]) / 2
      let isCore = false
      for (const m of members) {
        if (inRect(px, py, m, 0)) { isCore = true; break }
      }
      core[idx] = isCore ? 1 : 0
      if (isCore) { grid[idx] = true; continue }
      let blocked = false
      for (const n of nonMembers) {
        if (inRect(px, py, n, excludePad)) { blocked = true; break }
      }
      grid[idx] = !blocked
    }
  }

  // The cell each member's centre lives in — used for connectivity checks.
  const memberCells = members.map(m =>
    cellIndex(ys, m.y, rows) * cols + cellIndex(xs, m.x, cols))

  // Soft carve: non-member-only edges are avoided unless removing their capsule
  // would disconnect the members, in which case that edge is skipped.
  for (const s of segments) {
    const sMinX = Math.min(s.x1, s.x2) - excludePad
    const sMaxX = Math.max(s.x1, s.x2) + excludePad
    const sMinY = Math.min(s.y1, s.y2) - excludePad
    const sMaxY = Math.max(s.y1, s.y2) + excludePad
    const removed: number[] = []
    for (let j = 0; j < rows; j++) {
      if (ys[j + 1] < sMinY || ys[j] > sMaxY) continue
      for (let i = 0; i < cols; i++) {
        if (xs[i + 1] < sMinX || xs[i] > sMaxX) continue
        const idx = j * cols + i
        if (!grid[idx] || core[idx]) continue
        // Strictly inside the capsule: a cell the capsule only touches at its
        // edge has zero overlap and must not be carved.
        if (segRectDist(s, xs[i], ys[j], xs[i + 1], ys[j + 1]) < excludePad - 1e-7) removed.push(idx)
      }
    }
    if (removed.length === 0) continue
    for (const idx of removed) grid[idx] = false
    if (!membersConnected(grid, cols, rows, memberCells)) {
      for (const idx of removed) grid[idx] = true
    }
  }

  // No enclaves: any carved-out pocket not connected to the boundary gets a
  // channel to the nearest edge — choosing, among the four directions, the one
  // that keeps members connected and removes the least area. Channels never cut
  // through member cores; if every direction is blocked by a core the hole is
  // left and its loop is dropped at the end (the non-member reads as inside,
  // the lesser evil to an enclave ring).
  openEnclosedHoles(grid, core, cols, rows, xs, ys, memberCells)

  // No exclaves: keep the component holding the most members; report the rest.
  const { excluded } = keepMainComponent(grid, members, cols, rows, xs, ys)

  const loops = traceBoundaryLoops(grid, cols, rows, xs, ys)
  return {
    loops: keepOuterLoops(loops.map(simplifyCollinear).filter(loop => loop.length >= 3)),
    excluded,
  }
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

// BFS over inside cells: do all member cells share one connected component?
function membersConnected(grid: boolean[], cols: number, rows: number, memberCells: number[]): boolean {
  if (memberCells.length <= 1) return true
  const targets = new Set(memberCells)
  const seen = new Uint8Array(cols * rows)
  const stack = [memberCells[0]]
  seen[memberCells[0]] = 1
  let found = 0
  while (stack.length) {
    const idx = stack.pop()!
    if (targets.has(idx)) {
      targets.delete(idx)
      found++
      if (targets.size === 0) return true
    }
    const i = idx % cols, j = (idx - i) / cols
    const nbrs = [
      i > 0 ? idx - 1 : -1,
      i < cols - 1 ? idx + 1 : -1,
      j > 0 ? idx - cols : -1,
      j < rows - 1 ? idx + cols : -1,
    ]
    for (const nb of nbrs) {
      if (nb >= 0 && grid[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb) }
    }
  }
  return targets.size === 0
}

// Outside cells (grid=false) not reachable from the grid border are holes.
function findHoles(grid: boolean[], cols: number, rows: number): number[][] {
  const mark = new Int8Array(cols * rows) // 0 unvisited, 1 reaches border, 2 hole
  const stack: number[] = []
  const seed = (idx: number): void => {
    if (!grid[idx] && mark[idx] === 0) { mark[idx] = 1; stack.push(idx) }
  }
  for (let i = 0; i < cols; i++) { seed(i); seed((rows - 1) * cols + i) }
  for (let j = 0; j < rows; j++) { seed(j * cols); seed(j * cols + cols - 1) }
  while (stack.length) {
    const idx = stack.pop()!
    const i = idx % cols, j = (idx - i) / cols
    const nbrs = [
      i > 0 ? idx - 1 : -1,
      i < cols - 1 ? idx + 1 : -1,
      j > 0 ? idx - cols : -1,
      j < rows - 1 ? idx + cols : -1,
    ]
    for (const nb of nbrs) {
      if (nb >= 0 && !grid[nb] && mark[nb] === 0) { mark[nb] = 1; stack.push(nb) }
    }
  }
  const holes: number[][] = []
  for (let s = 0; s < grid.length; s++) {
    if (grid[s] || mark[s] !== 0) continue
    const hole: number[] = []
    mark[s] = 2
    stack.push(s)
    while (stack.length) {
      const idx = stack.pop()!
      hole.push(idx)
      const i = idx % cols, j = (idx - i) / cols
      const nbrs = [
        i > 0 ? idx - 1 : -1,
        i < cols - 1 ? idx + 1 : -1,
        j > 0 ? idx - cols : -1,
        j < rows - 1 ? idx + cols : -1,
      ]
      for (const nb of nbrs) {
        if (nb >= 0 && !grid[nb] && mark[nb] === 0) { mark[nb] = 2; stack.push(nb) }
      }
    }
    holes.push(hole)
  }
  return holes
}

// Open every enclosed hole with the cheapest viable straight channel to the
// boundary. Re-scans after each carve since one channel can open several holes.
function openEnclosedHoles(
  grid: boolean[],
  core: Uint8Array,
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
  memberCells: number[],
): void {
  const failed = new Set<number>()
  for (let guard = 0; guard < 64; guard++) {
    const holes = findHoles(grid, cols, rows).filter(h => !failed.has(h[0]))
    if (holes.length === 0) return
    const hole = holes[0]
    let i0 = cols, i1 = -1, j0 = rows, j1 = -1
    for (const idx of hole) {
      const i = idx % cols, j = (idx - i) / cols
      if (i < i0) i0 = i
      if (i > i1) i1 = i
      if (j < j0) j0 = j
      if (j > j1) j1 = j
    }
    // Channel rectangles from the hole's bounds to each grid edge.
    const rects = [
      { ia: 0, ib: i0 - 1, ja: j0, jb: j1 },      // left
      { ia: i1 + 1, ib: cols - 1, ja: j0, jb: j1 }, // right
      { ia: i0, ib: i1, ja: 0, jb: j0 - 1 },      // up
      { ia: i0, ib: i1, ja: j1 + 1, jb: rows - 1 }, // down
    ]
    let best: { cells: number[]; area: number; connected: boolean } | null = null
    for (const r of rects) {
      const cells: number[] = []
      let area = 0
      let blocked = false
      for (let j = r.ja; j <= r.jb && !blocked; j++) {
        for (let i = r.ia; i <= r.ib; i++) {
          const idx = j * cols + i
          if (core[idx]) { blocked = true; break }
          if (!grid[idx]) continue
          cells.push(idx)
          area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
        }
      }
      if (blocked) continue
      for (const idx of cells) grid[idx] = false
      const connected = membersConnected(grid, cols, rows, memberCells)
      for (const idx of cells) grid[idx] = true
      if (!best ||
          (connected && !best.connected) ||
          (connected === best.connected && area < best.area)) {
        best = { cells, area, connected }
      }
    }
    if (!best) { failed.add(hole[0]); continue }
    for (const idx of best.cells) grid[idx] = false
  }
}

// Drop any interior hole loop that could not be opened — enclaves are banned.
function keepOuterLoops(loops: Pt[][]): Pt[][] {
  if (loops.length <= 1) return loops
  const outer = loops.filter(loop => loopSignedArea(loop) > 0)
  return outer.length > 0 ? outer : loops
}

// Signed area in screen coords (y down): positive for clockwise outer loops.
function loopSignedArea(loop: Pt[]): number {
  let a = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

// Flood-fill the inside grid into connected components (4-connectivity), keep
// the component containing the most members (ties broken by cell count), clear
// every other cell, and return the indices of members left outside it.
function keepMainComponent(
  grid: boolean[],
  members: GroupRect[],
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
): { excluded: number[] } {
  const label = new Int32Array(cols * rows).fill(-1)
  const cellCount: number[] = []
  let nComp = 0
  const stack: number[] = []
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || label[s] >= 0) continue
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
        if (nb >= 0 && grid[nb] && label[nb] < 0) { label[nb] = cid; stack.push(nb) }
      }
    }
  }
  if (nComp <= 1) return { excluded: [] }

  const memberComp = members.map(m => {
    const i = cellIndex(xs, m.x, cols)
    const j = cellIndex(ys, m.y, rows)
    return label[j * cols + i]
  })

  const memberCount = new Array(nComp).fill(0)
  for (const c of memberComp) if (c >= 0) memberCount[c]++
  let main = 0
  for (let c = 1; c < nComp; c++) {
    if (memberCount[c] > memberCount[main] ||
        (memberCount[c] === memberCount[main] && cellCount[c] > cellCount[main])) main = c
  }

  const excluded: number[] = []
  for (let m = 0; m < members.length; m++) if (memberComp[m] !== main) excluded.push(m)
  for (let s = 0; s < grid.length; s++) if (label[s] !== main) grid[s] = false
  return { excluded }
}

function cellIndex(breaks: number[], v: number, count: number): number {
  for (let i = 0; i < count; i++) {
    if (v >= breaks[i] && v <= breaks[i + 1]) return i
  }
  if (v < breaks[0]) return 0
  return count - 1
}

// Collect directed boundary edges using each inside cell's own clockwise
// winding (screen coords: x→right, y→down) and walk them into closed loops.
// A unit cell border is a boundary exactly when its outward neighbour is
// outside; only the inside cell emits it, so the whole boundary is consistently
// wound (outer loops clockwise, holes counter-clockwise).
function traceBoundaryLoops(
  grid: boolean[],
  cols: number,
  rows: number,
  xs: number[],
  ys: number[],
): Pt[][] {
  const at = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows && grid[j * cols + i]

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
