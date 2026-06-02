import { getToken } from '../auth/github'
import { WORKER_URL } from '../config'
import type { Graph, Node, Edge, AuditEntry } from '../types'

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

// Public — no auth token required
export async function loadGraph(): Promise<Graph> {
  const res = await fetch(`${WORKER_URL}/graph`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /graph: ${res.status}${body ? ` — ${body}` : ''}`)
  }
  const data = await res.json() as {
    nodes: Node[]
    edges: Array<{ id: string; source: string; target: string }>
  }
  return {
    nodes: data.nodes,
    edges: data.edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  }
}

export async function upsertNode(node: Node): Promise<void> {
  await apiFetch(`/nodes/${node.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: node.label, x: node.x, y: node.y, description: node.description ?? null, status: node.status }),
  })
}

export async function deleteNode(id: string): Promise<void> {
  await apiFetch(`/nodes/${id}`, { method: 'DELETE' })
}

export async function upsertEdge(edge: Edge): Promise<void> {
  await apiFetch('/edges', {
    method: 'POST',
    body: JSON.stringify({ id: edge.id, source: edge.from, target: edge.to }),
  })
}

export async function deleteEdge(id: string): Promise<void> {
  await apiFetch(`/edges/${id}`, { method: 'DELETE' })
}

export async function fetchAuditLog(params?: { username?: string; entity_id?: string }): Promise<AuditEntry[]> {
  const qs = new URLSearchParams()
  if (params?.username) qs.set('username', params.username)
  if (params?.entity_id) qs.set('entity_id', params.entity_id)
  const queryStr = qs.toString()
  return apiFetch(`/audit${queryStr ? `?${queryStr}` : ''}`) as Promise<AuditEntry[]>
}

export async function fetchNodeAuditLog(nodeId: string): Promise<AuditEntry[]> {
  return apiFetch(`/nodes/${encodeURIComponent(nodeId)}/audit`) as Promise<AuditEntry[]>
}
