import { getToken } from '../auth/github'

const API_BASE = 'https://api.github.com'

interface RepoConfig {
  owner: string
  repo: string
}

let _config: RepoConfig | null = null

export function configureStorage(owner: string, repo: string): void {
  _config = { owner, repo }
}

function cfg(): RepoConfig {
  if (!_config) throw new Error('Storage not configured — call configureStorage() first')
  return _config
}

function authHeaders(): HeadersInit {
  const token = getToken()
  if (!token) throw new Error('Not authenticated')
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export async function readFile(path: string): Promise<unknown> {
  const { owner, repo } = cfg()
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`readFile ${path}: ${res.status} ${res.statusText}`)
  const item = await res.json() as { content: string }
  const decoded = atob(item.content.replace(/\n/g, ''))
  return JSON.parse(decoded)
}

export async function writeFile(
  path: string,
  data: unknown,
  message: string,
): Promise<void> {
  const { owner, repo } = cfg()
  const headers = authHeaders() as Record<string, string>

  // Fetch current SHA if the file already exists
  let sha: string | undefined
  const existing = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    headers,
  })
  if (existing.ok) {
    const item = await existing.json() as { sha: string }
    sha = item.sha
  } else if (existing.status !== 404) {
    throw new Error(`writeFile SHA fetch ${path}: ${existing.status} ${existing.statusText}`)
  }

  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))))
  const body: Record<string, unknown> = { message, content }
  if (sha) body.sha = sha

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`writeFile ${path}: ${res.status} ${res.statusText}`)
}
