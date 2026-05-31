import { getToken } from '../auth/github'
import { WORKER_URL } from '../config'
import type { Graph, Node, Edge } from '../types'

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
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function loadGraph(): Promise<Graph> {
  const data = await apiFetch('/graph') as {
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
    body: JSON.stringify({ label: node.label, x: node.x, y: node.y, description: node.description ?? null }),
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
