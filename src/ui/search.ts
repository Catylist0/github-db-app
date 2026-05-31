import type { Node } from '../types'

let _panel: HTMLElement | null = null

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
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

function statusDotColor(status: Node['status']): string {
  if (status === 'ongoing') return '#f97316'
  if (status === 'complete') return '#22c55e'
  return '#6b7280'
}

function filterNodes(nodes: Node[], query: string): Node[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const cutoff = Math.max(1, Math.ceil(q.length * 0.4))
  const exact: Node[] = []
  const fuzzy: Array<{ node: Node; dist: number }> = []
  for (const node of nodes) {
    const label = node.label.toLowerCase()
    if (label.includes(q)) {
      exact.push(node)
    } else if (q.length >= 2) {
      const dist = bestSubstringDist(q, label)
      if (dist <= cutoff) fuzzy.push({ node, dist })
    }
  }
  fuzzy.sort((a, b) => a.dist - b.dist)
  return [...exact, ...fuzzy.map(f => f.node)]
}

export function isSearchPanelOpen(): boolean {
  return _panel !== null
}

export function hideSearchPanel(): void {
  if (!_panel) return
  const p = _panel
  _panel = null
  p.style.transform = 'translateX(-280px)'
  setTimeout(() => p.remove(), 210)
}

export function showSearchPanel(
  getNodes: () => Node[],
  onSelect: (node: Node) => void,
): void {
  if (_panel) return

  const panel = document.createElement('div')
  _panel = panel
  panel.id = 'search-panel'
  panel.style.cssText =
    'position:fixed;top:0;left:0;width:280px;height:100vh;' +
    'background:#0d1117;border-right:1px solid #21262d;z-index:900;' +
    'box-sizing:border-box;font-family:var(--font);display:flex;flex-direction:column;' +
    'transform:translateX(-280px);transition:transform .2s ease;' +
    'box-shadow:8px 0 24px rgba(0,0,0,.35);'

  // Collapse tab on right edge
  const collapseBar = document.createElement('div')
  collapseBar.style.cssText =
    'position:absolute;right:-12px;top:50%;transform:translateY(-50%);' +
    'width:12px;height:2.5rem;background:#0d1117;' +
    'border:1px solid #21262d;border-left:none;border-radius:0 3px 3px 0;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;' +
    'color:#484f58;font-size:.65rem;transition:color .15s,background .15s;'
  collapseBar.innerHTML = '&#8249;'
  collapseBar.addEventListener('mouseenter', () => {
    collapseBar.style.color = '#8b949e'
    collapseBar.style.background = '#161b22'
  })
  collapseBar.addEventListener('mouseleave', () => {
    collapseBar.style.color = '#484f58'
    collapseBar.style.background = '#0d1117'
  })
  collapseBar.addEventListener('click', hideSearchPanel)
  panel.appendChild(collapseBar)

  // Header
  const header = document.createElement('div')
  header.style.cssText = 'padding:.875rem 1rem .5rem;flex-shrink:0;'
  const title = document.createElement('span')
  title.textContent = 'SEARCH'
  title.style.cssText =
    'font-size:.6875rem;color:#484f58;font-weight:600;letter-spacing:.07em;'
  header.appendChild(title)
  panel.appendChild(header)

  // Input
  const inputWrap = document.createElement('div')
  inputWrap.style.cssText = 'padding:0 .75rem .75rem;flex-shrink:0;'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Search nodes...'
  input.setAttribute('autocomplete', 'off')
  input.style.cssText =
    'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);' +
    'padding:.5rem .65rem;color:var(--text);font-size:.875rem;font-family:var(--font);' +
    'width:100%;box-sizing:border-box;outline:none;transition:border-color .15s;'
  input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent)' })
  input.addEventListener('blur', () => { input.style.borderColor = 'var(--border)' })
  inputWrap.appendChild(input)
  panel.appendChild(inputWrap)

  // Results
  const list = document.createElement('div')
  list.style.cssText = 'flex:1;overflow-y:auto;padding:0 .5rem .5rem;'
  panel.appendChild(list)

  function renderResults(query: string): void {
    list.innerHTML = ''
    const nodes = getNodes()
    const results = filterNodes(nodes, query)

    if (nodes.length > 0 && results.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No results'
      empty.style.cssText = 'padding:.75rem .5rem;color:#484f58;font-size:.8125rem;font-style:italic;'
      list.appendChild(empty)
      return
    }

    for (const node of results) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;' +
        'border-radius:4px;cursor:pointer;min-width:0;'
      row.addEventListener('mouseenter', () => { row.style.background = '#161b22' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })

      const dot = document.createElement('span')
      dot.style.cssText =
        `display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0;` +
        `background:${statusDotColor(node.status)};`

      const label = document.createElement('span')
      label.textContent = node.label
      label.style.cssText =
        'color:#e6edf3;font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

      row.append(dot, label)
      row.addEventListener('click', () => {
        hideSearchPanel()
        onSelect(node)
      })
      list.appendChild(row)
    }
  }

  input.addEventListener('input', () => renderResults(input.value))
  renderResults('')

  document.body.appendChild(panel)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      panel.style.transform = 'translateX(0)'
      input.focus()
    }),
  )
}

export function toggleSearchPanel(
  getNodes: () => Node[],
  onSelect: (node: Node) => void,
): void {
  if (_panel) hideSearchPanel()
  else showSearchPanel(getNodes, onSelect)
}
