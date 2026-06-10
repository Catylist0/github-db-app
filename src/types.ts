export type NodeStatus = 'planned' | 'ongoing' | 'complete'
export type NodeClass = 'UI' | 'Logic' | 'Graphics' | 'Sound' | 'Research'
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

// Manual placement of an elbow2 middle segment. `midAxis` is the coordinate the
// segment is pinned on ('x' = vertical middle segment, 'y' = horizontal) and
// `midPos` is its position on that axis. null/undefined = automatic placement.
export type MidAxis = 'x' | 'y'

export interface Edge {
  id: string
  from: string
  to: string
  routing: EdgeRouting
  style: EdgeStyle
  vanish: boolean
  midAxis?: MidAxis | null
  midPos?: number | null
}

export interface Graph {
  nodes: Node[]
  edges: Edge[]
}

// Incremental update pulled from GET /changes — only the rows that were written
// and the entities that were deleted since the client's last known revision.
export interface GraphChanges {
  rev: number
  nodes: Node[]
  edges: Edge[]
  deletions: Array<{ entityType: 'node' | 'edge'; entityId: string; rev: number }>
}

export interface GraphAPI {
  upsertNode: (node: Node) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  upsertEdge: (edge: Edge) => Promise<void>
  deleteEdge: (id: string) => Promise<void>
  patchEdge: (id: string, patch: Partial<Pick<Edge, 'routing' | 'style' | 'vanish' | 'midAxis' | 'midPos'>>) => Promise<void>
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
