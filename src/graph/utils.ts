import type { Node, NodeStatus, Edge } from '../types'
import { NODE_HW, NODE_HH, type Seg } from './layout/types'
import { computeEdgeGeometry, edgeMidOverride, lineBoxIntersect, segIntersectT, segPathLength } from './layout/route'
import { NO_OBSTACLES, type ObstacleSource } from './layout/grid'

export { NODE_HW, NODE_HH, segPathLength }
export type { Seg }

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

// Default colour for a freshly created grouping.
export const DEFAULT_GROUP_COLOR = '#58a6ff'

// Parse a #rrggbb (or #rgb) colour to its components, defaulting to the group
// colour if the input is malformed.
function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = DEFAULT_GROUP_COLOR.slice(1)
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

// A darkened version of `hex`, used as the translucent background fill of a
// grouping region (the stroke uses the colour itself).
export function darkenColor(hex: string, factor = 0.35): string {
  const { r, g, b } = parseHex(hex)
  const d = (c: number): number => Math.max(0, Math.round(c * factor))
  return `rgb(${d(r)},${d(g)},${d(b)})`
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

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

// Wrapping is invoked from layout hot paths (node half-heights), so results
// are memoized per label. The font never changes at runtime; the cache is
// bounded only by the set of distinct labels, which is small in practice.
const _wrapCache = new Map<string, string[]>()

// Split a label into lines that each fit within the node's inner width,
// breaking on whitespace (and hard-breaking any single word that is too long).
export function wrapLabel(label: string): string[] {
  const cached = _wrapCache.get(label)
  if (cached) return cached
  const lines = wrapLabelUncached(label)
  _wrapCache.set(label, lines)
  return lines
}

function wrapLabelUncached(label: string): string[] {
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

export function segmentsToPath(segs: Seg[]): string {
  if (segs.length === 0) return ''
  let d = `M ${segs[0].x1} ${segs[0].y1}`
  for (const s of segs) d += ` L ${s.x2} ${s.y2}`
  return d
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

// ── Vanish mask ───────────────────────────────────────────────────────────────

// Fade starts this far before the intersection so the line is already fully
// gone by the time it would overlap. Buffer is the fully-transparent zone
// added on each side of the actual intersection; fade is the gradual transition.
const VANISH_BUFFER = 14   // px of fully-invisible zone around intersection
const VANISH_FADE = 28     // px of gradient transition into/out of invisible zone

export type VanishOtherEdge = { id: string; segs: Seg[]; vanish: boolean; length: number }

// Returns mask element (in defs, caller must append to defs).
// Returns null if no intersections found — caller should remove any existing mask.
export function buildVanishMask(
  edgeId: string,
  mySegs: Seg[],
  myLength: number,
  fromId: string,
  toId: string,
  obstacles: ObstacleSource,
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

    // Node bbox intersections — only nodes near the segment can intersect it,
    // so ask the spatial index instead of scanning the whole graph.
    const nearby = obstacles.query(
      Math.min(seg.x1, seg.x2), Math.min(seg.y1, seg.y2),
      Math.max(seg.x1, seg.x2), Math.max(seg.y1, seg.y2),
    )
    for (const n of nearby) {
      if (n.id === fromId || n.id === toId) continue
      const hit = lineBoxIntersect(seg.x1, seg.y1, seg.x2, seg.y2, n.x - NODE_HW, n.y - n.hh, NODE_HW * 2, n.hh * 2)
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
  obstacles: ObstacleSource = NO_OBSTACLES,
  fromStatus: NodeStatus = 'planned',
): SVGPathElement {
  const routing = edge?.routing ?? 'straight'
  const edgeId = edge?.id ?? `${fromId}-${toId}`
  const geo = computeEdgeGeometry(fromPos, toPos, routing, obstacles, edgeMidOverride(edge), fromId, toId)

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
