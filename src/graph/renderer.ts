import type { Graph } from '../types'
import { addInteraction } from './interaction'

const NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

export function renderGraph(graph: Graph, container: HTMLElement): void {
  container.innerHTML = ''

  const svg = el('svg')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  svg.style.display = 'block'

  const viewport = el('g')
  viewport.id = 'viewport'
  svg.appendChild(viewport)

  // Edges — drawn first so they sit behind nodes
  for (const edge of graph.edges) {
    const from = graph.nodes.find(n => n.id === edge.from)!
    const to = graph.nodes.find(n => n.id === edge.to)!
    const line = el('line')
    line.setAttribute('x1', String(from.x))
    line.setAttribute('y1', String(from.y))
    line.setAttribute('x2', String(to.x))
    line.setAttribute('y2', String(to.y))
    line.setAttribute('stroke', '#444')
    line.setAttribute('stroke-width', '2')
    line.dataset.from = edge.from
    line.dataset.to = edge.to
    viewport.appendChild(line)
  }

  // Nodes
  for (const node of graph.nodes) {
    const g = el('g')
    g.dataset.nodeId = node.id
    g.dataset.cx = String(node.x)
    g.dataset.cy = String(node.y)
    g.setAttribute('transform', `translate(${node.x - 60},${node.y - 20})`)
    g.style.cursor = 'grab'

    const rect = el('rect')
    rect.setAttribute('width', '120')
    rect.setAttribute('height', '40')
    rect.setAttribute('rx', '8')
    rect.setAttribute('fill', '#1f2937')
    rect.setAttribute('stroke', '#4b5563')
    rect.setAttribute('stroke-width', '1.5')

    const text = el('text')
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
  addInteraction(svg, viewport)
}
