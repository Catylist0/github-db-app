import { getToken } from '../auth/github'
import type { Graph } from '../types'

const RAW_BASE = 'https://raw.githubusercontent.com/Catylist0/github-db-app/main'
const API_BASE = 'https://api.github.com'
const OWNER = 'Catylist0'
const REPO = 'github-db-app'

function isValidGraph(data: unknown): data is Graph {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as Record<string, unknown>).nodes) &&
    Array.isArray((data as Record<string, unknown>).edges)
  )
}

function mergeInto(base: Graph, overlay: Graph): void {
  const nodeMap = new Map(base.nodes.map(n => [n.id, n]))
  const edgeSet = new Set(base.edges.map(e => `${e.from}→${e.to}`))
  for (const node of overlay.nodes) nodeMap.set(node.id, node)
  for (const edge of overlay.edges) {
    const key = `${edge.from}→${edge.to}`
    if (!edgeSet.has(key)) { edgeSet.add(key); base.edges.push(edge) }
  }
  base.nodes = [...nodeMap.values()]
}

export async function loadGraph(): Promise<Graph> {
  const token = getToken()
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    : {}

  // Fetch canonical base
  const merged: Graph = { nodes: [], edges: [] }
  try {
    const res = await fetch(`${RAW_BASE}/data/graph.json`)
    if (res.ok) {
      const data: unknown = await res.json()
      if (isValidGraph(data)) mergeInto(merged, data)
    }
  } catch { /* ignore — start with empty base */ }

  // List files under data/users/
  let userItems: { download_url: string }[] = []
  try {
    const res = await fetch(
      `${API_BASE}/repos/${OWNER}/${REPO}/contents/data/users`,
      { headers: authHeaders },
    )
    if (res.ok) {
      const items = await res.json() as { name: string; download_url: string; type: string }[]
      userItems = items.filter(i => i.type === 'file' && i.name.endsWith('.json'))
    }
  } catch { /* directory may not exist yet */ }

  // Fetch all user graphs in parallel and merge
  const results = await Promise.all(
    userItems.map(({ download_url }) =>
      fetch(download_url)
        .then(r => r.ok ? r.json() as Promise<unknown> : null)
        .catch(() => null),
    ),
  )
  for (const data of results) {
    if (isValidGraph(data)) mergeInto(merged, data)
  }

  return merged
}

export async function saveGraph(graph: Graph, username: string): Promise<void> {
  await writeFile(`data/users/${username}.json`, graph, `Update graph for ${username}`)
}

async function writeFile(path: string, data: unknown, message: string): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('Not authenticated')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }

  let sha: string | undefined
  const existing = await fetch(`${API_BASE}/repos/${OWNER}/${REPO}/contents/${path}`, { headers })
  if (existing.ok) {
    sha = ((await existing.json()) as { sha: string }).sha
  } else if (existing.status !== 404) {
    throw new Error(`writeFile SHA fetch ${path}: ${existing.status} ${existing.statusText}`)
  }

  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))))
  const body: Record<string, unknown> = { message, content }
  if (sha) body.sha = sha

  const res = await fetch(`${API_BASE}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`writeFile ${path}: ${res.status} ${res.statusText}`)
}
