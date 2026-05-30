import { storeToken, getToken, login, isAuthenticated } from './auth/github'
import { readFile } from './storage/github'
import type { Graph } from './types'

async function extractTokenFromHash(): Promise<void> {
  const hash = window.location.hash
  if (!hash.startsWith('#token=')) return
  const token = hash.slice('#token='.length)
  if (token) {
    storeToken(token)
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}

async function fetchUsername(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch user: ${res.status}`)
  const user = await res.json() as { login: string }
  return user.login
}

async function render(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return

  await extractTokenFromHash()

  if (!isAuthenticated()) {
    app.innerHTML = `
      <p>Not logged in</p>
      <button id="login-btn">Login with GitHub</button>
    `
    document.getElementById('login-btn')?.addEventListener('click', login)
    return
  }

  app.innerHTML = '<p>Loading...</p>'
  try {
    const [username, graph] = await Promise.all([
      fetchUsername(getToken()!),
      readFile('data/graph.json') as Promise<Graph>,
    ])
    app.innerHTML = `
      <p>Logged in as <strong>${username}</strong></p>
      <p>Loaded graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges</p>
    `
  } catch (err) {
    app.innerHTML = `<p>Error: ${err instanceof Error ? err.message : String(err)}</p>`
  }
}

render()
