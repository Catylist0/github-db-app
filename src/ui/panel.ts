import { marked } from 'marked'
import type { Node, NodeStatus } from '../types'

let pendingClose: (() => void) | undefined

function injectStyles(): void {
  if (document.getElementById('panel-styles')) return
  const s = document.createElement('style')
  s.id = 'panel-styles'
  s.textContent = `
    #panel-desc-rendered h1,#panel-desc-rendered h2,#panel-desc-rendered h3
      {color:#e6edf3;margin:.75em 0 .25em;font-weight:600}
    #panel-desc-rendered h1{font-size:1.15em}
    #panel-desc-rendered h2{font-size:1.05em}
    #panel-desc-rendered h3{font-size:.95em}
    #panel-desc-rendered p{margin:.4em 0;color:#c9d1d9}
    #panel-desc-rendered strong{color:#e6edf3;font-weight:700}
    #panel-desc-rendered em{font-style:italic;color:#c9d1d9}
    #panel-desc-rendered a{color:#58a6ff}
    #panel-desc-rendered code{background:#0d1117;border:1px solid #30363d;border-radius:3px;
      padding:.1em .3em;font-size:.85em;color:#79c0ff;font-family:monospace}
    #panel-desc-rendered pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;
      padding:.75em;overflow-x:auto;margin:.4em 0}
    #panel-desc-rendered pre code{border:none;padding:0;background:transparent}
    #panel-desc-rendered ul,#panel-desc-rendered ol{padding-left:1.5em;margin:.4em 0;color:#c9d1d9}
    #panel-desc-rendered li{margin:.15em 0}
    #panel-desc-rendered blockquote{border-left:3px solid #30363d;margin:.4em 0;
      padding-left:.75em;color:#8b949e}
    #panel-desc-rendered hr{border:none;border-top:1px solid #30363d;margin:.75em 0}
    #panel-desc-rendered table{border-collapse:collapse;width:100%;margin:.4em 0}
    #panel-desc-rendered th,#panel-desc-rendered td{border:1px solid #30363d;
      padding:.3em .6em;color:#c9d1d9}
    #panel-desc-rendered th{background:#0d1117;color:#e6edf3}
  `
  document.head.appendChild(s)
}

function renderToHtml(md: string): string {
  return marked(md) as string
}

export function hidePanel(immediate = false): void {
  pendingClose = undefined
  const panel = document.getElementById('detail-panel')
  if (!panel) return
  if (immediate) { panel.remove(); return }
  panel.style.transform = 'translateX(320px)'
  setTimeout(() => panel.remove(), 210)
}

export function showPanel(
  node: Node,
  onUpdate: (updated: Partial<Node>) => void,
  onClose?: () => void,
  onDelete?: () => void,
  autoFocusName = false,
  readonly = false,
): void {
  const wasOpen = !!document.getElementById('detail-panel')
  hidePanel(true)
  injectStyles()
  pendingClose = onClose

  // ── Shell ─────────────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.id = 'detail-panel'
  panel.style.cssText =
    'position:fixed;top:0;right:0;width:320px;height:100vh;overflow:hidden;' +
    'background:#161b22;border-left:1px solid #30363d;z-index:1000;' +
    'box-sizing:border-box;font-family:system-ui;display:flex;flex-direction:column;' +
    'transform:translateX(320px);transition:transform .2s ease;'
  document.body.appendChild(panel)
  if (wasOpen) {
    panel.style.transform = 'translateX(0)'
  } else {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.style.transform = 'translateX(0)'
    }))
  }

  // ── Close button ──────────────────────────────────────────────────────────
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText =
    'position:absolute;top:.6rem;right:.7rem;background:none;border:none;' +
    'color:#8b949e;font-size:1.4rem;line-height:1;cursor:pointer;' +
    'padding:.2rem .35rem;border-radius:4px;'
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#e6edf3' })
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#8b949e' })
  closeBtn.addEventListener('click', () => {
    const cb = pendingClose
    hidePanel()
    cb?.()
  })
  panel.appendChild(closeBtn)

  // ── Content ───────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.style.cssText =
    'padding:1rem 1.25rem;display:flex;flex-direction:column;gap:1.1rem;' +
    'flex:1;min-height:0;overflow-y:auto;'
  panel.appendChild(body)

  // Read-only hint
  if (readonly) {
    const hint = document.createElement('div')
    hint.style.cssText =
      'font-size:.75rem;color:#484f58;font-style:italic;margin-top:.25rem;'
    hint.textContent = 'Login to edit'
    body.appendChild(hint)
  }

  function sectionLabel(text: string): HTMLElement {
    const el = document.createElement('span')
    el.textContent = text
    el.style.cssText =
      'font-size:.7rem;color:#8b949e;font-weight:600;' +
      'letter-spacing:.06em;text-transform:uppercase;'
    return el
  }

  function fieldWrap(): HTMLElement {
    const el = document.createElement('div')
    el.style.cssText = 'display:flex;flex-direction:column;gap:.3rem;'
    return el
  }

  // ── Name ──────────────────────────────────────────────────────────────────
  const nameWrap = fieldWrap()
  nameWrap.style.marginTop = readonly ? '0' : '.4rem'
  nameWrap.style.flexShrink = '0'
  nameWrap.appendChild(sectionLabel('Name'))

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.value = node.label
  labelInput.disabled = readonly
  labelInput.style.cssText =
    'background:#0d1117;border:1px solid #30363d;border-radius:6px;' +
    'padding:.45rem .65rem;color:#e6edf3;font-size:.9rem;font-family:system-ui;' +
    `width:100%;box-sizing:border-box;outline:none;${readonly ? 'opacity:.55;cursor:default;' : ''}`
  let savedLabel = node.label
  if (!readonly && autoFocusName) requestAnimationFrame(() => { labelInput.select(); labelInput.focus() })
  if (!readonly) {
    labelInput.addEventListener('focus', () => { labelInput.style.borderColor = '#58a6ff' })
    labelInput.addEventListener('blur', () => {
      labelInput.style.borderColor = '#30363d'
      if (labelInput.value !== savedLabel) {
        savedLabel = labelInput.value
        onUpdate({ label: labelInput.value })
      }
    })
  }
  nameWrap.appendChild(labelInput)
  body.appendChild(nameWrap)

  // ── Description ───────────────────────────────────────────────────────────
  const descWrap = fieldWrap()
  descWrap.style.flex = '1'
  descWrap.style.minHeight = '0'
  descWrap.appendChild(sectionLabel('Description'))

  const sharedFieldStyle =
    'background:#0d1117;border:1px solid #30363d;border-radius:6px;' +
    'padding:.45rem .65rem;box-sizing:border-box;width:100%;' +
    'font-size:.8rem;line-height:1.55;outline:none;flex:1;min-height:0;'

  const PLACEHOLDER_HTML = readonly
    ? '<span style="color:#484f58;font-style:italic">No description.</span>'
    : '<span style="color:#484f58;font-style:italic">Click to add a description…</span>'

  const rendered = document.createElement('div')
  rendered.id = 'panel-desc-rendered'
  rendered.style.cssText =
    sharedFieldStyle +
    `color:#c9d1d9;word-break:break-word;overflow-y:auto;` +
    (readonly ? 'cursor:default;opacity:.85;' : 'cursor:text;display:none;')

  function applyRender(md: string): void {
    rendered.innerHTML = md.trim() ? renderToHtml(md) : PLACEHOLDER_HTML
  }

  if (readonly) {
    // Always show rendered view — no textarea
    applyRender(node.description ?? '')
    descWrap.appendChild(rendered)
  } else {
    const textarea = document.createElement('textarea')
    textarea.value = node.description ?? ''
    textarea.placeholder = 'Add a description… (markdown supported)'
    textarea.style.cssText = sharedFieldStyle + 'color:#e6edf3;font-family:monospace;resize:none;'

    let savedDesc = node.description ?? ''

    function activateTextarea(): void {
      rendered.style.display = 'none'
      textarea.style.display = 'block'
      textarea.focus()
    }
    function activateRendered(): void {
      textarea.style.display = 'none'
      rendered.style.display = 'block'
    }

    textarea.addEventListener('focus', () => { textarea.style.borderColor = '#58a6ff' })
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = '#30363d'
      const val = textarea.value
      if (val !== savedDesc) { savedDesc = val; onUpdate({ description: val }) }
      applyRender(val)
      activateRendered()
    })
    rendered.addEventListener('click', activateTextarea)

    if (node.description?.trim()) { applyRender(node.description); activateRendered() }

    descWrap.appendChild(textarea)
    descWrap.appendChild(rendered)
  }

  body.appendChild(descWrap)

  // ── Footer (always visible, never scrolls) ────────────────────────────────
  const footer = document.createElement('div')
  footer.style.cssText =
    'flex-shrink:0;display:flex;flex-direction:column;gap:.5rem;' +
    'padding:.75rem 1.25rem;border-top:1px solid #30363d;'
  panel.appendChild(footer)

  // ── Status buttons ────────────────────────────────────────────────────────
  const statusDefs: Array<{ value: NodeStatus; label: string; color: string }> = [
    { value: 'planned',  label: 'Planned',  color: '#4b5563' },
    { value: 'ongoing',  label: 'Ongoing',  color: '#f97316' },
    { value: 'complete', label: 'Complete', color: '#22c55e' },
  ]

  const statusWrap = document.createElement('div')
  statusWrap.style.cssText = 'display:flex;gap:.4rem;'

  let currentStatus: NodeStatus = node.status
  const statusBtns: HTMLButtonElement[] = []

  function applyStatusHighlight(): void {
    for (let i = 0; i < statusDefs.length; i++) {
      const { color, value } = statusDefs[i]
      const btn = statusBtns[i]
      const active = value === currentStatus
      btn.style.background = active ? color : 'transparent'
      btn.style.color = active ? '#fff' : color
    }
  }

  for (const s of statusDefs) {
    const btn = document.createElement('button')
    btn.textContent = s.label
    btn.disabled = readonly
    btn.style.cssText =
      `flex:1;border:1px solid ${s.color};border-radius:6px;` +
      `padding:.4rem .2rem;font-size:.78rem;font-family:system-ui;` +
      `cursor:${readonly ? 'default' : 'pointer'};background:transparent;` +
      `color:${s.color};transition:background .12s,color .12s;`
    if (!readonly) {
      btn.addEventListener('click', () => {
        currentStatus = s.value
        applyStatusHighlight()
        onUpdate({ status: s.value })
      })
    }
    statusBtns.push(btn)
    statusWrap.appendChild(btn)
  }

  applyStatusHighlight()
  footer.appendChild(statusWrap)

  // ── Delete button (edit mode only) ────────────────────────────────────────
  if (!readonly && onDelete) {
    const deleteBtn = document.createElement('button')
    deleteBtn.textContent = 'Delete node'
    deleteBtn.style.cssText =
      'background:#da3633;border:none;border-radius:6px;' +
      'padding:.5rem .75rem;color:#fff;font-size:.85rem;font-family:system-ui;' +
      'cursor:pointer;width:100%;'
    deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.opacity = '0.85' })
    deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.opacity = '1' })
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete '${node.label}' and all its connections? This cannot be undone.`)) {
        onDelete()
      }
    })
    footer.appendChild(deleteBtn)
  }
}
