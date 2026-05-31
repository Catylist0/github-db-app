import type { Graph, GraphAPI, Node } from '../types'
import { svgEl, edgeEndpoint, makeEdgePath, makeNodeEl } from './utils'
import { showPanel, hidePanel } from '../ui/panel'

const DRAG_THRESHOLD = 4
const SELECTED_STROKE = '#58a6ff'
const DEFAULT_STROKE = '#4b5563'

export function addInteraction(
  svg: SVGSVGElement,
  viewport: SVGGElement,
  graph: Graph,
  api: GraphAPI,
): { setAuthenticated: (auth: boolean) => void } {
  svg.style.userSelect = 'none'

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

  // ── Auth state ─────────────────────────────────────────────────────────────

  let authenticated = false

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

  function toggleEdge(fromId: string, toId: string): void {
    const existingIdx = graph.edges.findIndex(e => e.from === fromId && e.to === toId)
    if (existingIdx >= 0) {
      const [removed] = graph.edges.splice(existingIdx, 1)
      viewport.querySelector(`[data-from="${fromId}"][data-to="${toId}"]`)?.remove()
      api.deleteEdge(removed.id).catch(console.error)
    } else {
      const edge = { id: `${fromId}-${toId}`, from: fromId, to: toId }
      graph.edges.push(edge)
      const path = makeEdgePath(getNodePos(fromId), getNodePos(toId), fromId, toId)
      const firstNode = viewport.querySelector<SVGGElement>('[data-node-id]')
      viewport.insertBefore(path, firstNode)
      api.upsertEdge(edge).catch(console.error)
    }
  }

  // ── Panel helpers ──────────────────────────────────────────────────────────

  function handleDeleteNode(id: string): void {
    api.deleteNode(id).catch(console.error)
    hidePanel()
    const idx = graph.nodes.findIndex(n => n.id === id)
    if (idx >= 0) graph.nodes.splice(idx, 1)
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id)
    viewport.querySelector(`[data-node-id="${id}"]`)?.remove()
    viewport.querySelectorAll<SVGPathElement>(`[data-from="${id}"],[data-to="${id}"]`)
      .forEach(p => p.remove())
    clearSelection()
  }

  function openPanel(node: Node, autoFocusName = false): void {
    const id = node.id
    const isReadonly = !authenticated
    showPanel(
      node,
      isReadonly ? () => {} : (updated) => {
        Object.assign(node, updated)
        if (updated.label !== undefined) {
          const textEl = viewport.querySelector<SVGTextElement>(`[data-node-id="${id}"] text`)
          if (textEl) textEl.textContent = updated.label
        }
        api.upsertNode(node).catch(console.error)
      },
      clearSelection,
      isReadonly ? undefined : () => handleDeleteNode(id),
      isReadonly ? false : autoFocusName,
      isReadonly,
    )
  }

  // ── Add-node mode ─────────────────────────────────────────────────────────

  let addMode = false
  let addModeDocListener: ((e: MouseEvent) => void) | null = null

  const addBtn = document.createElement('button')
  addBtn.textContent = '+'
  addBtn.title = 'Add node'
  addBtn.style.cssText =
    'position:fixed;bottom:1rem;left:1rem;width:2rem;height:2rem;' +
    'background:#1f2937;border:1px solid #4b5563;border-radius:6px;' +
    'color:#e6edf3;font-size:1.3rem;line-height:1;font-family:system-ui;' +
    'cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;'
  document.body.appendChild(addBtn)

  function setAddMode(active: boolean): void {
    addMode = active
    addBtn.style.borderColor = active ? SELECTED_STROKE : '#4b5563'
    addBtn.style.color = active ? SELECTED_STROKE : '#e6edf3'
    svg.style.cursor = active ? 'crosshair' : ''

    if (active && !addModeDocListener) {
      addModeDocListener = (e: MouseEvent) => {
        const t = e.target as Element
        if (svg.contains(t) || addBtn.contains(t)) return
        setAddMode(false)
      }
      document.addEventListener('mousedown', addModeDocListener)
    } else if (!active && addModeDocListener) {
      document.removeEventListener('mousedown', addModeDocListener)
      addModeDocListener = null
    }
  }

  addBtn.addEventListener('click', () => setAddMode(!addMode))

  let pendingAddPos: { x: number; y: number } | null = null
  let pendingAddClientStart = { x: 0, y: 0 }

  function createNodeAt(vp: { x: number; y: number }, shiftHeld: boolean): void {
    const node: Node = {
      id: crypto.randomUUID(),
      label: 'Unnamed',
      x: Math.round(vp.x),
      y: Math.round(vp.y),
    }
    graph.nodes.push(node)
    viewport.appendChild(makeNodeEl(node))
    api.upsertNode(node).catch(console.error)

    if (!shiftHeld) {
      setAddMode(false)
      clearSelection()
      selectNode(node.id)
      openPanel(node, true)
    }
  }

  // ── Public controls ───────────────────────────────────────────────────────

  function setAuthenticated(auth: boolean): void {
    authenticated = auth
    addBtn.style.display = auth ? 'flex' : 'none'
    if (!auth) setAddMode(false)
    hidePanel() // close panel on auth change to avoid stale edit/readonly state
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
    me.preventDefault()

    const nodeG = (me.target as Element).closest<SVGGElement>('[data-node-id]')

    if (nodeG) {
      setAddMode(false)
      activeNode = nodeG
      hasDragged = false
      dragClientStart = { x: me.clientX, y: me.clientY }
      singleDragOrigin = { cx: Number(nodeG.dataset.cx), cy: Number(nodeG.dataset.cy) }

      const nodeId = nodeG.dataset.nodeId!
      if (authenticated && me.shiftKey && selectedNodes.has(nodeId)) {
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

    if (addMode) {
      pendingAddPos = clientToViewport(me.clientX, me.clientY)
      pendingAddClientStart = { x: me.clientX, y: me.clientY }
    } else if (me.shiftKey) {
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
      hidePanel()
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
        if (!authenticated) return // no drag in read-only; click will still register on mouseup
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
        // Persist new positions (only reachable when authenticated)
        const moved = isMultiDrag ? [...multiDragOrigins.keys()] : [activeNode.dataset.nodeId!]
        for (const id of moved) {
          const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
          const node = graph.nodes.find(n => n.id === id)
          if (node) {
            node.x = Number(g.dataset.cx)
            node.y = Number(g.dataset.cy)
            api.upsertNode(node).catch(console.error)
          }
        }
      } else {
        // Click: open panel (read-only or edit depending on auth)
        const nodeId = activeNode.dataset.nodeId!
        if (authenticated && e.ctrlKey) {
          if (selectedNodes.size === 1 && !selectedNodes.has(nodeId)) {
            toggleEdge([...selectedNodes][0], nodeId)
          }
        } else {
          clearSelection()
          selectNode(nodeId)
          const node = graph.nodes.find(n => n.id === nodeId)!
          openPanel(node)
        }
      }
      activeNode.style.cursor = 'grab'
      activeNode = null
      isMultiDrag = false
      hasDragged = false
      return
    }

    if (pendingAddPos) {
      const dx = e.clientX - pendingAddClientStart.x
      const dy = e.clientY - pendingAddClientStart.y
      if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) {
        createNodeAt(pendingAddPos, e.shiftKey)
      }
      pendingAddPos = null
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
      svg.style.cursor = addMode ? 'crosshair' : ''
    }
  })

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

  return { setAuthenticated }
}
