import type { Graph, GraphAPI } from '../types'
import { svgEl, makeEdgePath } from './utils'
import { addInteraction } from './interaction'

export function renderGraph(
  graph: Graph,
  container: HTMLElement,
  api: GraphAPI,
): void {
  container.innerHTML = ''

  const svg = svgEl('svg')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  svg.style.display = 'block'

  // Arrowhead marker
  const defs = svgEl('defs')
  const marker = svgEl('marker')
  marker.id = 'arrowhead'
  marker.setAttribute('markerWidth', '10')
  marker.setAttribute('markerHeight', '7')
  marker.setAttribute('refX', '10')
  marker.setAttribute('refY', '3.5')
  marker.setAttribute('orient', 'auto')
  const arrowPoly = svgEl('polygon')
  arrowPoly.setAttribute('points', '0 0, 10 3.5, 0 7')
  arrowPoly.setAttribute('fill', '#444')
  marker.appendChild(arrowPoly)
  defs.appendChild(marker)
  svg.appendChild(defs)

  const viewport = svgEl('g')
  viewport.id = 'viewport'
  svg.appendChild(viewport)

  // Edges — drawn first so they sit behind nodes
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  for (const edge of graph.edges) {
    const from = nodeMap.get(edge.from)!
    const to = nodeMap.get(edge.to)!
    viewport.appendChild(makeEdgePath(from, to, edge.from, edge.to))
  }

  // Nodes
  for (const node of graph.nodes) {
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
    rect.setAttribute('stroke', '#4b5563')
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
    text.textContent = node.label

    g.appendChild(rect)
    g.appendChild(text)
    viewport.appendChild(g)
  }

  container.appendChild(svg)
  addInteraction(svg, viewport, graph, api)
}
