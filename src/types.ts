export interface Node {
  id: string
  label: string
  x: number
  y: number
}

export interface Edge {
  from: string
  to: string
}

export interface Graph {
  nodes: Node[]
  edges: Edge[]
}
