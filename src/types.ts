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

// An Euler-diagram-style region enclosing a set of nodes. The visible shape is
// generated entirely on the front end from the live positions of `members`;
// `vertices` is a persisted future shape hint and is not used for rendering yet.
export interface Grouping {
  id: string
  name: string
  members: string[]
  vertices: Array<{ x: number; y: number }>
  color: string
  // When locked, dragging a node into the region does not add it; the boundary
  // adjusts to keep the node out instead. New members can only be added through
  // the group menu.
  locked: boolean
}

export interface Graph {
  nodes: Node[]
  edges: Edge[]
  groupings: Grouping[]
}

// Incremental update pulled from GET /changes — only the rows that were written
// and the entities that were deleted since the client's last known revision.
export interface GraphChanges {
  rev: number
  nodes: Node[]
  edges: Edge[]
  groupings: Grouping[]
  deletions: Array<{ entityType: 'node' | 'edge' | 'grouping'; entityId: string; rev: number }>
}

export type GroupingPatch = Partial<Pick<Grouping, 'name' | 'members' | 'vertices' | 'color' | 'locked'>>

export interface GraphAPI {
  upsertNode: (node: Node) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  upsertEdge: (edge: Edge) => Promise<void>
  deleteEdge: (id: string) => Promise<void>
  patchEdge: (id: string, patch: Partial<Pick<Edge, 'routing' | 'style' | 'vanish' | 'midAxis' | 'midPos'>>) => Promise<void>
  upsertGrouping: (grouping: Grouping) => Promise<void>
  patchGrouping: (id: string, patch: GroupingPatch) => Promise<void>
  deleteGrouping: (id: string) => Promise<void>
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
