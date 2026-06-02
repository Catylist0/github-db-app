import { storeToken, getToken, login, logout, isAuthenticated } from './auth/github'
import { loadGraph, upsertNode, deleteNode, upsertEdge, deleteEdge, patchEdge, onUnauthorized } from './storage/api'
import { renderGraph } from './graph/renderer'
import { hidePanel } from './ui/panel'
import { hideSearchPanel, toggleSearchPanel, isSearchPanelOpen } from './ui/search'
import { hideAuditPanel, toggleAuditPanel, isAuditPanelOpen, updateAuditPanelSelection } from './ui/audit'
import type { Graph } from './types'

let _controls: { setAuthenticated: (auth: boolean) => void; centerOnNode: (id: string) => void; undo: () => void; redo: () => void } | null = null
let _username: string | null = null
let _authBar: HTMLElement | null = null
let _graph: Graph | null = null
let _selectedNodeId: string | null = null

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

// ── Auth bar (top-left) ───────────────────────────────────────────────────────

const AUTH_ITEM =
  'display:inline-flex;align-items:center;justify-content:center;height:2rem;' +
  'font-size:.8125rem;font-family:var(--font);white-space:nowrap;' +
  'background:var(--surface);border:1px solid var(--border);border-right:none;'

function pill(text: string): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = AUTH_ITEM + 'padding:0 .75rem;color:var(--text-muted);'
  el.textContent = text
  return el
}

function authBtn(text: string, onClick: () => void): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = text
  el.style.cssText = AUTH_ITEM + 'padding:0 .75rem;color:var(--text);cursor:pointer;transition:color .15s,background .15s;'
  el.addEventListener('mouseenter', () => { el.style.color = '#fff'; el.style.background = 'var(--surface-elevated)' })
  el.addEventListener('mouseleave', () => { el.style.color = 'var(--text)'; el.style.background = 'var(--surface)' })
  el.addEventListener('click', onClick)
  return el
}

function iconBtn(icon: string, title: string, onClick: () => void, getId?: string): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = icon
  el.title = title
  if (getId) el.id = getId
  el.style.cssText =
    AUTH_ITEM +
    'width:2rem;padding:0;color:var(--text-muted);cursor:pointer;' +
    'font-size:.95rem;transition:color .15s,background .15s;'
  el.addEventListener('mouseenter', () => { el.style.color = '#e6edf3'; el.style.background = 'var(--surface-elevated)' })
  el.addEventListener('mouseleave', () => { el.style.color = 'var(--text-muted)'; el.style.background = 'var(--surface)' })
  el.addEventListener('click', onClick)
  return el
}

function updateAuthBar(): void {
  if (!_authBar) return
  _authBar.innerHTML = ''

  const items: HTMLElement[] = []

  if (_username) {
    items.push(pill(`Logged in as ${_username}`))
    items.push(authBtn('Log out', handleLogout))
  } else {
    items.push(authBtn('Login with GitHub', login))
  }

  items.push(
    iconBtn('⌕', 'Search (⌘K)', () => {
      if (isAuditPanelOpen()) hideAuditPanel()
      toggleSearchPanel(
        () => _graph?.nodes ?? [],
        (node) => _controls?.centerOnNode(node.id),
      )
    }),
  )

  items.push(
    iconBtn('≡', 'Audit log', () => {
      if (isSearchPanelOpen()) hideSearchPanel()
      toggleAuditPanel(
        () => _graph?.nodes ?? [],
        (node) => _controls?.centerOnNode(node.id),
        () => _selectedNodeId,
      )
    }),
  )

  // Last item gets the closing right border
  items[items.length - 1].style.borderRight = '1px solid var(--border)'

  _authBar.append(...items)
}

function handleLogout(): void {
  logout()
  _username = null
  _controls?.setAuthenticated(false)
  hidePanel()
  updateAuthBar()
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
    updateAuthBar()
  } catch (err) {
    logout()
    showErrorBanner(err instanceof Error ? err.message : String(err))
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const app = document.getElementById('app')!

  // Auth bar — top-left, all controls inline
  _authBar = document.createElement('div')
  _authBar.id = 'auth-bar'
  _authBar.style.cssText =
    'position:fixed;top:1rem;left:1rem;display:flex;align-items:center;' +
    'border-radius:var(--radius);overflow:hidden;z-index:500;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.4);'
  document.body.appendChild(_authBar)
  updateAuthBar()

  // Keyboard shortcuts
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const ae = document.activeElement
    const typing = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement

    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !typing) {
      e.preventDefault()
      if (e.shiftKey) _controls?.redo()
      else _controls?.undo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'y' && !typing) {
      e.preventDefault()
      _controls?.redo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      if (isAuditPanelOpen()) hideAuditPanel()
      toggleSearchPanel(
        () => _graph?.nodes ?? [],
        (node) => _controls?.centerOnNode(node.id),
      )
      return
    }
    if (e.key === 'Escape') {
      if (isSearchPanelOpen()) { hideSearchPanel(); return }
      if (isAuditPanelOpen()) { hideAuditPanel(); return }
    }
  })

  // Surface write auth failures as banner and revert to read-only
  onUnauthorized((reason) => {
    showErrorBanner(reason)
    if (isAuthenticated()) {
      logout()
      _username = null
      _controls?.setAuthenticated(false)
      updateAuthBar()
    }
  })

  app.innerHTML = '<p style="padding:1rem;color:#e6edf3;font-family:system-ui">Loading…</p>'

  try {
    const graph = await loadGraph()
    _graph = graph
    app.style.cssText = ''
    _controls = renderGraph(graph, app, { upsertNode, deleteNode, upsertEdge, deleteEdge, patchEdge }, {
      onFocusNode: (nodeId) => {
        _selectedNodeId = nodeId
        updateAuditPanelSelection(nodeId)
      },
    })
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
