import { getToken } from '../auth/github'

const RAW_BASE = 'https://raw.githubusercontent.com/Catylist0/github-db-app/main'
const API_BASE = 'https://api.github.com'
const OWNER = 'Catylist0'
const REPO = 'github-db-app'

export async function readFile(path: string): Promise<unknown> {
  const res = await fetch(`${RAW_BASE}/${path}`)
  if (!res.ok) throw new Error(`readFile ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function writeFile(
  path: string,
  data: unknown,
  message: string,
): Promise<void> {
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
    const item = await existing.json() as { sha: string }
    sha = item.sha
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
