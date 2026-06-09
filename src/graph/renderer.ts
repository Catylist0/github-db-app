import type { Graph, GraphAPI, GraphChanges } from '../types'
import { svgEl, makeEdgePath, makeNodeEl, nodeBorderColor, nodeIsReady, nodeHalfHeight } from './utils'
import { addInteraction } from './interaction'

export function renderGraph(
  graph: Graph,
  container: HTMLElement,
  api: GraphAPI,
  options?: { onFocusNode?: (nodeId: string | null) => void },
): { setAuthenticated: (auth: boolean) => void; centerOnNode: (id: string) => void; undo: () => void; redo: () => void; applyRemoteChanges: (changes: GraphChanges) => boolean } {
  container.innerHTML = ''

  const svg = svgEl('svg')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  svg.style.display = 'block'

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

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  for (const edge of graph.edges) {
    const from = nodeMap.get(edge.from)!
    const to = nodeMap.get(edge.to)!
    const fromPos = { x: from.x, y: from.y, hh: nodeHalfHeight(from.label) }
    const toPos = { x: to.x, y: to.y, hh: nodeHalfHeight(to.label) }
    const obstacles = graph.nodes.filter(n => n.id !== edge.from && n.id !== edge.to)
    viewport.appendChild(makeEdgePath(fromPos, toPos, edge.from, edge.to, edge, obstacles, from.status))
  }

  for (const node of graph.nodes) {
    viewport.appendChild(makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap)))
  }

  container.appendChild(svg)
  return addInteraction(svg, viewport, graph, api, options)
}
