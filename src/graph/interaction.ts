import type { Graph } from '../types'
import { svgEl, edgeEndpoint, makeEdgePath } from './utils'

const DRAG_THRESHOLD = 4
const SELECTED_STROKE = '#58a6ff'
const DEFAULT_STROKE = '#4b5563'

export function addInteraction(
  svg: SVGSVGElement,
  viewport: SVGGElement,
  graph: Graph,
  onSave: (g: Graph) => Promise<void>,
): void {
  const state = { tx: 0, ty: 0, scale: 1 }

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`)
  }

  function clientToViewport(cx: number, cy: number): { x: number; y: number } {
    const r = svg.getBoundingClientRect()
    return {
      x: (cx - r.left - state.tx) / state.scale,
      y: (cy - r.top - state.ty) / state.scale,
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  const selectedNodes = new Set<string>()

  function nodeRect(nodeG: SVGGElement): SVGRectElement {
    return nodeG.querySelector('rect')!
  }

  function selectNode(id: string): void {
    selectedNodes.add(id)
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
    if (g) nodeRect(g).setAttribute('stroke', SELECTED_STROKE)
  }

  function deselectNode(id: string): void {
    selectedNodes.delete(id)
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
    if (g) nodeRect(g).setAttribute('stroke', DEFAULT_STROKE)
  }

  function clearSelection(): void {
    for (const id of [...selectedNodes]) deselectNode(id)
  }

  // ── Edge helpers ───────────────────────────────────────────────────────────

  function getNodePos(id: string): { x: number; y: number } {
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
    return { x: Number(g.dataset.cx), y: Number(g.dataset.cy) }
  }

  function refreshEdgePath(path: SVGPathElement): void {
    const from = getNodePos(path.dataset.from!)
    const to = getNodePos(path.dataset.to!)
    const start = edgeEndpoint(to.x, to.y, from.x, from.y)
    const end = edgeEndpoint(from.x, from.y, to.x, to.y)
    path.setAttribute('d', `M ${start.x} ${start.y} L ${end.x} ${end.y}`)
  }

  function updateEdgesForNode(nodeId: string): void {
    for (const path of viewport.querySelectorAll<SVGPathElement>('[data-from]')) {
      if (path.dataset.from === nodeId || path.dataset.to === nodeId) {
        refreshEdgePath(path)
      }
    }
  }

  // ── Push button ───────────────────────────────────────────────────────────

  const pushBtn = document.createElement('button')
  pushBtn.textContent = 'Push'
  pushBtn.style.cssText =
    'position:fixed;bottom:1rem;right:1rem;background:#1f2937;border:1px solid #4b5563;' +
    'padding:.35rem .75rem;border-radius:6px;color:#6b7280;font-size:13px;font-family:system-ui;' +
    'cursor:not-allowed;opacity:0.5;transition:opacity .15s,border-color .15s,color .15s'
  pushBtn.disabled = true
  document.body.appendChild(pushBtn)

  function markDirty(): void {
    pushBtn.disabled = false
    pushBtn.style.color = '#e6edf3'
    pushBtn.style.borderColor = '#58a6ff'
    pushBtn.style.cursor = 'pointer'
    pushBtn.style.opacity = '1'
  }

  function syncNodePositions(): void {
    for (const g of viewport.querySelectorAll<SVGGElement>('[data-node-id]')) {
      const node = graph.nodes.find(n => n.id === g.dataset.nodeId)
      if (node) { node.x = Number(g.dataset.cx); node.y = Number(g.dataset.cy) }
    }
  }

  pushBtn.addEventListener('click', () => {
    syncNodePositions()
    pushBtn.textContent = 'Pushing…'
    pushBtn.disabled = true
    onSave(graph)
      .then(() => {
        pushBtn.textContent = 'Push'
        pushBtn.style.color = '#6b7280'
        pushBtn.style.borderColor = '#4b5563'
        pushBtn.style.cursor = 'not-allowed'
        pushBtn.style.opacity = '0.5'
      })
      .catch((err: unknown) => {
        pushBtn.textContent = 'Push (failed)'
        pushBtn.disabled = false
        pushBtn.style.color = '#f87171'
        pushBtn.style.borderColor = '#f87171'
        console.error(err)
      })
  })

  function toggleEdge(fromId: string, toId: string): void {
    const idx = graph.edges.findIndex(e => e.from === fromId && e.to === toId)
    if (idx >= 0) {
      graph.edges.splice(idx, 1)
      viewport.querySelector(`[data-from="${fromId}"][data-to="${toId}"]`)?.remove()
    } else {
      graph.edges.push({ from: fromId, to: toId })
      const path = makeEdgePath(getNodePos(fromId), getNodePos(toId), fromId, toId)
      const firstNode = viewport.querySelector<SVGGElement>('[data-node-id]')
      viewport.insertBefore(path, firstNode)
    }
    markDirty()
  }

  // ── Pan ────────────────────────────────────────────────────────────────────

  let panning = false
  let panStart = { x: 0, y: 0 }
  let panOrigin = { tx: 0, ty: 0 }

  // ── Node drag (single or multi) ────────────────────────────────────────────

  let activeNode: SVGGElement | null = null
  let isMultiDrag = false
  let hasDragged = false
  let dragClientStart = { x: 0, y: 0 }
  let singleDragOrigin = { cx: 0, cy: 0 }
  let multiDragOrigins = new Map<string, { cx: number; cy: number }>()

  // ── Box select ────────────────────────────────────────────────────────────

  let boxSelecting = false
  let boxVpStart = { x: 0, y: 0 }
  let boxEl: SVGRectElement | null = null

  // ── Event handlers ────────────────────────────────────────────────────────

  svg.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent
    const nodeG = (me.target as Element).closest<SVGGElement>('[data-node-id]')

    if (nodeG) {
      activeNode = nodeG
      hasDragged = false
      dragClientStart = { x: me.clientX, y: me.clientY }
      singleDragOrigin = { cx: Number(nodeG.dataset.cx), cy: Number(nodeG.dataset.cy) }

      const nodeId = nodeG.dataset.nodeId!
      if (me.shiftKey && selectedNodes.has(nodeId)) {
        isMultiDrag = true
        multiDragOrigins.clear()
        for (const id of selectedNodes) {
          const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
          multiDragOrigins.set(id, { cx: Number(g.dataset.cx), cy: Number(g.dataset.cy) })
        }
      } else {
        isMultiDrag = false
      }
      return
    }

    if (me.shiftKey) {
      // Box select
      boxSelecting = true
      boxVpStart = clientToViewport(me.clientX, me.clientY)
      boxEl = svgEl('rect')
      boxEl.setAttribute('x', String(boxVpStart.x))
      boxEl.setAttribute('y', String(boxVpStart.y))
      boxEl.setAttribute('width', '0')
      boxEl.setAttribute('height', '0')
      boxEl.setAttribute('fill', 'rgba(88,166,255,0.1)')
      boxEl.setAttribute('stroke', '#58a6ff')
      boxEl.setAttribute('stroke-width', String(1 / state.scale))
      boxEl.setAttribute('stroke-dasharray', String(4 / state.scale))
      boxEl.setAttribute('pointer-events', 'none')
      viewport.appendChild(boxEl)
    } else {
      // Pan
      panning = true
      panStart = { x: me.clientX, y: me.clientY }
      panOrigin = { tx: state.tx, ty: state.ty }
      svg.style.cursor = 'grabbing'
      clearSelection()
    }
  })

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (activeNode) {
      const dx = e.clientX - dragClientStart.x
      const dy = e.clientY - dragClientStart.y
      if (!hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        hasDragged = true
        activeNode.style.cursor = 'grabbing'
      }
      if (hasDragged) {
        if (isMultiDrag) {
          for (const [id, origin] of multiDragOrigins) {
            const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
            const cx = origin.cx + dx / state.scale
            const cy = origin.cy + dy / state.scale
            g.dataset.cx = String(cx)
            g.dataset.cy = String(cy)
            g.setAttribute('transform', `translate(${cx - 60},${cy - 20})`)
            updateEdgesForNode(id)
          }
        } else {
          const cx = singleDragOrigin.cx + dx / state.scale
          const cy = singleDragOrigin.cy + dy / state.scale
          activeNode.dataset.cx = String(cx)
          activeNode.dataset.cy = String(cy)
          activeNode.setAttribute('transform', `translate(${cx - 60},${cy - 20})`)
          updateEdgesForNode(activeNode.dataset.nodeId!)
        }
      }
      return
    }

    if (boxSelecting && boxEl) {
      const vp = clientToViewport(e.clientX, e.clientY)
      const x = Math.min(vp.x, boxVpStart.x)
      const y = Math.min(vp.y, boxVpStart.y)
      boxEl.setAttribute('x', String(x))
      boxEl.setAttribute('y', String(y))
      boxEl.setAttribute('width', String(Math.abs(vp.x - boxVpStart.x)))
      boxEl.setAttribute('height', String(Math.abs(vp.y - boxVpStart.y)))
      return
    }

    if (panning) {
      state.tx = panOrigin.tx + (e.clientX - panStart.x)
      state.ty = panOrigin.ty + (e.clientY - panStart.y)
      applyTransform()
    }
  })

  window.addEventListener('mouseup', (e: MouseEvent) => {
    if (activeNode) {
      if (hasDragged) {
        markDirty()
      } else {
        const nodeId = activeNode.dataset.nodeId!
        if (e.ctrlKey) {
          if (selectedNodes.size === 1 && !selectedNodes.has(nodeId)) {
            toggleEdge([...selectedNodes][0], nodeId)
          }
          // Never touch selection while Ctrl is held
        } else {
          clearSelection()
          selectNode(nodeId)
        }
      }
      activeNode.style.cursor = 'grab'
      activeNode = null
      isMultiDrag = false
      hasDragged = false
      return
    }

    if (boxSelecting) {
      if (boxEl) {
        const x1 = Number(boxEl.getAttribute('x'))
        const y1 = Number(boxEl.getAttribute('y'))
        const x2 = x1 + Number(boxEl.getAttribute('width'))
        const y2 = y1 + Number(boxEl.getAttribute('height'))
        clearSelection()
        for (const g of viewport.querySelectorAll<SVGGElement>('[data-node-id]')) {
          const cx = Number(g.dataset.cx)
          const cy = Number(g.dataset.cy)
          if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
            selectNode(g.dataset.nodeId!)
          }
        }
        boxEl.remove()
        boxEl = null
      }
      boxSelecting = false
      return
    }

    if (panning) {
      panning = false
      svg.style.cursor = ''
    }
  })

  // Zoom toward cursor
  svg.addEventListener('wheel', (e: Event) => {
    const we = e as WheelEvent
    we.preventDefault()
    const factor = we.deltaY > 0 ? 0.9 : 1.1
    const newScale = Math.max(0.1, Math.min(10, state.scale * factor))
    const rect = svg.getBoundingClientRect()
    const cx = we.clientX - rect.left
    const cy = we.clientY - rect.top
    state.tx = cx - (cx - state.tx) * (newScale / state.scale)
    state.ty = cy - (cy - state.ty) * (newScale / state.scale)
    state.scale = newScale
    applyTransform()
  }, { passive: false })
}
