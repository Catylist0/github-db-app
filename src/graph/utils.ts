import type { Node, Edge } from '../types'

const NS = 'http://www.w3.org/2000/svg'

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

const NODE_HW = 60
const NODE_HH = 20

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
  const existing = rect.querySelector('animate')
  if (active && !existing) {
    const anim = svgEl('animate')
    anim.setAttribute('attributeName', 'stroke-width')
    anim.setAttribute('values', '1.5;3;1.5')
    anim.setAttribute('dur', '1s')
    anim.setAttribute('repeatCount', 'indefinite')
    anim.setAttribute('calcMode', 'spline')
    anim.setAttribute('keyTimes', '0;0.5;1')
    anim.setAttribute('keySplines', '0.5 0 0.5 1;0.5 0 0.5 1')
    rect.appendChild(anim)
  } else if (!active && existing) {
    existing.remove()
    rect.setAttribute('stroke-width', '1.5')
  }
}

export function makeEdgePath(
  fromPos: { x: number; y: number },
  toPos: { x: number; y: number },
  fromId: string,
  toId: string,
): SVGPathElement {
  const path = svgEl('path')
  const start = edgeEndpoint(toPos.x, toPos.y, fromPos.x, fromPos.y)
  const end = edgeEndpoint(fromPos.x, fromPos.y, toPos.x, toPos.y)
  path.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y}`)
  path.setAttribute('stroke', '#444')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('fill', 'none')
  path.setAttribute('marker-end', 'url(#arrowhead)')
  path.dataset.from = fromId
  path.dataset.to = toId
  return path
}

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
  rect.setAttribute('stroke-width', '1.5')

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
