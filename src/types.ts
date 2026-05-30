export interface Node {
  id: string
  label: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Edge {
  id: string
  source: string
  target: string
  label?: string
}

export interface Project {
  id: string
  name: string
  description?: string
  nodes: Node[]
  edges: Edge[]
  createdAt: string
  updatedAt: string
}
