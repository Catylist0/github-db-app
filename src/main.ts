import { storeToken, getToken, login, logout, isAuthenticated } from './auth/github'
import { loadGraph, upsertNode, deleteNode, upsertEdge, deleteEdge, onUnauthorized } from './storage/api'
import { renderGraph } from './graph/renderer'
import { hidePanel } from './ui/panel'

let _controls: { setAuthenticated: (auth: boolean) => void } | null = null
let _username: string | null = null
let _authHeader: HTMLElement | null = null

// ── Error banner ──────────────────────────────────────────────────────────────

function showErrorBanner(message: string): void {
  document.getElementById('error-banner')?.remove()
  const el = document.createElement('div')
  el.id = 'error-banner'
  el.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;' +
    'background:#da3633;color:#fff;padding:.6rem 1rem;' +
    'display:flex;justify-content:space-between;align-items:center;' +
    'font-family:var(--font);font-size:.875rem;'
  const msg = document.createElement('span')
  msg.textContent = `Authentication failed: ${message}`
  const x = document.createElement('button')
  x.textContent = '×'
  x.style.cssText =
    'background:none;border:none;color:#fff;font-size:1.3rem;' +
    'cursor:pointer;padding:0 .25rem;line-height:1;'
  x.addEventListener('click', () => el.remove())
  el.append(msg, x)
  document.body.prepend(el)
}

// ── Auth header (top-left) ────────────────────────────────────────────────────

const AUTH_CONTROL =
  'display:inline-flex;align-items:center;justify-content:center;height:2rem;' +
  'padding:0 .75rem;font-size:.8125rem;font-family:var(--font);white-space:nowrap;'

function pill(text: string): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText =
    AUTH_CONTROL +
    'background:var(--surface);border:1px solid var(--border);' +
    'color:var(--text-muted);border-right:none;'
  el.textContent = text
  return el
}

function authBtn(text: string, onClick: () => void): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = text
  el.style.cssText =
    AUTH_CONTROL +
    'background:var(--surface);border:1px solid var(--border);' +
    'color:var(--text);cursor:pointer;transition:color .15s,background .15s;'
  el.addEventListener('mouseenter', () => {
    el.style.color = '#fff'
    el.style.background = 'var(--surface-elevated)'
  })
  el.addEventListener('mouseleave', () => {
    el.style.color = 'var(--text)'
    el.style.background = 'var(--surface)'
  })
  el.addEventListener('click', onClick)
  return el
}

function updateAuthHeader(): void {
  if (!_authHeader) return
  _authHeader.innerHTML = ''
  if (_username) {
    _authHeader.append(pill(`Logged in as ${_username}`), authBtn('Log out', handleLogout))
  } else {
    _authHeader.append(authBtn('Login with GitHub', login))
  }
}

function handleLogout(): void {
  logout()
  _username = null
  _controls?.setAuthenticated(false)
  hidePanel()
  updateAuthHeader()
}

// ── OAuth callback ────────────────────────────────────────────────────────────

async function fetchUsername(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return ((await res.json()) as { login: string }).login
}

async function handleOAuthCallback(): Promise<void> {
  const hash = window.location.hash
  if (!hash) return

  if (hash.startsWith('#error=')) {
    const msg = decodeURIComponent(hash.slice('#error='.length))
    history.replaceState(null, '', window.location.pathname)
    showErrorBanner(msg)
    return
  }

  if (!hash.startsWith('#token=')) return
  const token = hash.slice('#token='.length)
  history.replaceState(null, '', window.location.pathname)
  if (!token) return

  storeToken(token)
  try {
    _username = await fetchUsername(token)
    _controls?.setAuthenticated(true)
    updateAuthHeader()
  } catch (err) {
    logout()
    showErrorBanner(err instanceof Error ? err.message : String(err))
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const app = document.getElementById('app')!

  // Auth header — top-left
  _authHeader = document.createElement('div')
  _authHeader.style.cssText =
    'position:fixed;top:1rem;left:1rem;display:flex;align-items:center;' +
    'border-radius:var(--radius);overflow:hidden;z-index:500;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.4);'
  document.body.appendChild(_authHeader)
  updateAuthHeader()

  // Surface write auth failures as banner and revert to read-only
  onUnauthorized((reason) => {
    showErrorBanner(reason)
    if (isAuthenticated()) {
      logout()
      _username = null
      _controls?.setAuthenticated(false)
      updateAuthHeader()
    }
  })

  app.innerHTML = '<p style="padding:1rem;color:#e6edf3;font-family:system-ui">Loading…</p>'

  try {
    const graph = await loadGraph()
    app.style.cssText = ''
    _controls = renderGraph(graph, app, { upsertNode, deleteNode, upsertEdge, deleteEdge })
    await handleOAuthCallback()
  } catch (err) {
    app.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    app.innerHTML = `<p style="color:#e6edf3;font-family:system-ui">
      Error loading graph: ${err instanceof Error ? err.message : String(err)}
    </p>`
  }
}

// Suppress unused import warning — getToken used indirectly via api.ts
void getToken
init()
