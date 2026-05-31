import type { Node } from '../types'

// Callback stored so the close button can fire it even though it lives inside the panel DOM
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
    #panel-desc-rendered strong{color:#e6edf3;font-weight:600}
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

async function toHtml(md: string): Promise<string> {
  if (!md.trim()) return ''
  try {
    // @ts-ignore — CDN URL resolved at runtime, not by tsc
    const mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/marked/marked.min.js')
    const parse = (mod as Record<string, unknown>).marked ?? (mod as Record<string, unknown>).default
    if (typeof parse === 'function') return parse(md) as string
    if (typeof (globalThis as Record<string, unknown>).marked === 'function')
      return ((globalThis as Record<string, unknown>).marked as (s: string) => string)(md)
  } catch { /* ignore */ }
  // plain fallback: escape and preserve newlines
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
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
): void {
  hidePanel(true)
  injectStyles()
  pendingClose = onClose

  // ── Shell ─────────────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.id = 'detail-panel'
  panel.style.cssText =
    'position:fixed;top:0;right:0;width:320px;height:100vh;overflow-y:auto;' +
    'background:#161b22;border-left:1px solid #30363d;z-index:1000;' +
    'box-sizing:border-box;font-family:system-ui;' +
    'transform:translateX(320px);transition:transform .2s ease;'
  document.body.appendChild(panel)
  // double-rAF so the initial transform is painted before we start transitioning
  requestAnimationFrame(() => requestAnimationFrame(() => {
    panel.style.transform = 'translateX(0)'
  }))

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
  body.style.cssText = 'padding:1rem 1.25rem;display:flex;flex-direction:column;gap:1.1rem;'
  panel.appendChild(body)

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
  nameWrap.style.marginTop = '.4rem'
  nameWrap.appendChild(sectionLabel('Name'))

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.value = node.label
  labelInput.style.cssText =
    'background:#0d1117;border:1px solid #30363d;border-radius:6px;' +
    'padding:.45rem .65rem;color:#e6edf3;font-size:.9rem;font-family:system-ui;' +
    'width:100%;box-sizing:border-box;outline:none;'
  let savedLabel = node.label
  labelInput.addEventListener('focus', () => { labelInput.style.borderColor = '#58a6ff' })
  labelInput.addEventListener('blur', () => {
    labelInput.style.borderColor = '#30363d'
    if (labelInput.value !== savedLabel) {
      savedLabel = labelInput.value
      onUpdate({ label: labelInput.value })
    }
  })
  nameWrap.appendChild(labelInput)
  body.appendChild(nameWrap)

  // ── Description ───────────────────────────────────────────────────────────
  const descWrap = fieldWrap()
  descWrap.appendChild(sectionLabel('Description'))

  const sharedBorder =
    'background:#0d1117;border:1px solid #30363d;border-radius:6px;' +
    'padding:.45rem .65rem;box-sizing:border-box;width:100%;min-height:140px;' +
    'font-size:.8rem;line-height:1.55;outline:none;'

  const textarea = document.createElement('textarea')
  textarea.value = node.description ?? ''
  textarea.placeholder = 'Add a description… (markdown supported)'
  textarea.style.cssText =
    sharedBorder +
    'color:#e6edf3;font-family:monospace;resize:vertical;display:block;'

  const rendered = document.createElement('div')
  rendered.id = 'panel-desc-rendered'
  rendered.style.cssText =
    sharedBorder + 'color:#c9d1d9;cursor:text;word-break:break-word;display:none;'

  let savedDesc = node.description ?? ''

  async function applyRender(md: string): Promise<void> {
    const html = await toHtml(md)
    rendered.innerHTML = html ||
      '<span style="color:#484f58">Add a description… (markdown supported)</span>'
  }

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
    if (textarea.value !== savedDesc) {
      savedDesc = textarea.value
      onUpdate({ description: textarea.value })
    }
    applyRender(textarea.value).then(activateRendered)
  })
  rendered.addEventListener('click', activateTextarea)

  // Start in rendered mode if there's existing content, textarea otherwise
  if (node.description?.trim()) {
    textarea.style.display = 'none'
    rendered.style.display = 'block'
    applyRender(node.description)
  }

  descWrap.appendChild(textarea)
  descWrap.appendChild(rendered)
  body.appendChild(descWrap)
}
