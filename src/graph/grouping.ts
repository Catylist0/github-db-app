// Pure geometry for grouping regions. Given the rectangles of a group's member
// nodes (and the rectangles of every other, non-member node), this computes an
// Euler-diagram-style rectilinear outline.
//
// A group is a *single* region: members are bridged together with corridors
// along a minimum spanning tree, so the padded member blobs merge into one
// shape rather than scattering into separate exclave boxes. Non-member nodes are
// carved back out, which can sever a corridor — when that disconnects a member
// from the main body, the member is reported as an exclave so the caller can
// drop it from the group entirely (a group can never have an exclave).
//
// Nothing here touches the DOM, so it can be unit-tested in node. The result is
// an SVG path `d` string with only horizontal/vertical edges and rounded
// corners; interior holes (a non-member fully surrounded by members) are emitted
// as extra sub-paths and rely on the caller using fill-rule: evenodd.

export interface GroupRect {
  x: number // centre
  y: number
  hw: number // half width
  hh: number // half height
}

export interface GroupOutlineOptions {
  memberPad?: number // margin grown around each member before the boundary sits
  excludePad?: number // keep-out margin around each non-member node
  cell?: number // sampling resolution (smaller = smoother, slower)
  corner?: number // corner radius
  corridorHalf?: number // half-width of the bridges that connect members
}

const DEFAULTS = { memberPad: 26, excludePad: 16, cell: 10, corner: 14, corridorHalf: 16 }

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
// rounded corners (sub-paths joined; holes rely on fill-rule: evenodd).
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

// Backward-compatible helper: just the outline loops of the main region.
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
  const cell = options.cell ?? DEFAULTS.cell
  const corridorHalf = options.corridorHalf ?? DEFAULTS.corridorHalf

  // Sampling region: the padded member bounding box, plus a one-cell apron so
  // the boundary always has an "outside" ring of cells to close against.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x - m.hw - memberPad)
    minY = Math.min(minY, m.y - m.hh - memberPad)
    maxX = Math.max(maxX, m.x + m.hw + memberPad)
    maxY = Math.max(maxY, m.y + m.hh + memberPad)
  }
  const x0 = minX - cell
  const y0 = minY - cell
  const cols = Math.ceil((maxX + cell - x0) / cell) + 1
  const rows = Math.ceil((maxY + cell - y0) / cell) + 1

  // Corridors bridging members into one region, routed along a minimum spanning
  // tree (shortest total length) as L-shaped (horizontal-then-vertical) bands.
  const corridors = corridorSegments(members)

  const inRect = (px: number, py: number, r: GroupRect, pad: number): boolean =>
    Math.abs(px - r.x) <= r.hw + pad && Math.abs(py - r.y) <= r.hh + pad

  // A cell (sampled at its centre) is inside when it is within memberPad of a
  // member or on a connecting corridor, and not within excludePad of any
  // non-member — except that a member's own core rectangle is always kept, so
  // members are never carved out by a non-member that sits on top of them.
  const inside = (i: number, j: number): boolean => {
    const px = x0 + (i + 0.5) * cell
    const py = y0 + (j + 0.5) * cell
    let cover = false
    for (const m of members) {
      if (inRect(px, py, m, 0)) return true // member core — always in
      if (inRect(px, py, m, memberPad)) { cover = true; break }
    }
    if (!cover) {
      for (const s of corridors) {
        if (pointSegDist(px, py, s.x1, s.y1, s.x2, s.y2) <= corridorHalf) { cover = true; break }
      }
    }
    if (!cover) return false
    for (const n of nonMembers) {
      if (inRect(px, py, n, excludePad)) return false
    }
    return true
  }

  const grid: boolean[] = new Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) grid[j * cols + i] = inside(i, j)
  }

  // Split the inside cells into connected components, keep the one holding the
  // most members (the main region), and report every member outside it as an
  // exclave. Non-main cells are cleared so only the single region is traced.
  const { excluded } = keepMainComponent(grid, members, cols, rows, x0, y0, cell)

  const at = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows && grid[j * cols + i]

  // Collect directed boundary edges using each inside cell's own clockwise
  // winding (screen coords: x→right, y→down). A unit cell border is a boundary
  // exactly when its outward neighbour is outside; only the inside cell emits
  // it, so the whole boundary is consistently wound (outer loops clockwise,
  // holes counter-clockwise). Corners are integer grid points (i, j).
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

  // Walk the directed edges into closed loops. At a degree-4 corner (two
  // regions kissing diagonally) prefer the sharpest clockwise turn so loops
  // stay simple and non-crossing.
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
      loops.push(loop.map(p => ({ x: x0 + p.i * cell, y: y0 + p.j * cell })))
    }
  }

  return {
    loops: loops.map(simplifyCollinear).filter(loop => loop.length >= 3),
    excluded,
  }
}

// Minimum spanning tree over member centres (Prim's), returned as L-shaped
// corridor segments (horizontal leg then vertical leg) connecting each edge.
function corridorSegments(members: GroupRect[]): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const n = members.length
  const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  if (n <= 1) return segs
  const inTree = new Array(n).fill(false)
  const dist = new Array(n).fill(Infinity)
  const parent = new Array(n).fill(-1)
  dist[0] = 0
  for (let it = 0; it < n; it++) {
    let u = -1, best = Infinity
    for (let v = 0; v < n; v++) if (!inTree[v] && dist[v] < best) { best = dist[v]; u = v }
    if (u === -1) break
    inTree[u] = true
    if (parent[u] >= 0) {
      const a = members[parent[u]], b = members[u]
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: a.y }) // horizontal leg
      segs.push({ x1: b.x, y1: a.y, x2: b.x, y2: b.y }) // vertical leg
    }
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue
      const dx = members[u].x - members[v].x, dy = members[u].y - members[v].y
      const d = dx * dx + dy * dy
      if (d < dist[v]) { dist[v] = d; parent[v] = u }
    }
  }
  return segs
}

function pointSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Flood-fill the inside grid into connected components (4-connectivity), keep
// the component containing the most members (ties broken by cell count), clear
// every other cell, and return the indices of members left outside it.
function keepMainComponent(
  grid: boolean[],
  members: GroupRect[],
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  cell: number,
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

  const clampIdx = (v: number, hi: number): number => Math.max(0, Math.min(hi, v))
  const memberComp = members.map(m => {
    const i = clampIdx(Math.floor((m.x - x0) / cell), cols - 1)
    const j = clampIdx(Math.floor((m.y - y0) / cell), rows - 1)
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
