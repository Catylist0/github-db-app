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

export interface EdgeGeometry {
  d: string
  midX: number
  midY: number
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
      ? { x: tc.x, y: fc.y }   // H then V
      : { x: fc.x, y: tc.y }   // V then H
    const start = edgeEndpoint(bend.x, bend.y, fc.x, fc.y)
    const end = edgeEndpoint(bend.x, bend.y, tc.x, tc.y)
    return { d: `M ${start.x} ${start.y} L ${bend.x} ${bend.y} L ${end.x} ${end.y}`, midX: bend.x, midY: bend.y }
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
    }
  }

  // straight
  const start = edgeEndpoint(tc.x, tc.y, fc.x, fc.y)
  const end = edgeEndpoint(fc.x, fc.y, tc.x, tc.y)
  return { d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, midX: (start.x + end.x) / 2, midY: (start.y + end.y) / 2 }
}

// ── Vanish gradient ───────────────────────────────────────────────────────────

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

export function buildVanishGradient(
  edgeId: string,
  startX: number, startY: number,
  endX: number, endY: number,
  fromId: string, toId: string,
  allNodes: Node[],
  color: string,
): SVGLinearGradientElement | null {
  type Interval = { tIn: number; tOut: number }
  const intervals: Interval[] = []

  for (const n of allNodes) {
    if (n.id === fromId || n.id === toId) continue
    const hit = lineBoxIntersect(startX, startY, endX, endY, n.x - NODE_HW, n.y - NODE_HH, NODE_HW * 2, NODE_HH * 2)
    if (hit) intervals.push(hit)
  }

  if (intervals.length === 0) return null

  intervals.sort((a, b) => a.tIn - b.tIn)
  const merged: Interval[] = []
  for (const iv of intervals) {
    if (merged.length > 0 && iv.tIn <= merged[merged.length - 1].tOut) {
      merged[merged.length - 1].tOut = Math.max(merged[merged.length - 1].tOut, iv.tOut)
    } else {
      merged.push({ ...iv })
    }
  }

  const FADE = 0.04
  const stops: Array<{ offset: number; opacity: number }> = [{ offset: 0, opacity: 1 }]
  for (const iv of merged) {
    stops.push({ offset: Math.max(0, iv.tIn - FADE), opacity: 1 })
    stops.push({ offset: iv.tIn, opacity: 0 })
    stops.push({ offset: iv.tOut, opacity: 0 })
    stops.push({ offset: Math.min(1, iv.tOut + FADE), opacity: 1 })
  }
  stops.push({ offset: 1, opacity: 1 })
  stops.sort((a, b) => a.offset - b.offset)

  const grad = svgEl('linearGradient')
  grad.id = `vg-${edgeId}`
  grad.setAttribute('gradientUnits', 'userSpaceOnUse')
  grad.setAttribute('x1', String(startX))
  grad.setAttribute('y1', String(startY))
  grad.setAttribute('x2', String(endX))
  grad.setAttribute('y2', String(endY))

  for (const s of stops) {
    const stop = svgEl('stop')
    stop.setAttribute('offset', String(s.offset))
    stop.setAttribute('stop-color', color)
    stop.setAttribute('stop-opacity', String(s.opacity))
    grad.appendChild(stop)
  }

  return grad
}

// ── Edge path element ─────────────────────────────────────────────────────────

export function makeEdgePath(
  fromPos: { x: number; y: number },
  toPos: { x: number; y: number },
  fromId: string,
  toId: string,
  edge?: Partial<Edge>,
  allNodes?: Node[],
  defs?: SVGDefsElement,
): SVGPathElement {
  const routing: EdgeRouting = edge?.routing ?? 'straight'
  const style = edge?.style ?? 'solid'
  const vanish = edge?.vanish ?? false
  const edgeId = edge?.id ?? `${fromId}-${toId}`

  const geo = computeEdgeGeometry(fromPos, toPos, routing)

  const path = svgEl('path')
  path.setAttribute('d', geo.d)
  path.setAttribute('stroke-width', '2')
  path.setAttribute('fill', 'none')
  path.setAttribute('marker-end', 'url(#arrowhead)')
  path.dataset.from = fromId
  path.dataset.to = toId
  path.dataset.edgeId = edgeId
  path.dataset.midX = String(geo.midX)
  path.dataset.midY = String(geo.midY)

  if (style === 'dashed') path.setAttribute('stroke-dasharray', '6 4')

  // Vanish gradient (straight edges only for now)
  if (vanish && routing === 'straight' && allNodes && defs) {
    const gradId = `vg-${edgeId}`
    defs.querySelector(`#${gradId}`)?.remove()
    const start = edgeEndpoint(toPos.x, toPos.y, fromPos.x, fromPos.y)
    const end = edgeEndpoint(fromPos.x, fromPos.y, toPos.x, toPos.y)
    const grad = buildVanishGradient(edgeId, start.x, start.y, end.x, end.y, fromId, toId, allNodes, '#444')
    if (grad) {
      defs.appendChild(grad)
      path.setAttribute('stroke', `url(#${gradId})`)
    } else {
      path.setAttribute('stroke', '#444')
    }
  } else {
    path.setAttribute('stroke', '#444')
  }

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
