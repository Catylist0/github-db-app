import { marked } from 'marked'
import type { Node, NodeClass, NodeStatus } from '../types'
import { NODE_CLASS_FILLS, NODE_DEFAULT_FILL } from '../graph/utils'

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
    #panel-desc-rendered code{background:#0d1117;border:1px solid #30363d;
      padding:.1em .3em;font-size:.85em;color:#79c0ff;font-family:monospace}
    #panel-desc-rendered pre{background:#0d1117;border:1px solid #30363d;
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
    'background:var(--surface);border-left:1px solid var(--border);z-index:1000;' +
    'box-sizing:border-box;font-family:var(--font);display:flex;flex-direction:column;' +
    'transform:translateX(320px);transition:transform .2s ease;' +
    'box-shadow:-8px 0 24px rgba(0,0,0,.35);'
  document.body.appendChild(panel)
  if (wasOpen) {
    panel.style.transform = 'translateX(0)'
  } else {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.style.transform = 'translateX(0)'
    }))
  }

  // ── Header row (close button lives here, never overlaps content) ──────────
  const panelHeader = document.createElement('div')
  panelHeader.style.cssText =
    'display:flex;align-items:center;justify-content:flex-end;flex-shrink:0;' +
    'height:2.5rem;padding:0 .625rem;border-bottom:1px solid var(--border-muted);'
  panel.appendChild(panelHeader)

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText =
    'background:none;border:none;color:#484f58;font-size:1.1rem;line-height:1;' +
    'cursor:pointer;padding:.2rem .45rem;'
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#e6edf3' })
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#484f58' })
  closeBtn.addEventListener('click', () => {
    const cb = pendingClose
    hidePanel()
    cb?.()
  })
  panelHeader.appendChild(closeBtn)

  // ── Content ───────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.style.cssText =
    'padding:1.125rem 1.25rem;display:flex;flex-direction:column;gap:1rem;' +
    'flex:1;min-height:0;overflow-y:auto;'
  panel.appendChild(body)

  // Read-only hint
  if (readonly) {
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:.75rem;color:#484f58;font-style:italic;'
    hint.textContent = 'Login to edit'
    body.appendChild(hint)
  }

  function sectionLabel(text: string): HTMLElement {
    const el = document.createElement('span')
    el.textContent = text
    el.style.cssText =
      'font-size:.6875rem;color:var(--text-muted);font-weight:600;' +
      'letter-spacing:.07em;text-transform:uppercase;'
    return el
  }

  function fieldWrap(): HTMLElement {
    const el = document.createElement('div')
    el.style.cssText = 'display:flex;flex-direction:column;gap:.3rem;'
    return el
  }

  // ── Name ──────────────────────────────────────────────────────────────────
  const nameWrap = fieldWrap()
  nameWrap.style.flexShrink = '0'
  nameWrap.appendChild(sectionLabel('Name'))

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.value = node.label
  labelInput.disabled = readonly
  labelInput.style.cssText =
    'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);' +
    'padding:.5rem .65rem;color:var(--text);font-size:.875rem;font-family:var(--font);' +
    `width:100%;box-sizing:border-box;outline:none;transition:border-color .15s;` +
    `${readonly ? 'opacity:.45;cursor:default;' : ''}`
  let savedLabel = node.label
  if (!readonly && autoFocusName) requestAnimationFrame(() => { labelInput.select(); labelInput.focus() })
  if (!readonly) {
    labelInput.addEventListener('focus', () => { labelInput.style.borderColor = 'var(--accent)' })
    labelInput.addEventListener('blur', () => {
      labelInput.style.borderColor = 'var(--border)'
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
    'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);' +
    'padding:.5rem .65rem;box-sizing:border-box;width:100%;' +
    'font-size:.8125rem;line-height:1.55;outline:none;flex:1;min-height:0;' +
    'transition:border-color .15s;'

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

    textarea.addEventListener('focus', () => { textarea.style.borderColor = 'var(--accent)' })
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = 'var(--border)'
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
    'flex-shrink:0;display:flex;flex-direction:column;gap:.625rem;' +
    'padding:.875rem 1.25rem 1rem;border-top:1px solid var(--border-muted);'
  panel.appendChild(footer)

  // ── Class ─────────────────────────────────────────────────────────────────
  const classField = fieldWrap()
  classField.appendChild(sectionLabel('Class'))

  const classDefs: Array<{ value: NodeClass | ''; label: string; color: string }> = [
    { value: '',         label: 'None',     color: NODE_DEFAULT_FILL },
    { value: 'UI',       label: 'UI',       color: NODE_CLASS_FILLS.UI },
    { value: 'Logic',    label: 'Logic',    color: NODE_CLASS_FILLS.Logic },
    { value: 'Graphics', label: 'Graphics', color: NODE_CLASS_FILLS.Graphics },
    { value: 'Sound',    label: 'Sound',    color: NODE_CLASS_FILLS.Sound },
    { value: 'Research', label: 'Research', color: NODE_CLASS_FILLS.Research },
  ]

  const classWrap = document.createElement('div')
  classWrap.style.cssText =
    'display:flex;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;'

  let currentClass: NodeClass | '' = node.nodeClass ?? ''
  const classBtns: HTMLButtonElement[] = []

  function applyClassHighlight(): void {
    for (let i = 0; i < classDefs.length; i++) {
      const { color, value } = classDefs[i]
      const btn = classBtns[i]
      const active = value === currentClass
      btn.style.background = active ? color : 'var(--bg)'
      btn.style.color = active ? '#e6edf3' : '#8b949e'
      btn.style.fontWeight = active ? '600' : '400'
      btn.style.borderColor = active ? color : 'var(--border)'
    }
  }

  for (let i = 0; i < classDefs.length; i++) {
    const c = classDefs[i]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = c.value || '—'
    btn.disabled = readonly
    btn.style.cssText =
      'flex:1;border:none;padding:.45rem .2rem;font-size:.7rem;font-family:var(--font);' +
      `cursor:${readonly ? 'default' : 'pointer'};` +
      'background:var(--bg);transition:background .15s,color .15s;' +
      (i < classDefs.length - 1 ? 'border-right:1px solid var(--border);' : '')
    if (!readonly) {
      btn.addEventListener('mouseenter', () => {
        if (c.value !== currentClass) btn.style.background = 'var(--surface-elevated)'
      })
      btn.addEventListener('mouseleave', () => {
        if (c.value !== currentClass) btn.style.background = 'var(--bg)'
      })
      btn.addEventListener('click', () => {
        currentClass = c.value
        applyClassHighlight()
        onUpdate({ nodeClass: (c.value || undefined) as NodeClass | undefined })
      })
    }
    classBtns.push(btn)
    classWrap.appendChild(btn)
  }

  applyClassHighlight()
  classField.appendChild(classWrap)
  footer.appendChild(classField)

  // ── Status buttons ────────────────────────────────────────────────────────
  const statusField = fieldWrap()
  statusField.appendChild(sectionLabel('Status'))
  footer.appendChild(statusField)

  const statusDefs: Array<{ value: NodeStatus; label: string; color: string }> = [
    { value: 'planned',  label: 'Planned',  color: '#6b7280' },
    { value: 'ongoing',  label: 'Ongoing',  color: '#f97316' },
    { value: 'complete', label: 'Complete', color: '#22c55e' },
  ]

  const statusWrap = document.createElement('div')
  statusWrap.style.cssText =
    'display:flex;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;'

  let currentStatus: NodeStatus = node.status
  const statusBtns: HTMLButtonElement[] = []

  function applyStatusHighlight(): void {
    for (let i = 0; i < statusDefs.length; i++) {
      const { color, value } = statusDefs[i]
      const btn = statusBtns[i]
      const active = value === currentStatus
      btn.style.background = active ? color : 'var(--bg)'
      btn.style.color = active ? '#fff' : color
      btn.style.fontWeight = active ? '600' : '500'
    }
  }

  for (let i = 0; i < statusDefs.length; i++) {
    const s = statusDefs[i]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = s.label
    btn.disabled = readonly
    btn.style.cssText =
      'flex:1;border:none;padding:.5rem .35rem;font-size:.75rem;font-family:var(--font);' +
      `cursor:${readonly ? 'default' : 'pointer'};` +
      'background:var(--bg);transition:background .15s,color .15s,font-weight .15s;' +
      (i < statusDefs.length - 1 ? 'border-right:1px solid var(--border);' : '') +
      `color:${s.color};`
    if (!readonly) {
      btn.addEventListener('mouseenter', () => {
        if (s.value !== currentStatus) btn.style.background = 'var(--surface-elevated)'
      })
      btn.addEventListener('mouseleave', () => {
        if (s.value !== currentStatus) btn.style.background = 'var(--bg)'
      })
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
  statusField.appendChild(statusWrap)

  // ── Delete button (edit mode only) ────────────────────────────────────────
  if (!readonly && onDelete) {
    const deleteBtn = document.createElement('button')
    deleteBtn.textContent = 'Delete node'
    deleteBtn.type = 'button'
    deleteBtn.style.cssText =
      'background:#b62324;border:1px solid #8e1519;border-radius:var(--radius);' +
      'padding:.5rem .75rem;color:#fff;font-size:.8125rem;font-family:var(--font);' +
      'cursor:pointer;width:100%;font-weight:500;transition:background .15s;'
    deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.background = '#da3633' })
    deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.background = '#b62324' })
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete '${node.label}' and all its connections? This cannot be undone.`)) {
        onDelete()
      }
    })
    footer.appendChild(deleteBtn)
  }
}
