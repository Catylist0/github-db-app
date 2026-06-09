import type { Graph, GraphAPI, GraphChanges } from '../types'
import { svgEl, makeEdgePath, makeNodeEl, nodeBorderColor, nodeIsReady, nodeHalfHeight, appendArrowheadMarkers } from './utils'
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
  appendArrowheadMarkers(defs)
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
