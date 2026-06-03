export type NodeStatus = 'planned' | 'ongoing' | 'complete'
export type NodeClass = 'UI' | 'Logic' | 'Graphics' | 'Sound'
export type EdgeRouting = 'straight' | 'elbow1' | 'elbow2'
export type EdgeStyle = 'solid' | 'dashed'

export interface Node {
  id: string
  label: string
  x: number
  y: number
  description?: string
  status: NodeStatus
  nodeClass?: NodeClass
}

export interface Edge {
  id: string
  from: string
  to: string
  routing: EdgeRouting
  style: EdgeStyle
  vanish: boolean
}

export interface Graph {
  nodes: Node[]
  edges: Edge[]
}

export interface GraphAPI {
  upsertNode: (node: Node) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  upsertEdge: (edge: Edge) => Promise<void>
  deleteEdge: (id: string) => Promise<void>
  patchEdge: (id: string, patch: Partial<Pick<Edge, 'routing' | 'style' | 'vanish'>>) => Promise<void>
}

export interface AuditEntry {
  id: string
  timestamp: string
  username: string
  action: string
  entity_type: string
  entity_id: string
  diff: string
}

export interface AuditPage {
  entries: AuditEntry[]
  hasMore: boolean
}
