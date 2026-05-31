import { storeToken, getToken, login, isAuthenticated } from './auth/github'
import { loadGraph, upsertNode, upsertEdge, deleteEdge } from './storage/api'
import { renderGraph } from './graph/renderer'

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

function showLogin(app: HTMLElement): void {
  app.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center'
  app.innerHTML = `
    <p style="margin:0 0 1rem">Not logged in</p>
    <button id="login-btn">Login with GitHub</button>
  `
  document.getElementById('login-btn')?.addEventListener('click', login)
}

async function render(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return

  await extractTokenFromHash()

  if (!isAuthenticated()) {
    showLogin(app)
    return
  }

  app.style.cssText = ''
  app.innerHTML = '<p style="padding:1rem;color:#e6edf3;font-family:system-ui">Loading...</p>'

  try {
    const [username, graph] = await Promise.all([
      fetchUsername(getToken()!),
      loadGraph(),
    ])

    renderGraph(graph, app, { upsertNode, upsertEdge, deleteEdge })

    const badge = document.createElement('div')
    badge.style.cssText =
      'position:fixed;top:1rem;right:1rem;background:#1f2937;border:1px solid #4b5563;' +
      'padding:.35rem .75rem;border-radius:6px;color:#e6edf3;font-size:13px;font-family:system-ui'
    badge.textContent = username
    document.body.appendChild(badge)
  } catch (err) {
    app.innerHTML = `<p style="padding:1rem;color:#e6edf3;font-family:system-ui">Error: ${err instanceof Error ? err.message : String(err)}</p>`
  }
}

render()
