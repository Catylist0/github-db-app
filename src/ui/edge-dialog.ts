import type { Edge, EdgeRouting, EdgeStyle } from '../types'

let _dialog: HTMLElement | null = null
let _clickOutside: ((e: MouseEvent) => void) | null = null

export function isEdgeDialogOpen(): boolean {
  return _dialog !== null
}

export function closeEdgeDialog(): void {
  if (_clickOutside) {
    document.removeEventListener('mousedown', _clickOutside)
    _clickOutside = null
  }
  _dialog?.remove()
  _dialog = null
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div')
  el.textContent = text
  el.style.cssText = 'font-size:.6rem;color:#484f58;font-weight:600;letter-spacing:.07em;margin-bottom:.3rem;'
  return el
}

function buttonGroup(...btns: HTMLElement[]): HTMLElement {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:0;border:1px solid #30363d;border-radius:var(--radius);overflow:hidden;'
  btns.forEach((b, i) => {
    if (i > 0) b.style.borderLeft = '1px solid #30363d'
    row.appendChild(b)
  })
  return row
}

function modeBtn(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.style.cssText =
    `flex:1;border:none;padding:.35rem .5rem;font-size:.75rem;font-family:var(--font);cursor:pointer;` +
    `transition:background .12s,color .12s;` +
    `background:${active ? '#0d2840' : '#0d1117'};color:${active ? '#58a6ff' : '#8b949e'};`
  btn.addEventListener('mouseenter', () => {
    if (!btn.dataset.active) {
      btn.style.background = '#21262d'
      btn.style.color = '#e6edf3'
    }
  })
  btn.addEventListener('mouseleave', () => {
    if (!btn.dataset.active) {
      btn.style.background = '#0d1117'
      btn.style.color = '#8b949e'
    }
  })
  if (active) btn.dataset.active = '1'
  btn.addEventListener('click', onClick)
  return btn
}

function iconActionBtn(icon: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.title = title
  btn.textContent = icon
  btn.disabled = disabled
  btn.style.cssText =
    'flex:1;border:1px solid #30363d;border-radius:var(--radius);padding:.35rem;' +
    'font-size:.875rem;font-family:var(--font);cursor:pointer;background:#0d1117;' +
    `color:${disabled ? '#484f58' : '#8b949e'};transition:background .12s,color .12s;`
  if (!disabled) {
    btn.addEventListener('mouseenter', () => { btn.style.background = '#21262d'; btn.style.color = '#e6edf3' })
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0d1117'; btn.style.color = '#8b949e' })
  }
  btn.addEventListener('click', onClick)
  return btn
}

export function openEdgeDialog(
  edge: Edge,
  screenX: number,
  screenY: number,
  clipboard: { routing: EdgeRouting; style: EdgeStyle; vanish: boolean } | null,
  onPatch: (patch: Partial<Pick<Edge, 'routing' | 'style' | 'vanish'>>) => void,
  onCopy: () => void,
  onPaste: () => void,
): void {
  closeEdgeDialog()

  const dialog = document.createElement('div')
  _dialog = dialog
  dialog.style.cssText =
    'position:fixed;z-index:2000;background:#161b22;border:1px solid #30363d;' +
    'border-radius:var(--radius);padding:.75rem;font-family:var(--font);' +
    'box-shadow:0 8px 24px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:.6rem;min-width:210px;'

  // Position: to the left of the edge midpoint so the line stays visible
  document.body.appendChild(dialog)
  const dw = dialog.offsetWidth || 220
  const dh = dialog.offsetHeight || 160
  const vh = window.innerHeight
  const GAP = 16
  const leftX = Math.max(8, screenX - dw - GAP)
  dialog.style.left = `${leftX}px`
  dialog.style.top = `${Math.max(8, Math.min(screenY - dh / 2, vh - dh - 8))}px`

  // ── Routing ──────────────────────────────────────────────────────────────
  let currentRouting: EdgeRouting = edge.routing
  const routingBtns: HTMLButtonElement[] = []
  const routingDefs: Array<{ value: EdgeRouting; label: string }> = [
    { value: 'straight', label: 'Straight' },
    { value: 'elbow1', label: '1-Joint' },
    { value: 'elbow2', label: '2-Joint' },
  ]

  function refreshRoutingBtns(): void {
    routingBtns.forEach((b, i) => {
      const active = routingDefs[i].value === currentRouting
      b.style.background = active ? '#0d2840' : '#0d1117'
      b.style.color = active ? '#58a6ff' : '#8b949e'
      if (active) b.dataset.active = '1'
      else delete b.dataset.active
    })
  }

  const routingRow = document.createElement('div')
  routingBtns.push(...routingDefs.map(({ value, label }) => {
    const btn = modeBtn(label, edge.routing === value, () => {
      currentRouting = value
      refreshRoutingBtns()
      onPatch({ routing: value })
    })
    return btn
  }))
  routingRow.appendChild(sectionLabel('ROUTING'))
  routingRow.appendChild(buttonGroup(...routingBtns))
  dialog.appendChild(routingRow)

  // ── Style ─────────────────────────────────────────────────────────────────
  let currentStyle: EdgeStyle = edge.style
  const styleBtns: HTMLButtonElement[] = []
  const styleDefs: Array<{ value: EdgeStyle; label: string }> = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
  ]

  function refreshStyleBtns(): void {
    styleBtns.forEach((b, i) => {
      const active = styleDefs[i].value === currentStyle
      b.style.background = active ? '#0d2840' : '#0d1117'
      b.style.color = active ? '#58a6ff' : '#8b949e'
      if (active) b.dataset.active = '1'
      else delete b.dataset.active
    })
  }

  const styleRow = document.createElement('div')
  styleBtns.push(...styleDefs.map(({ value, label }) => {
    const btn = modeBtn(label, edge.style === value, () => {
      currentStyle = value
      refreshStyleBtns()
      onPatch({ style: value })
    })
    return btn
  }))
  styleRow.appendChild(sectionLabel('STYLE'))
  styleRow.appendChild(buttonGroup(...styleBtns))
  dialog.appendChild(styleRow)

  // ── Vanish ────────────────────────────────────────────────────────────────
  const vanishRow = document.createElement('label')
  vanishRow.style.cssText = 'display:flex;align-items:center;gap:.5rem;cursor:pointer;'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = edge.vanish
  checkbox.style.cssText = 'accent-color:#58a6ff;width:13px;height:13px;cursor:pointer;'
  checkbox.addEventListener('change', () => onPatch({ vanish: checkbox.checked }))
  const vanishLabel = document.createElement('span')
  vanishLabel.textContent = 'Fade through intersections'
  vanishLabel.style.cssText = 'font-size:.8rem;color:#8b949e;'
  vanishRow.append(checkbox, vanishLabel)
  dialog.appendChild(vanishRow)

  // ── Divider ───────────────────────────────────────────────────────────────
  const hr = document.createElement('div')
  hr.style.cssText = 'border-top:1px solid #21262d;margin:0 -.75rem;'
  dialog.appendChild(hr)

  // ── Copy / Paste ──────────────────────────────────────────────────────────
  const cpRow = document.createElement('div')
  cpRow.style.cssText = 'display:flex;gap:.4rem;'
  cpRow.appendChild(iconActionBtn('⎘ Copy', 'Copy edge style', false, () => {
    onCopy()
    closeEdgeDialog()
  }))
  cpRow.appendChild(iconActionBtn('⏙ Paste', 'Paste edge style', !clipboard, () => {
    if (!clipboard) return
    onPaste()
    closeEdgeDialog()
  }))
  dialog.appendChild(cpRow)

  // Reposition now that content is rendered
  requestAnimationFrame(() => {
    const dw2 = dialog.offsetWidth
    const dh2 = dialog.offsetHeight
    dialog.style.left = `${Math.max(8, screenX - dw2 - GAP)}px`
    dialog.style.top = `${Math.max(8, Math.min(screenY - dh2 / 2, vh - dh2 - 8))}px`
  })

  _clickOutside = (e: MouseEvent) => {
    if (e.target instanceof Element && dialog.contains(e.target)) return
    closeEdgeDialog()
  }
  setTimeout(() => { if (_clickOutside) document.addEventListener('mousedown', _clickOutside) }, 150)
}
