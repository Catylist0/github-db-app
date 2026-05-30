const NS = 'http://www.w3.org/2000/svg'

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

// Half-dimensions of a node rect
const NODE_HW = 60
const NODE_HH = 20

// Point on the rect boundary (centered at tx,ty) in the direction toward (fx,fy)
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
