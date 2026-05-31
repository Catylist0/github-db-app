export interface Node {
  id: string
  label: string
  x: number
  y: number
}

export interface Edge {
  id: string
  from: string
  to: string
}

export interface Graph {
  nodes: Node[]
  edges: Edge[]
}

export interface GraphAPI {
  upsertNode: (node: Node) => Promise<void>
  upsertEdge: (edge: Edge) => Promise<void>
  deleteEdge: (id: string) => Promise<void>
}
