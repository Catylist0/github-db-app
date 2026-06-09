import type { Node, NodeStatus, Edge, EdgeRouting } from '../types'

const NS = 'http://www.w3.org/2000/svg'

export const NODE_CLASS_FILLS: Record<string, string> = {
  UI:       '#04200f',
  Logic:    '#4a1212',
  Graphics: '#2e1a52',
  Sound:    '#4a2e14',
  Research: '#008094',
}
export const NODE_DEFAULT_FILL = '#1f2937'

export function nodeClassFill(cls?: string | null): string {
  return cls ? (NODE_CLASS_FILLS[cls] ?? NODE_DEFAULT_FILL) : NODE_DEFAULT_FILL
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

export const NODE_HW = 60
// Minimum / default half-height. Nodes grow taller than this when their label
// wraps onto multiple lines (see nodeHeight).
export const NODE_HH = 20

// Text layout inside a node. Width is fixed; height grows to fit wrapped lines.
const NODE_WIDTH = NODE_HW * 2
const TEXT_PADDING_X = 10
const MAX_TEXT_WIDTH = NODE_WIDTH - 2 * TEXT_PADDING_X
const FONT_SIZE = 13
const NODE_FONT = `${FONT_SIZE}px system-ui`
const LINE_HEIGHT = 16
const NODE_MIN_HEIGHT = NODE_HH * 2
const NODE_VERT_PADDING = 12

let _measureCtx: CanvasRenderingContext2D | null = null
function measureText(s: string): number {
  if (!_measureCtx) {
    _measureCtx = document.createElement('canvas').getContext('2d')
    if (_measureCtx) _measureCtx.font = NODE_FONT
  }
  // Fallback estimate if a 2d context is unavailable (e.g. headless).
  return _measureCtx ? _measureCtx.measureText(s).width : s.length * FONT_SIZE * 0.6
}

// Hard-break a single word that is wider than the node on its own.
function breakLongWord(word: string): string[] {
  if (measureText(word) <= MAX_TEXT_WIDTH) return [word]
  const parts: string[] = []
  let cur = ''
  for (const ch of word) {
    if (!cur || measureText(cur + ch) <= MAX_TEXT_WIDTH) cur += ch
    else { parts.push(cur); cur = ch }
  }
  if (cur) parts.push(cur)
  return parts
}

// Split a label into lines that each fit within the node's inner width,
// breaking on whitespace (and hard-breaking any single word that is too long).
export function wrapLabel(label: string): string[] {
  const words = label.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    for (const piece of breakLongWord(word)) {
      const test = cur ? `${cur} ${piece}` : piece
      if (!cur || measureText(test) <= MAX_TEXT_WIDTH) {
        cur = test
      } else {
        lines.push(cur)
        cur = piece
      }
    }
  }
  if (cur) lines.push(cur)
  return lines
}

export function nodeHeight(lineCount: number): number {
  return Math.max(NODE_MIN_HEIGHT, lineCount * LINE_HEIGHT + NODE_VERT_PADDING)
}

export function nodeHalfHeight(label: string): number {
  return nodeHeight(wrapLabel(label).length) / 2
}

export const NODE_STROKE_WIDTH = 1.5
export const SELECTED_NODE_STROKE_WIDTH = NODE_STROKE_WIDTH * 2

export function edgeEndpoint(fx: number, fy: number, tx: number, ty: number, hh: number = NODE_HH): { x: number; y: number } {
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

export function nodeIsReady(node: Node, edges: Edge[], nodeMap: Map<string, Node>): boolean {
  if (node.status !== 'planned') return false
  // Only solid edges are hard dependencies. Dashed edges are soft links — the
  // preceding node need not be complete before this one can be started.
  return edges
    .filter(e => e.to === node.id && e.style === 'solid')
    .every(e => nodeMap.get(e.from)?.status === 'complete')
}

export function nodeBorderColor(node: Node, edges: Edge[], nodeMap: Map<string, Node>): string {
  if (node.status === 'ongoing') return '#f97316'
  if (node.status === 'complete') return '#22c55e'
  return nodeIsReady(node, edges, nodeMap) ? '#e6edf3' : '#4b5563'
}

// Edges are colour-coded by the state of their origin node, so a glance shows
// which work each dependency flows out of. One colour per state — readiness
// (the white/grey split used for node borders) is intentionally ignored here.
export function statusEdgeColor(status: NodeStatus): string {
  if (status === 'ongoing') return '#f97316'
  if (status === 'complete') return '#22c55e'
  return '#4b5563'
}

// Arrow markers attach at their centre so the stroke stops before the tip.
export const ARROW_MARKER_WIDTH = 10
export const ARROW_MARKER_REF = ARROW_MARKER_WIDTH / 2
// Clearance between the arrow tip and the destination node border.
export const ARROW_NODE_GAP = 6
// Pull the rendered path end back from the node border by this much: half the
// arrow (so the stroke meets the marker centre) plus the tip gap above.
export const ARROW_PATH_INSET = ARROW_MARKER_REF + ARROW_NODE_GAP

export function shortenLastSegment(segs: Seg[], amount = ARROW_PATH_INSET): Seg[] {
  if (segs.length === 0) return segs
  const last = { ...segs[segs.length - 1] }
  const dx = last.x2 - last.x1
  const dy = last.y2 - last.y1
  const len = Math.hypot(dx, dy)
  if (len <= amount) return segs
  const f = (len - amount) / len
  last.x2 = last.x1 + dx * f
  last.y2 = last.y1 + dy * f
  return [...segs.slice(0, -1), last]
}

export function displayPathFromSegments(segs: Seg[]): string {
  return segmentsToPath(shortenLastSegment(segs))
}

export function edgeMarkerUrl(status: NodeStatus, highlight = false): string {
  return highlight ? 'url(#arrowhead-hl)' : `url(#arrowhead-${status})`
}

export function appendArrowheadMarkers(defs: SVGDefsElement): void {
  const specs: { id: string; fill: string }[] = [
    { id: 'arrowhead-planned', fill: statusEdgeColor('planned') },
    { id: 'arrowhead-ongoing', fill: statusEdgeColor('ongoing') },
    { id: 'arrowhead-complete', fill: statusEdgeColor('complete') },
    { id: 'arrowhead-hl', fill: '#e6edf3' },
  ]
  for (const { id, fill } of specs) {
    const marker = svgEl('marker')
    marker.id = id
    marker.setAttribute('markerWidth', String(ARROW_MARKER_WIDTH))
    marker.setAttribute('markerHeight', '7')
    marker.setAttribute('refX', String(ARROW_MARKER_REF))
    marker.setAttribute('refY', '3.5')
    marker.setAttribute('orient', 'auto')
    const poly = svgEl('polygon')
    poly.setAttribute('points', '0 0, 10 3.5, 0 7')
    poly.setAttribute('fill', fill)
    marker.appendChild(poly)
    defs.appendChild(marker)
  }
}

export function setPulse(rect: SVGRectElement, active: boolean): void {
  const existing = rect.querySelector('animate[data-role="pulse"]')
  if (active && !existing) {
    const anim = svgEl('animate')
    anim.dataset.role = 'pulse'
    anim.setAttribute('attributeName', 'stroke-width')
    anim.setAttribute('values', `${NODE_STROKE_WIDTH};${SELECTED_NODE_STROKE_WIDTH};${NODE_STROKE_WIDTH}`)
    anim.setAttribute('dur', '1s')
    anim.setAttribute('repeatCount', 'indefinite')
    anim.setAttribute('calcMode', 'spline')
    anim.setAttribute('keyTimes', '0;0.5;1')
    anim.setAttribute('keySplines', '0.5 0 0.5 1;0.5 0 0.5 1')
    rect.appendChild(anim)
  } else if (!active && existing) {
    existing.remove()
    rect.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))
  }
}

// ── Edge geometry ─────────────────────────────────────────────────────────────

export type Seg = { x1: number; y1: number; x2: number; y2: number }

export function segPathLength(segs: Seg[]): number {
  return segs.reduce((sum, s) => {
    const dx = s.x2 - s.x1
    const dy = s.y2 - s.y1
    return sum + Math.sqrt(dx * dx + dy * dy)
  }, 0)
}

export type VanishOtherEdge = { id: string; segs: Seg[]; vanish: boolean; length: number }

export interface EdgeGeometry {
  d: string
  midX: number
  midY: number
  segments: Seg[]
}

type Pt = { x: number; y: number }
type ElbowShape = { d: string; midX: number; midY: number; segments: Seg[] }

// Clearance kept between a routed bend line and the node row/column it skirts.
const ELBOW_GAP = 30

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
  obstacles: Node[],
  fromPos: { x: number; y: number; hh?: number },
  toPos: { x: number; y: number; hh?: number },
): number {
  let score = 0
  for (const s of shape.segments) {
    for (const n of obstacles) {
      const nhh = nodeHalfHeight(n.label)
      if (segBoxOverlap(s, n.x - NODE_HW, n.y - nhh, NODE_HW * 2, nhh * 2) > 1) score += 100
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
  obstacles: Node[],
  fromPos: { x: number; y: number; hh?: number },
  toPos: { x: number; y: number; hh?: number },
): ElbowShape {
  let best = candidates[0]
  let bestScore = elbowScore(best.shape, obstacles, fromPos, toPos) + best.pref
  for (const cand of candidates.slice(1)) {
    const score = elbowScore(cand.shape, obstacles, fromPos, toPos) + cand.pref
    if (score < bestScore) { best = cand; bestScore = score }
  }
  return best.shape
}

export function computeEdgeGeometry(
  fromPos: { x: number; y: number; hh?: number },
  toPos: { x: number; y: number; hh?: number },
  routing: EdgeRouting = 'straight',
  obstacles: Node[] = [],
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
    const shape = pickElbow([
      { shape: elbow1Shape(fc, tc, fromHH, toHH, { x: tc.x, y: fc.y }), pref: preferH ? 0 : 1 },
      { shape: elbow1Shape(fc, tc, fromHH, toHH, { x: fc.x, y: tc.y }), pref: preferH ? 1 : 0 },
    ], obstacles, fromPos, toPos)
    return shape
  }

  if (routing === 'elbow2') {
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
    ], obstacles, fromPos, toPos)
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

// ── Parallel-line stacking ─────────────────────────────────────────────────────

// Centre-to-centre distance between neighbouring lines in a stack: the 2px
// stroke plus ~2px of clear gap ("one line-width" of separation).
const STACK_SPACING = 4
// Max perpendicular gap for two parallel segments to be treated as the same
// stack (i.e. visually overlapping / crowded).
const STACK_PROXIMITY = 6
// Straighter single-segment lines snap to node sides while elbow buses run
// further out — use a wider capture band when pulling them into a stack.
const STACK_STRAIGHT_PROXIMITY = 24
// Min axial overlap before two parallel segments count as running "alongside".
const STACK_MIN_OVERLAP = 8
// Keep a stacked node-attachment point this far from the node's corners.
const STACK_NODE_MARGIN = 4
const STRAIGHTEN_MAX_ANGLE_DEG = 5
const STRAIGHTEN_MAX_ANGLE_TAN = Math.tan((STRAIGHTEN_MAX_ANGLE_DEG * Math.PI) / 180)

export function segmentsToPath(segs: Seg[]): string {
  if (segs.length === 0) return ''
  let d = `M ${segs[0].x1} ${segs[0].y1}`
  for (const s of segs) d += ` L ${s.x2} ${s.y2}`
  return d
}

type StackOrient = 'H' | 'V'
type NodePosFn = (id: string) => { x: number; y: number; hh: number }

interface StackEdgeRec {
  id: string
  fromId: string
  toId: string
  points: Pt[]            // length k+1
  orients: StackOrient[]  // length k, alternating
}

interface StackSegRec {
  edgeId: string
  segIndex: number
  orient: StackOrient
  perp: number            // shared coord: y for H, x for V
  lo: number              // axial span start
  hi: number              // axial span end
  nodeIds: string[]       // node(s) this segment's endpoint(s) attach to (0–2)
  straightSingle: boolean // axis-aligned / straightened routing === 'straight'
}

function orientOf(s: Seg): StackOrient {
  return Math.abs(s.y2 - s.y1) < 0.5 ? 'H' : 'V'
}

function isAxisAlignedSeg(s: Seg): boolean {
  const adx = Math.abs(s.x2 - s.x1)
  const ady = Math.abs(s.y2 - s.y1)
  return Math.max(adx, ady) >= 1 && (ady < 0.5 || adx < 0.5)
}

function isStackableStraight(segs: Seg[], originalSegs: Seg[], routing: EdgeRouting): boolean {
  if (routing !== 'straight' || segs.length !== 1) return false
  // Snapped by straightenStraight, or already axis-aligned in router output.
  return segs !== originalSegs || isAxisAlignedSeg(segs[0])
}

function stackProximity(...segs: StackSegRec[]): number {
  return segs.some(s => s.straightSingle) ? STACK_STRAIGHT_PROXIMITY : STACK_PROXIMITY
}

function canStackTogether(a: StackSegRec, b: StackSegRec): boolean {
  if (a.orient !== b.orient) return false
  if (Math.abs(a.perp - b.perp) > stackProximity(a, b)) return false
  const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo)
  return overlap >= STACK_MIN_OVERLAP
}

// True when seg runs alongside the group's corridor (proximate + overlaps the
// group's combined axial span, even if it barely touches any single member).
function segNearGroup(seg: StackSegRec, group: StackSegRec[]): boolean {
  if (group.length === 0 || seg.orient !== group[0].orient) return false
  const perpDist = Math.min(...group.map(m => Math.abs(m.perp - seg.perp)))
  if (perpDist > stackProximity(seg, ...group)) return false
  const lo = Math.min(...group.map(m => m.lo))
  const hi = Math.max(...group.map(m => m.hi))
  const overlap = Math.min(seg.hi, hi) - Math.max(seg.lo, lo)
  return overlap >= STACK_MIN_OVERLAP
}

function groupsCanMerge(a: StackSegRec[], b: StackSegRec[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (canStackTogether(x, y)) return true
    }
  }
  for (const x of a) {
    if (segNearGroup(x, b)) return true
  }
  for (const x of b) {
    if (segNearGroup(x, a)) return true
  }
  return false
}

function buildStacksFromPool(pool: StackSegRec[]): StackSegRec[][] {
  const parent = pool.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a: number, b: number): void => { parent[find(a)] = find(b) }
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (canStackTogether(pool[i], pool[j])) union(i, j)
    }
  }
  const grouped = new Map<number, StackSegRec[]>()
  for (let i = 0; i < pool.length; i++) {
    const r = find(i)
    ;(grouped.get(r) ?? grouped.set(r, []).get(r)!).push(pool[i])
  }
  let groups = [...grouped.values()]

  // Merge clusters when a segment sits near the combined corridor of another
  // group (common for straightened straights running beside elbow stacks).
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (groupsCanMerge(groups[i], groups[j])) {
          groups[i] = groups[i].concat(groups[j])
          groups.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }

  const stacks: StackSegRec[][] = []
  for (const members of groups) {
    if (members.length >= 2) {
      stacks.push(members.sort((a, b) => a.perp - b.perp || (a.edgeId < b.edgeId ? -1 : 1)))
    }
  }
  return stacks
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// A straight edge within STRAIGHTEN_MAX_ANGLE_DEG of horizontal or vertical —
// and whose snapped axis-aligned form would still land on both nodes' sides
// (their perpendicular ranges overlap) — is snapped to that axis and returned as
// a single axis-aligned segment so it can join a stack. Steeper diagonals return
// null and stay as drawn.
function straightenStraight(fromId: string, toId: string, nodePos: NodePosFn): Seg[] | null {
  const f = nodePos(fromId)
  const t = nodePos(toId)
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
    const y = clamp((f.y + t.y) / 2, yLo, yHi)
    const fromX = f.x + (dx > 0 ? NODE_HW : -NODE_HW)
    const toX = t.x + (dx > 0 ? -NODE_HW : NODE_HW)
    return [{ x1: fromX, y1: y, x2: toX, y2: y }]
  }
  if (nearVertical && xLo <= xHi) {
    const x = clamp((f.x + t.x) / 2, xLo, xHi)
    const fromY = f.y + (dy > 0 ? f.hh : -f.hh)
    const toY = t.y + (dy > 0 ? -t.hh : t.hh)
    return [{ x1: x, y1: fromY, x2: x, y2: toY }]
  }
  return null
}

// Allowed perpendicular range for a segment so its node-attached endpoint(s)
// stay on the node side(s). For a straightened single segment attached to both
// nodes this is the intersection of the two ranges. null = unconstrained.
function segPerpRange(orient: StackOrient, nodeIds: string[], nodePos: NodePosFn): { lo: number; hi: number } | null {
  if (nodeIds.length === 0) return null
  let lo = -Infinity, hi = Infinity
  for (const id of nodeIds) {
    const np = nodePos(id)
    const c = orient === 'H' ? np.y : np.x
    const lim = (orient === 'H' ? np.hh : NODE_HW) - STACK_NODE_MARGIN
    lo = Math.max(lo, c - lim)
    hi = Math.min(hi, c + lim)
  }
  return { lo, hi }
}

// Reconstruct an edge's points after applying perpendicular offsets to its
// segments. A horizontal segment's offset shifts y; a vertical segment's offset
// shifts x. Each point is shifted by the offsets of the (≤2) segments incident
// to it; because both ends of a segment receive the same shift, segments stay
// axis-aligned and the polyline stays connected.
function reconstructPoints(rec: StackEdgeRec, offsets: Map<string, number>): Pt[] {
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

function pointsToSegs(pts: Pt[]): Seg[] {
  const segs: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  }
  return segs
}

// Count crossings under a candidate offset map between every edge and the given
// stack's member edges (pairs of two non-members are unaffected by this stack's
// ordering and are skipped). Reconstructing the full polylines — not just the
// stacked segment — lets the score see crossings at the corners where one stack
// feeds into another, so H and V stacks can be ordered to agree.
function countCrossings(memberIds: Set<string>, recById: Map<string, StackEdgeRec>, offsets: Map<string, number>): number {
  const polys = [...recById.values()].map(rec => ({ id: rec.id, segs: pointsToSegs(reconstructPoints(rec, offsets)) }))
  let n = 0
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (!memberIds.has(polys[i].id) && !memberIds.has(polys[j].id)) continue
      for (const a of polys[i].segs) {
        for (const b of polys[j].segs) {
          if (segIntersectT(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) !== null) n++
        }
      }
    }
  }
  return n
}

// Stacks that share any edge belong to the same bundle (e.g. horizontal run
// feeding into a vertical run on the same elbow edges). They must be ordered
// with a single edge permutation or corner joints cross.
function buildStackBundles(stacks: StackSegRec[][]): StackSegRec[][][] {
  const n = stacks.length
  if (n === 0) return []
  const parent = stacks.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a: number, b: number): void => { parent[find(a)] = find(b) }
  for (let i = 0; i < n; i++) {
    const ids = new Set(stacks[i].map(m => m.edgeId))
    for (let j = i + 1; j < n; j++) {
      if (stacks[j].some(m => ids.has(m.edgeId))) union(i, j)
    }
  }
  const groups = new Map<number, StackSegRec[][]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    ;(groups.get(r) ?? groups.set(r, []).get(r)!).push(stacks[i])
  }
  return [...groups.values()]
}

// Signed turn at the corner after segment segIndex (screen coords: y grows down).
// Negative ⇒ clockwise; positive ⇒ counter-clockwise.
function cornerCrossZ(rec: StackEdgeRec, segIndex: number): number | null {
  if (segIndex < 0 || segIndex + 2 >= rec.points.length) return null
  if (rec.orients[segIndex] === rec.orients[segIndex + 1]) return null
  const ax = rec.points[segIndex + 1].x - rec.points[segIndex].x
  const ay = rec.points[segIndex + 1].y - rec.points[segIndex].y
  const bx = rec.points[segIndex + 2].x - rec.points[segIndex + 1].x
  const by = rec.points[segIndex + 2].y - rec.points[segIndex + 1].y
  return ax * by - ay * bx
}

// At a corner the incoming parallel stack must flip its edge order relative to
// the outgoing stack on clockwise turns (e.g. right-then-up), but keep it on
// counter-clockwise turns (e.g. right-then-down).
function stackOrderReversed(stack: StackSegRec[], recById: Map<string, StackEdgeRec>): boolean {
  const m = stack[0]
  const rec = recById.get(m.edgeId)
  if (!rec) return false
  const i = m.segIndex
  if (i + 1 >= rec.orients.length || rec.orients[i] === rec.orients[i + 1]) return false
  const cross = cornerCrossZ(rec, i)
  return cross !== null && cross < 0
}

function orderStackByEdges(stack: StackSegRec[], edgeOrder: string[], reversed = false): StackSegRec[] {
  const order = reversed ? [...edgeOrder].reverse() : edgeOrder
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...stack].sort((a, b) =>
    (rank.get(a.edgeId) ?? 0) - (rank.get(b.edgeId) ?? 0) || a.segIndex - b.segIndex,
  )
}

// Build the offset map for one ordered stack: members are laid onto an evenly
// spaced ladder centred on their mean perpendicular position. Spacing is reduced
// when the ladder would otherwise overflow the tightest node edge it attaches to.
function assignStackOffsets(order: StackSegRec[], nodePos: NodePosFn, into: Map<string, number>): void {
  const n = order.length
  const mean = order.reduce((s, m) => s + m.perp, 0) / n

  // Tightest node-edge capacity among node-attached members limits the ladder.
  let availableSpan = Infinity
  for (const m of order) {
    const r = segPerpRange(m.orient, m.nodeIds, nodePos)
    if (r) availableSpan = Math.min(availableSpan, r.hi - r.lo)
  }
  const spacing = n > 1 ? Math.min(STACK_SPACING, Math.max(0, availableSpan) / (n - 1)) : 0

  order.forEach((m, i) => {
    const target = mean + (i - (n - 1) / 2) * spacing
    // Safety net: keep node-attached endpoint(s) on the node edge(s).
    const r = segPerpRange(m.orient, m.nodeIds, nodePos)
    const finalPerp = r ? clamp(target, r.lo, r.hi) : target
    into.set(`${m.edgeId}#${m.segIndex}`, finalPerp - m.perp)
  })
}

// Spread overlapping parallel elbow segments into evenly spaced stacks, ordered
// to minimise crossings between the edges' continuations. Runs after the router
// has chosen each elbow's shape; straight edges pass through unchanged.
export function stackEdgeSegments(
  items: { id: string; fromId: string; toId: string; routing: EdgeRouting; segments: Seg[] }[],
  nodePos: NodePosFn,
): Map<string, { segments: Seg[]; midX: number; midY: number }> {
  const recById = new Map<string, StackEdgeRec>()
  const segRecs: StackSegRec[] = []

  for (const it of items) {
    // Elbows are already axis-aligned; near-straight straight edges are snapped
    // so they too can stack. Genuinely diagonal edges pass through unchanged.
    let segs = it.segments
    if (it.routing === 'straight') {
      const straightened = straightenStraight(it.fromId, it.toId, nodePos)
      if (straightened) segs = straightened
    }
    const stackable = segs.length >= 1 && (
      it.routing === 'elbow1' || it.routing === 'elbow2' || isStackableStraight(segs, it.segments, it.routing)
    )

    const points: Pt[] = segs.length
      ? [{ x: segs[0].x1, y: segs[0].y1 }, ...segs.map(s => ({ x: s.x2, y: s.y2 }))]
      : []
    const orients = segs.map(orientOf)
    recById.set(it.id, { id: it.id, fromId: it.fromId, toId: it.toId, points, orients })
    if (!stackable) continue

    segs.forEach((s, i) => {
      const orient = orients[i]
      const len = orient === 'H' ? Math.abs(s.x2 - s.x1) : Math.abs(s.y2 - s.y1)
      if (len < 1) return
      const perp = orient === 'H' ? s.y1 : s.x1
      const lo = orient === 'H' ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2)
      const hi = orient === 'H' ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2)
      const nodeIds: string[] = []
      if (i === 0) nodeIds.push(it.fromId)
      if (i === segs.length - 1) nodeIds.push(it.toId)  // single segment ⇒ both
      const straightSingle = it.routing === 'straight' && segs.length === 1
      segRecs.push({ edgeId: it.id, segIndex: i, orient, perp, lo, hi, nodeIds, straightSingle })
    })
  }

  // Group parallel proximate segments into stacks (pairwise + corridor envelope).
  const stacks: StackSegRec[][] = []
  for (const orient of ['H', 'V'] as StackOrient[]) {
    stacks.push(...buildStacksFromPool(segRecs.filter(s => s.orient === orient)))
  }

  // Lay out stacks bundle-by-bundle. Contiguous H/V stacks on the same edges
  // share one edge ordering; clockwise corners reverse the incoming stack's
  // application of that order so the ladder matches the turn geometry.
  const offsets = new Map<string, number>()
  for (const bundle of buildStackBundles(stacks)) {
    const edgeIds = [...new Set(bundle.flatMap(s => s.map(m => m.edgeId)))]
    const meanPerp = (id: string): number => {
      let sum = 0, count = 0
      for (const stack of bundle) {
        for (const m of stack) {
          if (m.edgeId === id) { sum += m.perp; count++ }
        }
      }
      return count ? sum / count : 0
    }
    edgeIds.sort((a, b) => meanPerp(a) - meanPerp(b) || (a < b ? -1 : 1))

    const memberIds = new Set(edgeIds)
    const layoutBundle = (order: string[], into: Map<string, number>): void => {
      for (const stack of bundle) {
        const reversed = stackOrderReversed(stack, recById)
        assignStackOffsets(orderStackByEdges(stack, order, reversed), nodePos, into)
      }
    }
    const scoreOf = (order: string[]): number => {
      const tmp = new Map(offsets)
      layoutBundle(order, tmp)
      return countCrossings(memberIds, recById, tmp)
    }

    let best = scoreOf(edgeIds)
    let improved = true
    while (improved && best > 0) {
      improved = false
      for (let i = 0; i < edgeIds.length - 1; i++) {
        ;[edgeIds[i], edgeIds[i + 1]] = [edgeIds[i + 1], edgeIds[i]]
        const s = scoreOf(edgeIds)
        if (s < best) { best = s; improved = true }
        else { [edgeIds[i], edgeIds[i + 1]] = [edgeIds[i + 1], edgeIds[i]] }
      }
    }

    for (const stack of bundle) {
      const reversed = stackOrderReversed(stack, recById)
      const ordered = orderStackByEdges(stack, edgeIds, reversed)
      stack.length = 0
      stack.push(...ordered)
      assignStackOffsets(stack, nodePos, offsets)
    }
  }

  // Reconstruct every edge from the accumulated offsets (straight / unstacked
  // edges have no offsets and pass through unchanged).
  const result = new Map<string, { segments: Seg[]; midX: number; midY: number }>()
  for (const it of items) {
    const rec = recById.get(it.id)!
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
    result.set(it.id, { segments, midX, midY })
  }
  return result
}

// ── Vanish mask ───────────────────────────────────────────────────────────────

// Fade starts this far before the intersection so the line is already fully
// gone by the time it would overlap. Buffer is the fully-transparent zone
// added on each side of the actual intersection; fade is the gradual transition.
const VANISH_BUFFER = 14   // px of fully-invisible zone around intersection
const VANISH_FADE = 28     // px of gradient transition into/out of invisible zone

function lineBoxIntersect(
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

function segIntersectT(
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

// Returns mask element (in defs, caller must append to defs).
// Returns null if no intersections found — caller should remove any existing mask.
export function buildVanishMask(
  edgeId: string,
  mySegs: Seg[],
  myLength: number,
  fromId: string,
  toId: string,
  allNodes: Node[],
  otherEdges: VanishOtherEdge[],
  defs: SVGDefsElement,
): SVGMaskElement | null {
  // Collect all [tIn, tOut] fade intervals per segment (in t coords 0..1 of segment)
  type FadeRect = {
    startX: number; startY: number
    endX: number; endY: number
    totalLen: number; fadeFrac: number
  }
  const rects: FadeRect[] = []

  for (const seg of mySegs) {
    const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1
    const L = Math.sqrt(dx * dx + dy * dy)
    if (L < 1) continue

    type Iv = { tIn: number; tOut: number }
    const intervals: Iv[] = []

    // Node bbox intersections
    for (const n of allNodes) {
      if (n.id === fromId || n.id === toId) continue
      const nhh = nodeHalfHeight(n.label)
      const hit = lineBoxIntersect(seg.x1, seg.y1, seg.x2, seg.y2, n.x - NODE_HW, n.y - nhh, NODE_HW * 2, nhh * 2)
      if (hit) intervals.push(hit)
    }

    // Edge-segment intersections — treat each crossing as a zero-width interval.
    // When both edges vanish, only the longer edge fades at the crossing.
    for (const other of otherEdges) {
      for (const os of other.segs) {
        const t = segIntersectT(seg.x1, seg.y1, seg.x2, seg.y2, os.x1, os.y1, os.x2, os.y2)
        if (t === null) continue
        if (other.vanish) {
          if (myLength < other.length) continue
          if (myLength === other.length && edgeId > other.id) continue
        }
        const hw = VANISH_BUFFER / L
        intervals.push({ tIn: t - hw, tOut: t + hw })
      }
    }

    if (intervals.length === 0) continue

    // Sort and merge overlapping OR proximate intervals.
    // Two intervals whose expanded fade zones would overlap must be merged into one,
    // otherwise their gradient rects fight for the mask alpha and produce hard edges.
    // The expansion on each side is (VANISH_BUFFER + VANISH_FADE), so the minimum
    // gap between two intervals before their fade zones touch is twice that.
    const MERGE_GAP_T = 2 * (VANISH_BUFFER + VANISH_FADE) / L
    intervals.sort((a, b) => a.tIn - b.tIn)
    const merged: Iv[] = []
    for (const iv of intervals) {
      if (merged.length > 0 && iv.tIn <= merged[merged.length - 1].tOut + MERGE_GAP_T) {
        merged[merged.length - 1].tOut = Math.max(merged[merged.length - 1].tOut, iv.tOut)
      } else {
        merged.push({ ...iv })
      }
    }

    for (const iv of merged) {
      // Zone: fully invisible from (tIn - BUFFER/L) to (tOut + BUFFER/L)
      // Fade starts FADE pixels before that, ends FADE pixels after
      const fadeInStart = Math.max(0, iv.tIn - (VANISH_BUFFER + VANISH_FADE) / L)
      const zoneEnd = Math.min(1, iv.tOut + (VANISH_BUFFER + VANISH_FADE) / L)

      const startX = seg.x1 + fadeInStart * dx
      const startY = seg.y1 + fadeInStart * dy
      const endX = seg.x1 + zoneEnd * dx
      const endY = seg.y1 + zoneEnd * dy

      const zdx = endX - startX, zdy = endY - startY
      const totalLen = Math.sqrt(zdx * zdx + zdy * zdy)
      if (totalLen < 1) continue

      // fadeFrac: fraction of total zone taken by one fade ramp.
      // The invisible zone occupies (1 - 2*fadeFrac) of the total.
      const fadeFrac = Math.min(0.49, VANISH_FADE / totalLen)

      rects.push({ startX, startY, endX, endY, totalLen, fadeFrac })
    }
  }

  if (rects.length === 0) return null

  // Remove any old gradients for this edge from defs
  cleanupVanishDefs(edgeId, defs)

  const mask = svgEl('mask')
  mask.id = `vm-${edgeId}`
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  // Explicit bounds in graph-coordinate space — prevents the browser from applying
  // the default (-10%…+120% of SVG viewport) which clips the mask at a visible line.
  mask.setAttribute('x', '-10000')
  mask.setAttribute('y', '-10000')
  mask.setAttribute('width', '30000')
  mask.setAttribute('height', '30000')

  // White background: show entire path
  const bg = svgEl('rect')
  bg.setAttribute('x', '-10000')
  bg.setAttribute('y', '-10000')
  bg.setAttribute('width', '30000')
  bg.setAttribute('height', '30000')
  bg.setAttribute('fill', 'white')
  mask.appendChild(bg)

  // For each fade zone, add a gradient rect in the mask (black = hide)
  rects.forEach((r, i) => {
    const gradId = `vm-g-${edgeId}-${i}`

    const grad = svgEl('linearGradient')
    grad.id = gradId
    // userSpaceOnUse in the rect's own local coordinate system (x: 0→totalLen, y: 0→2*HALF_H).
    // Keeping the gradient in all-positive local coords avoids browser bugs with
    // objectBoundingBox when the bounding box straddles y=0.
    grad.setAttribute('gradientUnits', 'userSpaceOnUse')
    grad.setAttribute('x1', '0')
    grad.setAttribute('y1', '0')
    grad.setAttribute('x2', String(r.totalLen))
    grad.setAttribute('y2', '0')

    const addStop = (offset: number, color: string): void => {
      const s = svgEl('stop')
      s.setAttribute('offset', String(offset))
      s.setAttribute('stop-color', color)
      grad.appendChild(s)
    }
    // white → black → black → white
    addStop(0, 'white')
    addStop(r.fadeFrac, 'black')
    addStop(1 - r.fadeFrac, 'black')
    addStop(1, 'white')

    defs.appendChild(grad)

    const angle = Math.atan2(r.endY - r.startY, r.endX - r.startX) * 180 / Math.PI
    const HALF_H = 60

    // Rect sits entirely in positive local y (0 to 2*HALF_H). The extra
    // translate(0,-HALF_H) centres it on the edge after the rotation.
    const rect = svgEl('rect')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', '0')
    rect.setAttribute('width', String(r.totalLen))
    rect.setAttribute('height', String(HALF_H * 2))
    rect.setAttribute('fill', `url(#${gradId})`)
    rect.setAttribute('transform', `translate(${r.startX},${r.startY}) rotate(${angle}) translate(0,${-HALF_H})`)
    mask.appendChild(rect)
  })

  return mask
}

// Removes the mask element and associated gradients for an edge.
export function cleanupVanishDefs(edgeId: string, defs: SVGDefsElement): void {
  defs.querySelector(`#vm-${edgeId}`)?.remove()
  // Remove per-zone gradients (placed directly in defs)
  const toRemove = defs.querySelectorAll(`[id^="vm-g-${edgeId}-"]`)
  toRemove.forEach(el => el.remove())
}

// ── Edge path element ─────────────────────────────────────────────────────────

export function makeEdgePath(
  fromPos: { x: number; y: number; hh?: number },
  toPos: { x: number; y: number; hh?: number },
  fromId: string,
  toId: string,
  edge?: Partial<Edge>,
  obstacles: Node[] = [],
  fromStatus: NodeStatus = 'planned',
): SVGPathElement {
  const routing: EdgeRouting = edge?.routing ?? 'straight'
  const edgeId = edge?.id ?? `${fromId}-${toId}`
  const geo = computeEdgeGeometry(fromPos, toPos, routing, obstacles)

  const path = svgEl('path')
  path.setAttribute('d', displayPathFromSegments(geo.segments))
  path.setAttribute('stroke', statusEdgeColor(fromStatus))
  path.setAttribute('stroke-width', '2')
  path.setAttribute('fill', 'none')
  path.setAttribute('marker-end', edgeMarkerUrl(fromStatus))
  if (edge?.style === 'dashed') path.setAttribute('stroke-dasharray', '6 4')
  path.dataset.from = fromId
  path.dataset.to = toId
  path.dataset.edgeId = edgeId
  path.dataset.midX = String(geo.midX)
  path.dataset.midY = String(geo.midY)

  return path
}

// ── Node element ──────────────────────────────────────────────────────────────

export function makeNodeEl(node: Node, borderColor = '#4b5563', pulse = false): SVGGElement {
  const lines = wrapLabel(node.label)
  const height = nodeHeight(lines.length)
  const halfHeight = height / 2

  const g = svgEl('g')
  g.dataset.nodeId = node.id
  g.dataset.cx = String(node.x)
  g.dataset.cy = String(node.y)
  g.dataset.hh = String(halfHeight)
  g.setAttribute('transform', `translate(${node.x - NODE_HW},${node.y - halfHeight})`)
  g.style.cursor = 'grab'

  const rect = svgEl('rect')
  rect.setAttribute('width', String(NODE_WIDTH))
  rect.setAttribute('height', String(height))
  rect.setAttribute('rx', '8')
  rect.setAttribute('fill', nodeClassFill(node.nodeClass))
  rect.setAttribute('stroke', borderColor)
  rect.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))

  const text = svgEl('text')
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'middle')
  text.setAttribute('fill', '#e6edf3')
  text.setAttribute('font-size', String(FONT_SIZE))
  text.setAttribute('font-family', 'system-ui')
  text.setAttribute('pointer-events', 'none')
  text.style.userSelect = 'none'

  // Stack each wrapped line, centred vertically about the node's middle.
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan')
    tspan.setAttribute('x', String(NODE_HW))
    tspan.setAttribute('y', String(halfHeight + (i - (lines.length - 1) / 2) * LINE_HEIGHT))
    tspan.textContent = line
    text.appendChild(tspan)
  })

  if (pulse) setPulse(rect, true)

  g.appendChild(rect)
  g.appendChild(text)
  return g
}
