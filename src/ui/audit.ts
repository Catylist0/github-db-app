import type { Node, AuditEntry } from '../types'
import { fetchAuditLog } from '../storage/api'

let _panel: HTMLElement | null = null
let _listEl: HTMLElement | null = null
let _usernameSelect: HTMLSelectElement | null = null
let _searchInput: HTMLInputElement | null = null
let _noticeEl: HTMLElement | null = null
let _currentEntityId: string | null = null
let _getNodes: (() => Node[]) | null = null
let _onSelect: ((node: Node) => void) | null = null
let _allEntries: AuditEntry[] = []
let _clickOutside: ((e: MouseEvent) => void) | null = null

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}

function bestSubstringDist(query: string, label: string): number {
  if (query.length >= label.length) return levenshtein(query, label)
  let best = Infinity
  for (let i = 0; i <= label.length - query.length; i++) {
    const d = levenshtein(query, label.slice(i, i + query.length))
    if (d < best) best = d
  }
  return best
}

function actionLabel(action: string): string {
  switch (action) {
    case 'create_node': return 'created node'
    case 'update_node': return 'updated node'
    case 'delete_node': return 'deleted node'
    case 'create_edge': return 'created edge'
    case 'delete_edge': return 'deleted edge'
    default: return action
  }
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

type DiffRow = Record<string, unknown> | null

function getEntityName(entry: AuditEntry): string {
  const nodes = _getNodes?.() ?? []
  try {
    const diff = JSON.parse(entry.diff) as { before: DiffRow; after: DiffRow }
    if (entry.entity_type === 'node') {
      return String(diff.after?.['label'] ?? diff.before?.['label'] ?? entry.entity_id)
    }
    if (entry.entity_type === 'edge') {
      const row = diff.after ?? diff.before
      const srcId = String(row?.['source'] ?? '')
      const tgtId = String(row?.['target'] ?? '')
      const srcName = nodes.find(n => n.id === srcId)?.label ?? srcId
      const tgtName = nodes.find(n => n.id === tgtId)?.label ?? tgtId
      return `${srcName} → ${tgtName}`
    }
  } catch { /* ignore */ }
  return entry.entity_id
}

function getEdgeSourceId(entry: AuditEntry): string | null {
  try {
    const diff = JSON.parse(entry.diff) as { before: DiffRow; after: DiffRow }
    const row = diff.after ?? diff.before
    return String(row?.['source'] ?? '') || null
  } catch { return null }
}

function filterEntries(entries: AuditEntry[], username: string, query: string): AuditEntry[] {
  let filtered = username ? entries.filter(e => e.username === username) : entries
  const q = query.trim().toLowerCase()
  if (!q) return filtered
  const cutoff = Math.max(1, Math.ceil(q.length * 0.4))
  const exact: AuditEntry[] = []
  const fuzzy: Array<{ entry: AuditEntry; dist: number }> = []
  for (const entry of filtered) {
    const name = getEntityName(entry).toLowerCase()
    if (name.includes(q)) {
      exact.push(entry)
    } else if (q.length >= 2) {
      const dist = bestSubstringDist(q, name)
      if (dist <= cutoff) fuzzy.push({ entry, dist })
    }
  }
  fuzzy.sort((a, b) => a.dist - b.dist)
  return [...exact, ...fuzzy.map(f => f.entry)]
}

function renderEntries(): void {
  if (!_listEl) return
  const username = _usernameSelect?.value ?? ''
  const query = _searchInput?.value ?? ''
  const entries = filterEntries(_allEntries, username, query)

  _listEl.innerHTML = ''

  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = _allEntries.length === 0 ? 'No audit entries' : 'No results'
    empty.style.cssText = 'padding:.75rem .5rem;color:#484f58;font-size:.8125rem;font-style:italic;'
    _listEl.appendChild(empty)
    return
  }

  for (const entry of entries) {
    const row = document.createElement('div')
    row.style.cssText =
      'padding:.45rem .5rem;border-radius:4px;cursor:pointer;'
    row.addEventListener('mouseenter', () => { row.style.background = '#21262d' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })

    const metaEl = document.createElement('div')
    metaEl.style.cssText = 'display:flex;align-items:center;gap:.4rem;margin-bottom:.15rem;'

    const timeEl = document.createElement('span')
    timeEl.textContent = relTime(entry.timestamp)
    timeEl.style.cssText = 'color:#484f58;font-size:.75rem;flex-shrink:0;'

    const sep1 = document.createElement('span')
    sep1.textContent = '·'
    sep1.style.cssText = 'color:#30363d;font-size:.75rem;'

    const userEl = document.createElement('span')
    userEl.textContent = entry.username
    userEl.style.cssText = 'color:#58a6ff;font-size:.75rem;flex-shrink:0;'

    const sep2 = document.createElement('span')
    sep2.textContent = '·'
    sep2.style.cssText = 'color:#30363d;font-size:.75rem;'

    const actionEl = document.createElement('span')
    actionEl.textContent = actionLabel(entry.action)
    actionEl.style.cssText = 'color:#8b949e;font-size:.75rem;'

    metaEl.append(timeEl, sep1, userEl, sep2, actionEl)

    const nameEl = document.createElement('div')
    nameEl.textContent = getEntityName(entry)
    nameEl.style.cssText =
      'color:#e6edf3;font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

    row.append(metaEl, nameEl)

    row.addEventListener('click', () => {
      const nodes = _getNodes?.() ?? []
      let targetId: string | null = null
      if (entry.entity_type === 'node') {
        targetId = entry.entity_id
      } else {
        targetId = getEdgeSourceId(entry)
      }
      if (targetId) {
        const node = nodes.find(n => n.id === targetId)
        if (node && _onSelect) _onSelect(node)
      }
    })

    _listEl.appendChild(row)
  }
}

async function loadAndRender(): Promise<void> {
  if (!_listEl) return
  _listEl.innerHTML = '<div style="padding:.75rem .5rem;color:#484f58;font-size:.8125rem">Loading…</div>'
  try {
    _allEntries = await fetchAuditLog(_currentEntityId ? { entity_id: _currentEntityId } : undefined)

    if (_usernameSelect) {
      const prev = _usernameSelect.value
      const usernames = [...new Set(_allEntries.map(e => e.username))].sort()
      _usernameSelect.innerHTML = '<option value="">All users</option>'
      for (const u of usernames) {
        const opt = document.createElement('option')
        opt.value = u
        opt.textContent = u
        if (u === prev) opt.selected = true
        _usernameSelect.appendChild(opt)
      }
    }

    renderEntries()
  } catch (err) {
    if (_listEl) {
      _listEl.innerHTML = `<div style="padding:.75rem .5rem;color:#f85149;font-size:.8125rem">Failed to load: ${err instanceof Error ? err.message : String(err)}</div>`
    }
  }
}

function rebuildNotice(): void {
  if (!_noticeEl) return
  _noticeEl.innerHTML = ''
  if (_currentEntityId) {
    const nodes = _getNodes?.() ?? []
    const node = nodes.find(n => n.id === _currentEntityId)
    const name = node?.label ?? _currentEntityId

    const text = document.createElement('span')
    text.textContent = `Filtering to node: ${name}`
    text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8125rem;'

    const dismiss = document.createElement('button')
    dismiss.textContent = '×'
    dismiss.style.cssText =
      'background:none;border:none;color:#8b949e;font-size:1rem;cursor:pointer;padding:0 .1rem;flex-shrink:0;'
    dismiss.addEventListener('mouseenter', () => { dismiss.style.color = '#e6edf3' })
    dismiss.addEventListener('mouseleave', () => { dismiss.style.color = '#8b949e' })
    dismiss.addEventListener('click', () => {
      _currentEntityId = null
      rebuildNotice()
      loadAndRender()
    })

    _noticeEl.append(text, dismiss)
    _noticeEl.style.display = 'flex'
  } else {
    _noticeEl.style.display = 'none'
  }
}

export function isAuditPanelOpen(): boolean {
  return _panel !== null
}

export function hideAuditPanel(): void {
  if (!_panel) return
  if (_clickOutside) {
    document.removeEventListener('mousedown', _clickOutside)
    _clickOutside = null
  }
  const p = _panel
  _panel = null
  _listEl = null
  _usernameSelect = null
  _searchInput = null
  _noticeEl = null
  p.style.opacity = '0'
  p.style.transform = 'translateY(-4px)'
  setTimeout(() => p.remove(), 150)
}

export function updateAuditPanelSelection(nodeId: string | null): void {
  _currentEntityId = nodeId
  if (!_panel) return
  rebuildNotice()
  loadAndRender()
}

export function showAuditPanel(
  getNodes: () => Node[],
  onSelect: (node: Node) => void,
  getSelectedNodeId: () => string | null,
): void {
  if (_panel) return
  _getNodes = getNodes
  _onSelect = onSelect
  _currentEntityId = getSelectedNodeId()
  _allEntries = []

  const panel = document.createElement('div')
  _panel = panel
  panel.id = 'audit-panel'
  panel.style.cssText =
    'position:fixed;top:3.5rem;left:1rem;width:480px;max-height:60vh;' +
    'background:#161b22;border:1px solid #30363d;border-radius:var(--radius);z-index:900;' +
    'overflow:hidden;display:flex;flex-direction:column;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.5);font-family:var(--font);' +
    'opacity:0;transform:translateY(-4px);transition:opacity .15s ease,transform .15s ease;'

  // Header
  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:.625rem .75rem .5rem;flex-shrink:0;border-bottom:1px solid #21262d;'
  const title = document.createElement('span')
  title.textContent = 'AUDIT LOG'
  title.style.cssText = 'font-size:.6875rem;color:#484f58;font-weight:600;letter-spacing:.07em;'
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText =
    'background:none;border:none;color:#484f58;font-size:1.1rem;line-height:1;cursor:pointer;padding:.1rem .3rem;'
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#e6edf3' })
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#484f58' })
  closeBtn.addEventListener('click', hideAuditPanel)
  header.append(title, closeBtn)
  panel.appendChild(header)

  // Notice (entity filter banner)
  const notice = document.createElement('div')
  _noticeEl = notice
  notice.style.cssText =
    'display:none;align-items:center;gap:.5rem;padding:.35rem .75rem;' +
    'background:#0d1117;border-bottom:1px solid #21262d;color:#e6edf3;flex-shrink:0;'
  panel.appendChild(notice)

  // Filters row
  const filtersRow = document.createElement('div')
  filtersRow.style.cssText = 'display:flex;gap:.5rem;padding:.5rem .75rem;flex-shrink:0;'

  const usernameSelect = document.createElement('select')
  _usernameSelect = usernameSelect
  usernameSelect.style.cssText =
    'background:#0d1117;border:1px solid #30363d;border-radius:var(--radius);' +
    'padding:.3rem .5rem;color:#e6edf3;font-size:.8125rem;font-family:var(--font);' +
    'flex-shrink:0;outline:none;cursor:pointer;'
  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = 'All users'
  usernameSelect.appendChild(defaultOpt)
  usernameSelect.addEventListener('change', renderEntries)

  const searchInput = document.createElement('input')
  _searchInput = searchInput
  searchInput.type = 'text'
  searchInput.placeholder = 'Filter by node name…'
  searchInput.setAttribute('autocomplete', 'off')
  searchInput.style.cssText =
    'background:#0d1117;border:1px solid #30363d;border-radius:var(--radius);' +
    'padding:.3rem .5rem;color:#e6edf3;font-size:.8125rem;font-family:var(--font);' +
    'flex:1;outline:none;transition:border-color .15s;'
  searchInput.addEventListener('focus', () => { searchInput.style.borderColor = '#58a6ff' })
  searchInput.addEventListener('blur', () => { searchInput.style.borderColor = '#30363d' })
  searchInput.addEventListener('input', renderEntries)

  filtersRow.append(usernameSelect, searchInput)
  panel.appendChild(filtersRow)

  // Results list
  const list = document.createElement('div')
  _listEl = list
  list.style.cssText = 'flex:1;overflow-y:auto;padding:.25rem .5rem .5rem;'
  panel.appendChild(list)

  document.body.appendChild(panel)

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      panel.style.opacity = '1'
      panel.style.transform = 'translateY(0)'
    }),
  )

  rebuildNotice()
  loadAndRender()

  _clickOutside = (e: MouseEvent) => {
    const t = e.target
    if (t instanceof Element && t.closest('#audit-panel')) return
    // Also ignore clicks on auth-bar buttons that toggle this panel
    if (t instanceof Element && t.closest('#auth-bar')) return
    hideAuditPanel()
  }
  setTimeout(() => {
    if (_clickOutside) document.addEventListener('mousedown', _clickOutside)
  }, 200)
}

export function toggleAuditPanel(
  getNodes: () => Node[],
  onSelect: (node: Node) => void,
  getSelectedNodeId: () => string | null,
): void {
  if (_panel) hideAuditPanel()
  else showAuditPanel(getNodes, onSelect, getSelectedNodeId)
}
