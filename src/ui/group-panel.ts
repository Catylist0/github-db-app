import type { Grouping } from '../types'

// The grouping panel. This first pass exposes member add/remove, a colour
// picker and delete; it shares the right-hand sliding-panel shell with the node
// detail panel and is intentionally structured so further sections can be added.

export interface GroupPanelHandlers {
  getSelectionCount: () => number
  onAddSelection: () => void
  onRemoveSelection: () => void
  onNameCommit: (from: string, to: string) => void
  onToggleLock: (locked: boolean) => void
  onColorPreview: (color: string) => void
  onColorCommit: (from: string, to: string) => void
  onDelete: () => void
  onClose: () => void
}

let pendingClose: (() => void) | undefined

export function isGroupPanelOpen(): boolean {
  return !!document.getElementById('group-panel')
}

export function hideGroupPanel(immediate = false): void {
  pendingClose = undefined
  const panel = document.getElementById('group-panel')
  if (!panel) return
  if (immediate) { panel.remove(); return }
  panel.style.transform = 'translateX(320px)'
  setTimeout(() => panel.remove(), 210)
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
  el.style.cssText = 'display:flex;flex-direction:column;gap:.45rem;'
  return el
}

function actionBtn(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.disabled = disabled
  btn.style.cssText =
    'height:2rem;padding:0 .75rem;background:var(--bg);border:1px solid var(--border);' +
    'border-radius:var(--radius);color:var(--text);font-size:.8125rem;font-family:var(--font);' +
    `cursor:${disabled ? 'default' : 'pointer'};${disabled ? 'opacity:.45;' : ''}` +
    'transition:background .15s,border-color .15s;width:100%;'
  if (!disabled) {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--surface-elevated)'; btn.style.borderColor = 'var(--accent)' })
    btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg)'; btn.style.borderColor = 'var(--border)' })
    btn.addEventListener('click', onClick)
  }
  return btn
}

export function showGroupPanel(grouping: Grouping, handlers: GroupPanelHandlers, readonly = false): void {
  const wasOpen = isGroupPanelOpen()
  hideGroupPanel(true)
  pendingClose = handlers.onClose

  const panel = document.createElement('div')
  panel.id = 'group-panel'
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
    requestAnimationFrame(() => requestAnimationFrame(() => { panel.style.transform = 'translateX(0)' }))
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;flex-shrink:0;' +
    'height:2.5rem;padding:0 .625rem 0 1.25rem;border-bottom:1px solid var(--border-muted);'
  const title = document.createElement('span')
  title.textContent = 'Grouping'
  title.style.cssText = 'font-size:.8125rem;font-weight:600;color:var(--text);letter-spacing:.02em;'
  header.appendChild(title)

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText =
    'background:none;border:none;color:#484f58;font-size:1.1rem;line-height:1;cursor:pointer;padding:.2rem .45rem;'
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#e6edf3' })
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#484f58' })
  closeBtn.addEventListener('click', () => { const cb = pendingClose; hideGroupPanel(); cb?.() })
  header.appendChild(closeBtn)
  panel.appendChild(header)

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.style.cssText =
    'padding:1.125rem 1.25rem;display:flex;flex-direction:column;gap:1.25rem;flex:1;min-height:0;overflow-y:auto;'
  panel.appendChild(body)

  if (readonly) {
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:.75rem;color:#484f58;font-style:italic;'
    hint.textContent = 'Login to edit'
    body.appendChild(hint)
  }

  // ── Name ──────────────────────────────────────────────────────────────────
  const nameField = fieldWrap()
  nameField.appendChild(sectionLabel('Name'))
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.value = grouping.name
  nameInput.disabled = readonly
  nameInput.style.cssText =
    'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);' +
    'padding:.5rem .65rem;color:var(--text);font-size:.875rem;font-family:var(--font);' +
    'width:100%;box-sizing:border-box;outline:none;transition:border-color .15s;' +
    (readonly ? 'opacity:.45;cursor:default;' : '')
  if (!readonly) {
    let savedName = grouping.name
    nameInput.addEventListener('focus', () => { nameInput.style.borderColor = 'var(--accent)' })
    nameInput.addEventListener('blur', () => {
      nameInput.style.borderColor = 'var(--border)'
      if (nameInput.value !== savedName) {
        handlers.onNameCommit(savedName, nameInput.value)
        savedName = nameInput.value
      }
    })
  }
  nameField.appendChild(nameInput)
  body.appendChild(nameField)

  // Member count summary
  const summary = document.createElement('div')
  summary.style.cssText = 'font-size:.8125rem;color:var(--text-muted);'
  const count = grouping.members.length
  summary.textContent = `${count} member node${count === 1 ? '' : 's'}`
  body.appendChild(summary)

  // ── Selection actions ─────────────────────────────────────────────────────
  if (!readonly) {
    const selCount = handlers.getSelectionCount()
    const actions = fieldWrap()
    actions.appendChild(sectionLabel('Selection'))
    actions.appendChild(actionBtn(
      selCount > 0 ? `Add selection to group (${selCount})` : 'Add selection to group',
      selCount === 0,
      handlers.onAddSelection,
    ))
    actions.appendChild(actionBtn(
      selCount > 0 ? `Remove selection from group (${selCount})` : 'Remove selection from group',
      selCount === 0,
      handlers.onRemoveSelection,
    ))
    if (selCount === 0) {
      const hint = document.createElement('div')
      hint.style.cssText = 'font-size:.7rem;color:#484f58;'
      hint.textContent = 'Select one or more nodes to add or remove them.'
      actions.appendChild(hint)
    }
    body.appendChild(actions)

    // ── Lock ──────────────────────────────────────────────────────────────────
    const lockField = fieldWrap()
    lockField.appendChild(sectionLabel('Lock'))
    let locked = grouping.locked
    const lockBtn = document.createElement('button')
    lockBtn.type = 'button'
    lockBtn.style.cssText =
      'height:2rem;padding:0 .75rem;border-radius:var(--radius);font-size:.8125rem;' +
      'font-family:var(--font);cursor:pointer;width:100%;display:flex;align-items:center;' +
      'justify-content:center;gap:.4rem;transition:background .15s,border-color .15s,color .15s;'
    const applyLockStyle = (): void => {
      lockBtn.textContent = locked ? '🔒  Locked' : '🔓  Unlocked'
      if (locked) {
        lockBtn.style.background = 'var(--accent)'
        lockBtn.style.borderColor = 'var(--accent)'
        lockBtn.style.color = '#0d1117'
        lockBtn.style.border = '1px solid var(--accent)'
      } else {
        lockBtn.style.background = 'var(--bg)'
        lockBtn.style.color = 'var(--text-muted)'
        lockBtn.style.border = '1px solid var(--border)'
      }
    }
    applyLockStyle()
    lockBtn.addEventListener('click', () => {
      locked = !locked
      applyLockStyle()
      handlers.onToggleLock(locked)
    })
    lockField.appendChild(lockBtn)
    const lockHint = document.createElement('div')
    lockHint.style.cssText = 'font-size:.7rem;color:#484f58;'
    lockHint.textContent = 'When locked, dragging a node into the region keeps it out instead of adding it.'
    lockField.appendChild(lockHint)
    body.appendChild(lockField)

    // ── Colour ──────────────────────────────────────────────────────────────
    const colorField = fieldWrap()
    colorField.appendChild(sectionLabel('Colour'))
    const colorRow = document.createElement('label')
    colorRow.style.cssText = 'display:flex;align-items:center;gap:.6rem;cursor:pointer;'
    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    colorInput.value = grouping.color
    colorInput.style.cssText =
      'width:2.25rem;height:2.25rem;padding:0;border:1px solid var(--border);' +
      'border-radius:var(--radius);background:var(--bg);cursor:pointer;'
    let beforeColor = grouping.color
    colorInput.addEventListener('input', () => handlers.onColorPreview(colorInput.value))
    colorInput.addEventListener('change', () => {
      handlers.onColorCommit(beforeColor, colorInput.value)
      beforeColor = colorInput.value
    })
    const colorText = document.createElement('span')
    colorText.style.cssText = 'font-size:.8125rem;color:var(--text-muted);'
    colorText.textContent = 'Group colour'
    colorRow.append(colorInput, colorText)
    colorField.appendChild(colorRow)
    body.appendChild(colorField)
  }

  // ── Footer (delete) ───────────────────────────────────────────────────────
  if (!readonly) {
    const footer = document.createElement('div')
    footer.style.cssText =
      'flex-shrink:0;padding:.875rem 1.25rem 1rem;border-top:1px solid var(--border-muted);'
    const deleteBtn = document.createElement('button')
    deleteBtn.textContent = 'Delete group'
    deleteBtn.type = 'button'
    deleteBtn.style.cssText =
      'background:#b62324;border:1px solid #8e1519;border-radius:var(--radius);' +
      'padding:.5rem .75rem;color:#fff;font-size:.8125rem;font-family:var(--font);' +
      'cursor:pointer;width:100%;font-weight:500;transition:background .15s;'
    deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.background = '#da3633' })
    deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.background = '#b62324' })
    deleteBtn.addEventListener('click', handlers.onDelete)
    footer.appendChild(deleteBtn)
    panel.appendChild(footer)
  }
}
