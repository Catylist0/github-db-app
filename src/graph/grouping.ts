// Pure geometry for grouping regions. Given the rectangles of a group's member
// nodes (and the rectangles of every other, non-member node), this computes an
// Euler-diagram-style rectilinear outline that encloses all members, keeps a
// comfortable margin around them, and is carved back to exclude any non-member
// node that would otherwise fall inside.
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
}

const DEFAULTS = { memberPad: 26, excludePad: 16, cell: 10, corner: 14 }

export type Pt = { x: number; y: number }

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

// The rectilinear boundary loops (simplified to real corners only), in screen
// coordinates. Each loop is a closed polygon whose consecutive vertices differ
// in exactly one axis. Exposed separately so the boundary logic is testable
// without parsing SVG path strings.
export function computeGroupLoops(
  members: GroupRect[],
  nonMembers: GroupRect[],
  options: GroupOutlineOptions = {},
): Pt[][] {
  if (members.length === 0) return []
  const memberPad = options.memberPad ?? DEFAULTS.memberPad
  const excludePad = options.excludePad ?? DEFAULTS.excludePad
  const cell = options.cell ?? DEFAULTS.cell

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

  const inRect = (px: number, py: number, r: GroupRect, pad: number): boolean =>
    Math.abs(px - r.x) <= r.hw + pad && Math.abs(py - r.y) <= r.hh + pad

  // A cell (sampled at its centre) is inside when it is within memberPad of a
  // member, and not within excludePad of any non-member — except that a
  // member's own core rectangle is always kept, so members are never carved out
  // by a non-member that happens to sit on top of them.
  const inside = (i: number, j: number): boolean => {
    const px = x0 + (i + 0.5) * cell
    const py = y0 + (j + 0.5) * cell
    let inMember = false
    for (const m of members) {
      if (inRect(px, py, m, 0)) return true // member core — always in
      if (inRect(px, py, m, memberPad)) inMember = true
    }
    if (!inMember) return false
    for (const n of nonMembers) {
      if (inRect(px, py, n, excludePad)) return false
    }
    return true
  }

  const grid: boolean[] = new Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) grid[j * cols + i] = inside(i, j)
  }
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

  return loops.map(simplifyCollinear).filter(loop => loop.length >= 3)
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
