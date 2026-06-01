import type { Graph, GraphAPI } from '../types'
import { svgEl, makeEdgePath, makeNodeEl, nodeBorderColor, nodeIsReady } from './utils'
import { addInteraction } from './interaction'

export function renderGraph(
  graph: Graph,
  container: HTMLElement,
  api: GraphAPI,
): { setAuthenticated: (auth: boolean) => void; centerOnNode: (id: string) => void; undo: () => void; redo: () => void } {
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

  const markerHl = svgEl('marker')
  markerHl.id = 'arrowhead-hl'
  markerHl.setAttribute('markerWidth', '10')
  markerHl.setAttribute('markerHeight', '7')
  markerHl.setAttribute('refX', '10')
  markerHl.setAttribute('refY', '3.5')
  markerHl.setAttribute('orient', 'auto')
  const arrowPolyHl = svgEl('polygon')
  arrowPolyHl.setAttribute('points', '0 0, 10 3.5, 0 7')
  arrowPolyHl.setAttribute('fill', '#e6edf3')
  markerHl.appendChild(arrowPolyHl)
  defs.appendChild(markerHl)
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
    viewport.appendChild(makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap)))
  }

  container.appendChild(svg)
  return addInteraction(svg, viewport, graph, api)
}
