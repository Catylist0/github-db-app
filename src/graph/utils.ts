import type { Node, Edge, EdgeRouting } from '../types'

const NS = 'http://www.w3.org/2000/svg'

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

const NODE_HW = 60
const NODE_HH = 20

export const NODE_STROKE_WIDTH = 1.5
export const SELECTED_NODE_STROKE_WIDTH = NODE_STROKE_WIDTH * 2

export function edgeEndpoint(fx: number, fy: number, tx: number, ty: number): { x: number; y: number } {
  const dx = fx - tx
  const dy = fy - ty
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1) return { x: tx, y: ty }
  const ux = dx / len
  const uy = dy / len
  const t = Math.min(
    Math.abs(ux) > 1e-9 ? NODE_HW / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? NODE_HH / Math.abs(uy) : Infinity,
  )
  return { x: tx + t * ux, y: ty + t * uy }
}

export function nodeIsReady(node: Node, edges: Edge[], nodeMap: Map<string, Node>): boolean {
  if (node.status !== 'planned') return false
  return edges
    .filter(e => e.to === node.id)
    .every(e => nodeMap.get(e.from)?.status === 'complete')
}

export function nodeBorderColor(node: Node, edges: Edge[], nodeMap: Map<string, Node>): string {
  if (node.status === 'ongoing') return '#f97316'
  if (node.status === 'complete') return '#22c55e'
  return nodeIsReady(node, edges, nodeMap) ? '#e6edf3' : '#4b5563'
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

export interface EdgeGeometry {
  d: string
  midX: number
  midY: number
  segments: Seg[]
}

export function computeEdgeGeometry(
  fromPos: { x: number; y: number },
  toPos: { x: number; y: number },
  routing: EdgeRouting = 'straight',
): EdgeGeometry {
  const fc = fromPos
  const tc = toPos

  if (routing === 'elbow1') {
    const dx = tc.x - fc.x
    const dy = tc.y - fc.y
    const bend = Math.abs(dx) >= Math.abs(dy)
      ? { x: tc.x, y: fc.y }
      : { x: fc.x, y: tc.y }
    const start = edgeEndpoint(bend.x, bend.y, fc.x, fc.y)
    const end = edgeEndpoint(bend.x, bend.y, tc.x, tc.y)
    return {
      d: `M ${start.x} ${start.y} L ${bend.x} ${bend.y} L ${end.x} ${end.y}`,
      midX: bend.x,
      midY: bend.y,
      segments: [
        { x1: start.x, y1: start.y, x2: bend.x, y2: bend.y },
        { x1: bend.x, y1: bend.y, x2: end.x, y2: end.y },
      ],
    }
  }

  if (routing === 'elbow2') {
    const midX = (fc.x + tc.x) / 2
    const bend1 = { x: midX, y: fc.y }
    const bend2 = { x: midX, y: tc.y }
    const start = edgeEndpoint(bend1.x, bend1.y, fc.x, fc.y)
    const end = edgeEndpoint(bend2.x, bend2.y, tc.x, tc.y)
    return {
      d: `M ${start.x} ${start.y} L ${bend1.x} ${bend1.y} L ${bend2.x} ${bend2.y} L ${end.x} ${end.y}`,
      midX,
      midY: (fc.y + tc.y) / 2,
      segments: [
        { x1: start.x, y1: start.y, x2: bend1.x, y2: bend1.y },
        { x1: bend1.x, y1: bend1.y, x2: bend2.x, y2: bend2.y },
        { x1: bend2.x, y1: bend2.y, x2: end.x, y2: end.y },
      ],
    }
  }

  // straight
  const start = edgeEndpoint(tc.x, tc.y, fc.x, fc.y)
  const end = edgeEndpoint(fc.x, fc.y, tc.x, tc.y)
  return {
    d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
    midX: (start.x + end.x) / 2,
    midY: (start.y + end.y) / 2,
    segments: [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }],
  }
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
  fromId: string,
  toId: string,
  allNodes: Node[],
  otherEdgeSegs: Seg[][],
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
      const hit = lineBoxIntersect(seg.x1, seg.y1, seg.x2, seg.y2, n.x - NODE_HW, n.y - NODE_HH, NODE_HW * 2, NODE_HH * 2)
      if (hit) intervals.push(hit)
    }

    // Edge-segment intersections — treat each crossing as a zero-width interval
    for (const otherSeg of otherEdgeSegs) {
      for (const os of otherSeg) {
        const t = segIntersectT(seg.x1, seg.y1, seg.x2, seg.y2, os.x1, os.y1, os.x2, os.y2)
        if (t !== null) {
          const hw = VANISH_BUFFER / L
          intervals.push({ tIn: t - hw, tOut: t + hw })
        }
      }
    }

    if (intervals.length === 0) continue

    // Sort and merge overlapping intervals
    intervals.sort((a, b) => a.tIn - b.tIn)
    const merged: Iv[] = []
    for (const iv of intervals) {
      if (merged.length > 0 && iv.tIn <= merged[merged.length - 1].tOut) {
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

  // White background: show entire path
  const bg = svgEl('rect')
  bg.setAttribute('x', '-99999')
  bg.setAttribute('y', '-99999')
  bg.setAttribute('width', '999999')
  bg.setAttribute('height', '999999')
  bg.setAttribute('fill', 'white')
  mask.appendChild(bg)

  // For each fade zone, add a gradient rect in the mask (black = hide)
  rects.forEach((r, i) => {
    const gradId = `vm-g-${edgeId}-${i}`

    const grad = svgEl('linearGradient')
    grad.id = gradId
    // objectBoundingBox: gradient goes along the rect's width axis regardless of rotation
    grad.setAttribute('gradientUnits', 'objectBoundingBox')
    grad.setAttribute('x1', '0')
    grad.setAttribute('y1', '0')
    grad.setAttribute('x2', '1')
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
    const HALF_H = 60  // wide enough to cover the stroke plus some margin

    const rect = svgEl('rect')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', String(-HALF_H))
    rect.setAttribute('width', String(r.totalLen))
    rect.setAttribute('height', String(HALF_H * 2))
    rect.setAttribute('fill', `url(#${gradId})`)
    rect.setAttribute('transform', `translate(${r.startX},${r.startY}) rotate(${angle})`)
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
  fromPos: { x: number; y: number },
  toPos: { x: number; y: number },
  fromId: string,
  toId: string,
  edge?: Partial<Edge>,
): SVGPathElement {
  const routing: EdgeRouting = edge?.routing ?? 'straight'
  const edgeId = edge?.id ?? `${fromId}-${toId}`
  const geo = computeEdgeGeometry(fromPos, toPos, routing)

  const path = svgEl('path')
  path.setAttribute('d', geo.d)
  path.setAttribute('stroke', '#444')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('fill', 'none')
  path.setAttribute('marker-end', 'url(#arrowhead)')
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
  const g = svgEl('g')
  g.dataset.nodeId = node.id
  g.dataset.cx = String(node.x)
  g.dataset.cy = String(node.y)
  g.setAttribute('transform', `translate(${node.x - 60},${node.y - 20})`)
  g.style.cursor = 'grab'

  const rect = svgEl('rect')
  rect.setAttribute('width', '120')
  rect.setAttribute('height', '40')
  rect.setAttribute('rx', '8')
  rect.setAttribute('fill', '#1f2937')
  rect.setAttribute('stroke', borderColor)
  rect.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))

  const text = svgEl('text')
  text.setAttribute('x', '60')
  text.setAttribute('y', '20')
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'middle')
  text.setAttribute('fill', '#e6edf3')
  text.setAttribute('font-size', '13')
  text.setAttribute('font-family', 'system-ui')
  text.setAttribute('pointer-events', 'none')
  text.style.userSelect = 'none'
  text.textContent = node.label

  if (pulse) setPulse(rect, true)

  g.appendChild(rect)
  g.appendChild(text)
  return g
}
