import { getToken } from '../auth/github'
import { WORKER_URL } from '../config'
import type { Graph, GraphChanges, Node, Edge, EdgeRouting, EdgeStyle, AuditPage } from '../types'

type NodeRow = Omit<Node, 'nodeClass'> & { node_class?: string | null }
type EdgeRow = { id: string; source: string; target: string; routing?: string; style?: string; vanish?: number }

function mapNode(n: NodeRow): Node {
  return { ...n, nodeClass: (n.node_class ?? undefined) as Node['nodeClass'] }
}

function mapEdge(e: EdgeRow): Edge {
  return {
    id: e.id,
    from: e.source,
    to: e.target,
    routing: (e.routing ?? 'straight') as EdgeRouting,
    style: (e.style ?? 'solid') as EdgeStyle,
    vanish: Boolean(e.vanish),
  }
}

let _onUnauthorized: ((reason: string) => void) | null = null
export function onUnauthorized(fn: (reason: string) => void): void {
  _onUnauthorized = fn
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...((init?.headers as Record<string, string>) ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 401) {
      let reason = 'unauthorized'
      try { reason = (JSON.parse(body) as { reason?: string }).reason ?? reason } catch { /* ignore */ }
      _onUnauthorized?.(reason)
    }
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status}${body ? ` — ${body}` : ''}`)
  }
  return res.json()
}

// Public — no auth token required. `rev` is the server revision this snapshot
// reflects; pass it to fetchChanges() to pull only later updates.
export async function loadGraph(): Promise<{ graph: Graph; rev: number }> {
  const res = await fetch(`${WORKER_URL}/graph`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /graph: ${res.status}${body ? ` — ${body}` : ''}`)
  }
  const data = await res.json() as { nodes: NodeRow[]; edges: EdgeRow[]; rev?: number }
  return {
    graph: { nodes: data.nodes.map(mapNode), edges: data.edges.map(mapEdge) },
    rev: data.rev ?? 0,
  }
}

// Public — pull rows written / entities deleted since `since`. since=0 returns
// the full graph as a diff against an empty client.
export async function fetchChanges(since: number): Promise<GraphChanges> {
  const res = await fetch(`${WORKER_URL}/changes?since=${since}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /changes: ${res.status}${body ? ` — ${body}` : ''}`)
  }
  const data = await res.json() as {
    rev: number
    nodes: NodeRow[]
    edges: EdgeRow[]
    deletions: Array<{ entity_type: string; entity_id: string; rev: number }>
  }
  return {
    rev: data.rev,
    nodes: data.nodes.map(mapNode),
    edges: data.edges.map(mapEdge),
    deletions: data.deletions.map(d => ({
      entityType: d.entity_type as 'node' | 'edge',
      entityId: d.entity_id,
      rev: d.rev,
    })),
  }
}

export async function upsertNode(node: Node): Promise<void> {
  await apiFetch(`/nodes/${node.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: node.label, x: node.x, y: node.y, description: node.description ?? null, status: node.status, node_class: node.nodeClass ?? null }),
  })
}

export async function deleteNode(id: string): Promise<void> {
  await apiFetch(`/nodes/${id}`, { method: 'DELETE' })
}

export async function upsertEdge(edge: Edge): Promise<void> {
  await apiFetch('/edges', {
    method: 'POST',
    body: JSON.stringify({ id: edge.id, source: edge.from, target: edge.to, routing: edge.routing, style: edge.style, vanish: edge.vanish }),
  })
}

export async function patchEdge(id: string, patch: Partial<Pick<Edge, 'routing' | 'style' | 'vanish'>>): Promise<void> {
  await apiFetch(`/edges/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deleteEdge(id: string): Promise<void> {
  await apiFetch(`/edges/${id}`, { method: 'DELETE' })
}

export const AUDIT_PAGE_SIZE = 25

export async function fetchAuditLog(params?: {
  username?: string
  entity_id?: string
  limit?: number
  offset?: number
}): Promise<AuditPage> {
  const qs = new URLSearchParams()
  if (params?.username) qs.set('username', params.username)
  if (params?.entity_id) qs.set('entity_id', params.entity_id)
  qs.set('limit', String(params?.limit ?? AUDIT_PAGE_SIZE))
  qs.set('offset', String(params?.offset ?? 0))
  return apiFetch(`/audit?${qs}`) as Promise<AuditPage>
}

export async function fetchNodeAuditLog(
  nodeId: string,
  params?: { limit?: number; offset?: number },
): Promise<AuditPage> {
  const qs = new URLSearchParams()
  qs.set('limit', String(params?.limit ?? AUDIT_PAGE_SIZE))
  qs.set('offset', String(params?.offset ?? 0))
  return apiFetch(`/nodes/${encodeURIComponent(nodeId)}/audit?${qs}`) as Promise<AuditPage>
}
