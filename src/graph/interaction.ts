import type { Graph, GraphAPI, GraphChanges, Node, Edge, EdgeRouting, EdgeStyle } from '../types'
import {
  svgEl,
  makeEdgePath,
  makeNodeEl,
  nodeBorderColor,
  nodeIsReady,
  nodeClassFill,
  statusEdgeColor,
  edgeMarkerUrl,
  displayPathFromSegments,
  nodeHalfHeight,
  setPulse,
  NODE_HH,
  NODE_STROKE_WIDTH,
  SELECTED_NODE_STROKE_WIDTH,
  computeEdgeGeometry,
  buildVanishMask,
  cleanupVanishDefs,
  segPathLength,
  stackEdgeSegments,
  type Seg,
} from './utils'
import { showPanel, hidePanel } from '../ui/panel'
import { record, popUndo, pushRedo, popRedo, pushUndo, clearHistory } from '../history/stack'
import { openEdgeDialog, closeEdgeDialog, isEdgeDialogOpen } from '../ui/edge-dialog'
import type { HistoryEntry, EdgeSettingsPatch } from '../history/stack'

const DRAG_THRESHOLD = 4
const SELECTED_STROKE = '#58a6ff'

export function addInteraction(
  svg: SVGSVGElement,
  viewport: SVGGElement,
  graph: Graph,
  api: GraphAPI,
  options?: { onFocusNode?: (nodeId: string | null) => void },
): { setAuthenticated: (auth: boolean) => void; centerOnNode: (id: string) => void; undo: () => void; redo: () => void; applyRemoteChanges: (changes: GraphChanges) => boolean } {
  svg.style.userSelect = 'none'

  const state = { tx: 0, ty: 0, scale: 1 }

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`)
    positionIconClusters()
  }

  function clientToViewport(cx: number, cy: number): { x: number; y: number } {
    const r = svg.getBoundingClientRect()
    return {
      x: (cx - r.left - state.tx) / state.scale,
      y: (cy - r.top - state.ty) / state.scale,
    }
  }

  function vpToScreen(vpX: number, vpY: number): { x: number; y: number } {
    const r = svg.getBoundingClientRect()
    return { x: r.left + state.tx + vpX * state.scale, y: r.top + state.ty + vpY * state.scale }
  }

  // ── Auth state ─────────────────────────────────────────────────────────────
  let authenticated = false

  // ── Focus tracking ─────────────────────────────────────────────────────────
  let _focusedNodeId: string | null = null

  function setFocusedNode(nodeId: string | null): void {
    if (_focusedNodeId === nodeId) return
    _focusedNodeId = nodeId
    options?.onFocusNode?.(nodeId)
  }

  // ── Edge clipboard ─────────────────────────────────────────────────────────
  let edgeClipboard: { routing: EdgeRouting; style: EdgeStyle; vanish: boolean } | null = null

  // ── Vanish mask management ─────────────────────────────────────────────────

  function getDefs(): SVGDefsElement | null {
    return svg.querySelector<SVGDefsElement>('defs')
  }

  function rebuildAllVanish(): void {
    const defs = getDefs()
    if (!defs) return

    // Base geometry (obstacle-aware routing) for every edge, then the global
    // stacking pass that spreads overlapping parallel segments into evenly
    // spaced stacks. The stacked segments drive both the rendered path and the
    // edge-edge vanish intersections below.
    const edgeById = new Map(graph.edges.map(e => [e.id, e]))
    const items: { id: string; fromId: string; toId: string; routing: EdgeRouting; segments: Seg[] }[] = []
    for (const edge of graph.edges) {
      try {
        const geo = computeEdgeGeometry(getNodePos(edge.from), getNodePos(edge.to), edge.routing, obstaclesFor(edge.from, edge.to))
        items.push({ id: edge.id, fromId: edge.from, toId: edge.to, routing: edge.routing, segments: geo.segments })
      } catch { /* node may be mid-removal */ }
    }

    const segMap = new Map<string, Seg[]>()
    for (const [id, geo] of stackEdgeSegments(items, getNodePos)) {
      segMap.set(id, geo.segments)
      const edge = edgeById.get(id)
      if (!edge) continue
      const path = viewport.querySelector<SVGPathElement>(`[data-from="${edge.from}"][data-to="${edge.to}"]`)
      if (path) {
        path.setAttribute('d', displayPathFromSegments(geo.segments))
        path.dataset.midX = String(geo.midX)
        path.dataset.midY = String(geo.midY)
      }
    }

    for (const edge of graph.edges) {
      if (!edge.vanish) {
        // Remove any stale mask
        cleanupVanishDefs(edge.id, defs)
        const path = viewport.querySelector<SVGPathElement>(`[data-from="${edge.from}"][data-to="${edge.to}"]`)
        path?.removeAttribute('mask')
        continue
      }

      const mySegs = segMap.get(edge.id)
      if (!mySegs) continue

      const path = viewport.querySelector<SVGPathElement>(`[data-from="${edge.from}"][data-to="${edge.to}"]`)
      if (!path) continue

      cleanupVanishDefs(edge.id, defs)

      const myLength = segPathLength(mySegs)
      const otherEdges = [...segMap.entries()]
        .filter(([id]) => id !== edge.id)
        .map(([id, segs]) => ({
          id,
          segs,
          vanish: edgeById.get(id)?.vanish ?? false,
          length: segPathLength(segs),
        }))

      const mask = buildVanishMask(edge.id, mySegs, myLength, edge.from, edge.to, graph.nodes, otherEdges, defs)
      if (mask) {
        defs.appendChild(mask)
        path.setAttribute('mask', `url(#vm-${edge.id})`)
      } else {
        path.removeAttribute('mask')
      }
    }
  }

  // ── Icon clusters ──────────────────────────────────────────────────────────
  interface IconCluster { edgeId: string; el: SVGGElement; midVpX: number; midVpY: number }
  let iconClusters: IconCluster[] = []

  function clearIconClusters(): void {
    for (const c of iconClusters) c.el.remove()
    iconClusters = []
  }

  function positionIconClusters(): void {
    for (const c of iconClusters) {
      c.el.setAttribute('transform', `translate(${state.tx + c.midVpX * state.scale},${state.ty + c.midVpY * state.scale})`)
    }
  }

  // Clipboard shape: body (x: -4.5…4.5, y: -2.5…5.5) + clip notch (x: -2…2, y: -5.5…-2.5)
  function makeClipboardIcon(): SVGElement {
    const path = svgEl('path')
    path.setAttribute('d', 'M-2,-5.5 L2,-5.5 L2,-2.5 L4.5,-2.5 L4.5,5.5 L-4.5,5.5 L-4.5,-2.5 L-2,-2.5 Z')
    return path
  }

  function svgIconBtn(
    icon: string | SVGElement,
    hoverColor: string,
    onClick: (e: MouseEvent) => void,
    opts: { r?: number; fontSize?: number } = {},
  ): SVGGElement {
    const r = opts.r ?? 11
    const fontSize = opts.fontSize ?? 14

    const g = svgEl('g')
    g.style.cursor = 'pointer'
    g.style.color = '#c9d1d9'   // drives fill:currentColor on inner content

    const circle = svgEl('circle')
    circle.setAttribute('r', String(r))
    circle.setAttribute('fill', '#161b22')
    circle.setAttribute('stroke', '#30363d')
    circle.setAttribute('stroke-width', '1.5')
    g.appendChild(circle)

    if (typeof icon === 'string') {
      const text = svgEl('text')
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'central')
      text.setAttribute('fill', 'currentColor')
      text.setAttribute('font-size', String(fontSize))
      text.setAttribute('font-family', "'Segoe UI Symbol','Apple Color Emoji','Noto Emoji',system-ui,sans-serif")
      text.setAttribute('pointer-events', 'none')
      text.style.userSelect = 'none'
      text.textContent = icon
      g.appendChild(text)
    } else {
      const wrap = svgEl('g')
      wrap.setAttribute('fill', 'currentColor')
      wrap.setAttribute('pointer-events', 'none')
      wrap.appendChild(icon)
      g.appendChild(wrap)
    }

    g.addEventListener('mouseenter', () => {
      circle.setAttribute('fill', '#21262d')
      circle.setAttribute('stroke', hoverColor)
      g.style.color = '#e6edf3'
    })
    g.addEventListener('mouseleave', () => {
      circle.setAttribute('fill', '#161b22')
      circle.setAttribute('stroke', '#30363d')
      g.style.color = '#c9d1d9'
    })
    g.addEventListener('mousedown', e => e.stopPropagation())
    g.addEventListener('click', onClick)
    return g
  }

  // Apply a line-settings patch to an edge (mutate model, DOM and persist).
  // Does not touch the undo history — callers that originate a user edit should
  // use applyEdgePatch so the change is recorded.
  function setEdgeSettings(edge: Edge, patch: EdgeSettingsPatch, persist = true): void {
    Object.assign(edge, patch)
    const path = viewport.querySelector<SVGPathElement>(`[data-from="${edge.from}"][data-to="${edge.to}"]`)
    if (!path) return
    const fromPos = getNodePos(edge.from)
    const toPos = getNodePos(edge.to)
    const geo = computeEdgeGeometry(fromPos, toPos, edge.routing, obstaclesFor(edge.from, edge.to))
    path.setAttribute('d', displayPathFromSegments(geo.segments))
    path.dataset.midX = String(geo.midX)
    path.dataset.midY = String(geo.midY)
    path.setAttribute('stroke-dasharray', edge.style === 'dashed' ? '6 4' : '')
    if (persist) api.patchEdge(edge.id, patch).catch(console.error)
    rebuildAllVanish()
  }

  function applyEdgePatch(edge: Edge, patch: EdgeSettingsPatch): void {
    // Capture only the fields that actually change, so undo/redo restores the
    // exact prior settings (and a no-op edit is not recorded).
    const before: EdgeSettingsPatch = {}
    const after: EdgeSettingsPatch = {}
    for (const key of Object.keys(patch) as (keyof EdgeSettingsPatch)[]) {
      const next = patch[key]
      if (next === undefined || edge[key] === next) continue
      ;(before as Record<string, unknown>)[key] = edge[key]
      ;(after as Record<string, unknown>)[key] = next
    }
    if (Object.keys(after).length === 0) return
    record({ type: 'settings-edge', id: edge.id, from: before, to: after })
    setEdgeSettings(edge, after)
  }

  function buildIconCluster(edge: Edge, midVpX: number, midVpY: number): SVGGElement {
    const g = svgEl('g')

    type Item = { icon: string | SVGElement; color: string; r?: number; fontSize?: number; fn: (e: MouseEvent) => void }
    const items: Item[] = []

    if (edgeClipboard) {
      items.push({ icon: makeClipboardIcon(), color: '#22c55e', fn: (e) => {
        e.stopPropagation()
        if (!edgeClipboard) return
        applyEdgePatch(edge, { ...edgeClipboard })
        updateIconClusters()
      }})
    }
    items.push({ icon: '⎘', color: '#58a6ff', fn: (e) => {
      e.stopPropagation()
      edgeClipboard = { routing: edge.routing, style: edge.style, vanish: edge.vanish }
      updateIconClusters()
    }})
    items.push({ icon: '⚙', color: '#f97316', r: 14, fontSize: 26, fn: (e) => {
      e.stopPropagation()
      const sc = vpToScreen(midVpX, midVpY)
      clearIconClusters()
      openEdgeDialog(
        edge, sc.x, sc.y, edgeClipboard,
        (patch) => { applyEdgePatch(edge, patch); updateIconClusters() },
        () => {
          edgeClipboard = { routing: edge.routing, style: edge.style, vanish: edge.vanish }
          updateIconClusters()
        },
        () => {
          if (!edgeClipboard) return
          applyEdgePatch(edge, { ...edgeClipboard })
          updateIconClusters()
        },
      )
    }})

    const spacing = 30
    const totalW = (items.length - 1) * spacing
    const offsetX = -totalW / 2

    for (let i = 0; i < items.length; i++) {
      const { icon, color, r, fontSize, fn } = items[i]
      const btn = svgIconBtn(icon, color, fn, { r, fontSize })
      btn.setAttribute('transform', `translate(${offsetX + i * spacing},0)`)
      g.appendChild(btn)
    }

    return g
  }

  function updateIconClusters(): void {
    clearIconClusters()
    if (!authenticated || selectedNodes.size === 0) return
    if (isEdgeDialogOpen()) return

    for (const path of viewport.querySelectorAll<SVGPathElement>('[data-from]')) {
      const fromId = path.dataset.from!
      const toId = path.dataset.to!
      if (!selectedNodes.has(fromId) && !selectedNodes.has(toId)) continue

      const edgeId = path.dataset.edgeId!
      const edge = graph.edges.find(e => e.id === edgeId)
      if (!edge) continue

      const midVpX = Number(path.dataset.midX)
      const midVpY = Number(path.dataset.midY)

      const g = buildIconCluster(edge, midVpX, midVpY)
      svg.appendChild(g)
      iconClusters.push({ edgeId, el: g, midVpX, midVpY })
    }

    positionIconClusters()
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  const selectedNodes = new Set<string>()

  function nodeRect(nodeG: SVGGElement): SVGRectElement {
    return nodeG.querySelector('rect')!
  }

  function setNeighborAnimation(rect: SVGRectElement, normalColor: string | null): void {
    const existing = rect.querySelector<SVGAnimateElement>('animate[data-role="neighbor"]')
    if (normalColor !== null) {
      const values = `${normalColor};${SELECTED_STROKE};${normalColor}`
      if (existing) {
        existing.setAttribute('values', values)
      } else {
        const anim = svgEl('animate')
        anim.dataset.role = 'neighbor'
        anim.setAttribute('attributeName', 'stroke')
        anim.setAttribute('values', values)
        anim.setAttribute('dur', '1s')
        anim.setAttribute('repeatCount', 'indefinite')
        anim.setAttribute('calcMode', 'spline')
        anim.setAttribute('keyTimes', '0;0.5;1')
        anim.setAttribute('keySplines', '0.5 0 0.5 1;0.5 0 0.5 1')
        rect.appendChild(anim)
      }
    } else if (existing) {
      existing.remove()
    }
  }

  function refreshHighlights(): void {
    const neighborIds = new Set<string>()
    for (const selId of selectedNodes) {
      for (const edge of graph.edges) {
        if (edge.from === selId && !selectedNodes.has(edge.to)) neighborIds.add(edge.to)
        if (edge.to === selId && !selectedNodes.has(edge.from)) neighborIds.add(edge.from)
      }
    }

    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    for (const node of graph.nodes) {
      const g = viewport.querySelector<SVGGElement>(`[data-node-id="${node.id}"]`)
      if (!g) continue
      const rect = nodeRect(g)
      if (selectedNodes.has(node.id)) {
        setNeighborAnimation(rect, null)
        setPulse(rect, false)
        rect.setAttribute('stroke', SELECTED_STROKE)
        rect.setAttribute('stroke-width', String(SELECTED_NODE_STROKE_WIDTH))
      } else if (neighborIds.has(node.id)) {
        setPulse(rect, false)
        const normalColor = nodeBorderColor(node, graph.edges, nodeMap)
        rect.setAttribute('stroke', normalColor)
        rect.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))
        setNeighborAnimation(rect, normalColor)
      } else {
        setNeighborAnimation(rect, null)
        rect.setAttribute('stroke', nodeBorderColor(node, graph.edges, nodeMap))
        setPulse(rect, nodeIsReady(node, graph.edges, nodeMap))
        if (!nodeIsReady(node, graph.edges, nodeMap)) {
          rect.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))
        }
      }
    }

    const hasSelection = selectedNodes.size > 0
    for (const path of viewport.querySelectorAll<SVGPathElement>('[data-from]')) {
      const hl = hasSelection && (selectedNodes.has(path.dataset.from!) || selectedNodes.has(path.dataset.to!))
      // Default edges are colour-coded by the state of their origin node; a
      // selection-highlighted edge brightens to white to stand out.
      const fromStatus = nodeMap.get(path.dataset.from!)?.status ?? 'planned'
      path.setAttribute('stroke', hl ? '#e6edf3' : statusEdgeColor(fromStatus))
      path.setAttribute('marker-end', edgeMarkerUrl(fromStatus, hl))
    }

    if (authenticated) updateIconClusters()
    alignPanel.style.display = (authenticated && selectedNodes.size >= 2) ? 'flex' : 'none'
  }

  function selectNode(id: string): void {
    selectedNodes.add(id)
    refreshHighlights()
  }

  function clearSelection(): void {
    selectedNodes.clear()
    refreshHighlights()
  }

  // ── Edge helpers ───────────────────────────────────────────────────────────

  function getNodePos(id: string): { x: number; y: number; hh: number } {
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
    return { x: Number(g.dataset.cx), y: Number(g.dataset.cy), hh: Number(g.dataset.hh) || NODE_HH }
  }

  // Nodes an elbow edge should try to route around — every node except the two
  // it connects. Live positions are read from the DOM so this stays correct
  // mid-drag.
  function obstaclesFor(fromId: string, toId: string): Node[] {
    return graph.nodes.filter(n => n.id !== fromId && n.id !== toId).map(n => {
      const g = viewport.querySelector<SVGGElement>(`[data-node-id="${n.id}"]`)
      return g ? { ...n, x: Number(g.dataset.cx), y: Number(g.dataset.cy) } : n
    })
  }

  function refreshEdgePath(path: SVGPathElement): void {
    const fromId = path.dataset.from!
    const toId = path.dataset.to!
    const from = getNodePos(fromId)
    const to = getNodePos(toId)
    const edgeId = path.dataset.edgeId
    const routing = (edgeId ? graph.edges.find(e => e.id === edgeId)?.routing : undefined) ?? 'straight'
    const geo = computeEdgeGeometry(from, to, routing, obstaclesFor(fromId, toId))
    path.setAttribute('d', displayPathFromSegments(geo.segments))
    path.dataset.midX = String(geo.midX)
    path.dataset.midY = String(geo.midY)
  }

  function updateEdgesForNode(nodeId: string): void {
    for (const path of viewport.querySelectorAll<SVGPathElement>('[data-from]')) {
      if (path.dataset.from === nodeId || path.dataset.to === nodeId) {
        refreshEdgePath(path)
      }
    }
  }

  // ── Internal graph/DOM mutations ───────────────────────────────────────────

  function internalAddNode(node: Node, persist = true): void {
    if (graph.nodes.some(n => n.id === node.id)) return
    graph.nodes.push(node)
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    viewport.appendChild(
      makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap)),
    )
    if (persist) api.upsertNode(node).catch(console.error)
    rebuildAllVanish()
  }

  function internalRemoveNode(id: string, persist = true): void {
    const idx = graph.nodes.findIndex(n => n.id === id)
    if (idx >= 0) graph.nodes.splice(idx, 1)
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id)
    viewport.querySelector(`[data-node-id="${id}"]`)?.remove()
    viewport.querySelectorAll<SVGPathElement>(`[data-from="${id}"],[data-to="${id}"]`).forEach(p => {
      const eid = p.dataset.edgeId
      const defs = getDefs()
      if (eid && defs) cleanupVanishDefs(eid, defs)
      p.remove()
    })
    if (persist) api.deleteNode(id).catch(console.error)
    rebuildAllVanish()
  }

  function internalAddEdge(edge: Edge, persist = true): void {
    if (graph.edges.some(e => e.id === edge.id)) return
    const fromEl = viewport.querySelector(`[data-node-id="${edge.from}"]`)
    const toEl = viewport.querySelector(`[data-node-id="${edge.to}"]`)
    if (!fromEl || !toEl) return
    graph.edges.push(edge)
    const path = makeEdgePath(getNodePos(edge.from), getNodePos(edge.to), edge.from, edge.to, edge, obstaclesFor(edge.from, edge.to), graph.nodes.find(n => n.id === edge.from)?.status)
    viewport.insertBefore(path, viewport.querySelector<SVGGElement>('[data-node-id]'))
    if (persist) api.upsertEdge(edge).catch(console.error)
    rebuildAllVanish()
  }

  function internalRemoveEdge(edgeId: string, persist = true): void {
    const idx = graph.edges.findIndex(e => e.id === edgeId)
    if (idx < 0) return
    const [edge] = graph.edges.splice(idx, 1)
    const defs = getDefs()
    if (defs) cleanupVanishDefs(edge.id, defs)
    viewport.querySelector(`[data-from="${edge.from}"][data-to="${edge.to}"]`)?.remove()
    if (persist) api.deleteEdge(edge.id).catch(console.error)
    rebuildAllVanish()
  }

  function internalMoveNode(id: string, pos: { x: number; y: number }, persist = true): void {
    const node = graph.nodes.find(n => n.id === id)
    if (!node) return
    node.x = pos.x
    node.y = pos.y
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
    if (g) {
      const hh = Number(g.dataset.hh) || NODE_HH
      g.dataset.cx = String(pos.x)
      g.dataset.cy = String(pos.y)
      g.setAttribute('transform', `translate(${pos.x - 60},${pos.y - hh})`)
      updateEdgesForNode(id)
    }
    if (persist) api.upsertNode(node).catch(console.error)
  }

  // Rebuild a node's <g> in place so its height/wrapping reflects the current
  // label, then refresh the edges that touch it. Selection styling is restored
  // by the caller's refreshHighlights().
  function rerenderNode(id: string): void {
    const old = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
    const node = graph.nodes.find(n => n.id === id)
    if (!old || !node) return
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    const fresh = makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap))
    old.replaceWith(fresh)
    updateEdgesForNode(id)
    rebuildAllVanish()
  }

  function internalUpdateNode(
    id: string,
    patch: Partial<Pick<Node, 'label' | 'status' | 'description' | 'nodeClass'>>,
    persist = true,
  ): void {
    const node = graph.nodes.find(n => n.id === id)
    if (!node) return
    Object.assign(node, patch)
    if (patch.label !== undefined) {
      rerenderNode(id)
      refreshHighlights()
    }
    if (patch.status !== undefined) refreshHighlights()
    if ('nodeClass' in patch) {
      const rectEl = viewport.querySelector<SVGRectElement>(`[data-node-id="${id}"] rect`)
      if (rectEl) rectEl.setAttribute('fill', nodeClassFill(node.nodeClass))
    }
    if (persist) api.upsertNode(node).catch(console.error)
  }

  // ── Edge toggle ────────────────────────────────────────────────────────────

  function toggleEdge(fromId: string, toId: string): void {
    const existingIdx = graph.edges.findIndex(e => e.from === fromId && e.to === toId)
    if (existingIdx >= 0) {
      const [removed] = graph.edges.splice(existingIdx, 1)
      const defs = getDefs()
      if (defs) cleanupVanishDefs(removed.id, defs)
      viewport.querySelector(`[data-from="${fromId}"][data-to="${toId}"]`)?.remove()
      api.deleteEdge(removed.id).catch(console.error)
      record({ type: 'delete-edge', edge: { ...removed } })
    } else {
      const edge: Edge = { id: `${fromId}-${toId}`, from: fromId, to: toId, routing: 'straight', style: 'solid', vanish: false }
      graph.edges.push(edge)
      const path = makeEdgePath(getNodePos(fromId), getNodePos(toId), fromId, toId, edge, [], graph.nodes.find(n => n.id === fromId)?.status)
      viewport.insertBefore(path, viewport.querySelector<SVGGElement>('[data-node-id]'))
      api.upsertEdge(edge).catch(console.error)
      record({ type: 'create-edge', edge: { ...edge } })
    }
    rebuildAllVanish()
    refreshHighlights()
  }

  // ── Panel helpers ──────────────────────────────────────────────────────────

  function handleDeleteNode(id: string): void {
    const node = graph.nodes.find(n => n.id === id)
    if (!node) return
    const edges = graph.edges.filter(e => e.from === id || e.to === id)
    record({ type: 'delete-node', node: { ...node }, edges: edges.map(e => ({ ...e })) })
    setFocusedNode(null)
    hidePanel()
    internalRemoveNode(id)
    clearSelection()
    refreshHighlights()
  }

  function openPanel(node: Node, autoFocusName = false): void {
    const id = node.id
    setFocusedNode(id)
    closeEdgeDialog()
    const isReadonly = !authenticated
    showPanel(
      node,
      isReadonly ? () => {} : (updated) => {
        if (updated.label !== undefined)
          record({ type: 'rename-node', id, from: node.label, to: updated.label })
        if (updated.status !== undefined)
          record({ type: 'status-node', id, from: node.status, to: updated.status })
        if (updated.description !== undefined)
          record({ type: 'description-node', id, from: node.description, to: updated.description })
        if ('nodeClass' in updated)
          record({ type: 'class-node', id, from: node.nodeClass, to: updated.nodeClass })
        Object.assign(node, updated)
        if (updated.label !== undefined) {
          rerenderNode(id)
          refreshHighlights()
        }
        if (updated.status !== undefined) refreshHighlights()
        if ('nodeClass' in updated) {
          const rectEl = viewport.querySelector<SVGRectElement>(`[data-node-id="${id}"] rect`)
          if (rectEl) rectEl.setAttribute('fill', nodeClassFill(node.nodeClass))
        }
        api.upsertNode(node).catch(console.error)
      },
      () => { setFocusedNode(null); clearSelection() },
      isReadonly ? undefined : () => handleDeleteNode(id),
      isReadonly ? false : autoFocusName,
      isReadonly,
    )
  }

  // ── Add-node mode ─────────────────────────────────────────────────────────

  let addMode = false
  let addModeDocListener: ((e: MouseEvent) => void) | null = null

  const addBtn = document.createElement('button')
  addBtn.textContent = 'Create node'
  addBtn.style.cssText =
    'position:fixed;bottom:1rem;left:1rem;height:1.875rem;padding:0 .75rem;' +
    'background:#0d1117;border:1px solid #30363d;' +
    'color:#8b949e;font-size:.8rem;font-family:system-ui;letter-spacing:.02em;' +
    'cursor:pointer;display:none;align-items:center;justify-content:center;'
  document.body.appendChild(addBtn)

  function setAddMode(active: boolean): void {
    addMode = active
    addBtn.style.background = active ? '#e6edf3' : '#0d1117'
    addBtn.style.color = active ? '#0d1117' : '#8b949e'
    addBtn.style.borderColor = active ? '#e6edf3' : '#30363d'
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

  // ── Alignment panel ───────────────────────────────────────────────────────

  const alignPanel = document.createElement('div')
  alignPanel.style.cssText =
    'position:fixed;bottom:3.5rem;left:1rem;display:none;flex-direction:column;gap:.375rem;z-index:100;'
  document.body.appendChild(alignPanel)

  const alignBtnBase =
    'height:1.875rem;padding:0 .75rem;' +
    'background:#0d1117;border:1px solid #30363d;' +
    'color:#8b949e;font-size:.8rem;font-family:system-ui;letter-spacing:.02em;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;' +
    'transition:background .15s,color .15s,border-color .15s;'

  function makeAlignBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.style.cssText = alignBtnBase
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#e6edf3'
      btn.style.color = '#0d1117'
      btn.style.borderColor = '#e6edf3'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#0d1117'
      btn.style.color = '#8b949e'
      btn.style.borderColor = '#30363d'
    })
    btn.addEventListener('click', onClick)
    return btn
  }

  function performAlign(axis: 'x' | 'y'): void {
    if (selectedNodes.size < 2) return
    const ids = [...selectedNodes]
    const nodes = ids.map(id => graph.nodes.find(n => n.id === id)).filter((n): n is Node => !!n)
    const sorted = nodes.map(n => n[axis]).sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = Math.round(
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    )
    const moves = nodes.map(n => ({
      id: n.id,
      from: { x: n.x, y: n.y },
      to: { x: axis === 'x' ? median : n.x, y: axis === 'y' ? median : n.y },
    }))
    for (const m of moves) internalMoveNode(m.id, m.to)
    record({ type: 'move-nodes', moves })
    rebuildAllVanish()
  }

  // Distribute the selected nodes so their spacing along `axis` is perfectly
  // even. Nodes are ordered by their position on that axis and the two extremes
  // are pinned, so only the in-between nodes shift. The off-axis coordinate of
  // each node is left untouched.
  function performDistribute(axis: 'x' | 'y'): void {
    if (selectedNodes.size < 3) return
    const ids = [...selectedNodes]
    const nodes = ids.map(id => graph.nodes.find(n => n.id === id)).filter((n): n is Node => !!n)
    if (nodes.length < 3) return
    const sorted = [...nodes].sort((a, b) => a[axis] - b[axis])
    const min = sorted[0][axis]
    const max = sorted[sorted.length - 1][axis]
    const step = (max - min) / (sorted.length - 1)
    const moves = sorted.flatMap((n, i) => {
      const target = Math.round(min + step * i)
      const to = { x: axis === 'x' ? target : n.x, y: axis === 'y' ? target : n.y }
      if (to.x === n.x && to.y === n.y) return []
      return [{ id: n.id, from: { x: n.x, y: n.y }, to }]
    })
    if (moves.length === 0) return
    for (const m of moves) internalMoveNode(m.id, m.to)
    record({ type: 'move-nodes', moves })
    rebuildAllVanish()
  }

  alignPanel.appendChild(makeAlignBtn('Align along horizontal axis', () => performAlign('y')))
  alignPanel.appendChild(makeAlignBtn('Align along vertical axis', () => performAlign('x')))
  alignPanel.appendChild(makeAlignBtn('Horizontal even spacing', () => performDistribute('x')))
  alignPanel.appendChild(makeAlignBtn('Vertical even spacing', () => performDistribute('y')))

  let pendingAddPos: { x: number; y: number } | null = null
  let pendingAddClientStart = { x: 0, y: 0 }
  let pendingCtrlAddPos: { x: number; y: number } | null = null
  let pendingCtrlAddClientStart = { x: 0, y: 0 }

  function createNodeAt(vp: { x: number; y: number }, shiftHeld: boolean, fromId?: string): void {
    const node: Node = {
      id: crypto.randomUUID(),
      label: 'Unnamed',
      x: Math.round(vp.x),
      y: Math.round(vp.y),
      status: 'planned',
    }
    internalAddNode(node)
    record({ type: 'create-node', node: { ...node } })

    if (fromId) {
      const edge: Edge = { id: `${fromId}-${node.id}`, from: fromId, to: node.id, routing: 'straight', style: 'solid', vanish: false }
      internalAddEdge(edge)
      record({ type: 'create-edge', edge: { ...edge } })
      refreshHighlights()
    }

    if (!shiftHeld) {
      setAddMode(false)
      clearSelection()
      selectNode(node.id)
      openPanel(node, true)
    }
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

  function applyEntry(entry: HistoryEntry, dir: 'undo' | 'redo'): void {
    setFocusedNode(null)
    hidePanel()
    clearSelection()
    switch (entry.type) {
      case 'create-node':
        if (dir === 'undo') internalRemoveNode(entry.node.id)
        else internalAddNode({ ...entry.node })
        break
      case 'delete-node':
        if (dir === 'undo') {
          internalAddNode({ ...entry.node })
          for (const e of entry.edges) internalAddEdge({ ...e })
        } else {
          internalRemoveNode(entry.node.id)
        }
        break
      case 'move-nodes':
        for (const m of entry.moves) internalMoveNode(m.id, dir === 'undo' ? m.from : m.to)
        rebuildAllVanish()
        break
      case 'rename-node':
        internalUpdateNode(entry.id, { label: dir === 'undo' ? entry.from : entry.to })
        break
      case 'status-node':
        internalUpdateNode(entry.id, { status: dir === 'undo' ? entry.from : entry.to })
        break
      case 'description-node':
        internalUpdateNode(entry.id, { description: dir === 'undo' ? entry.from : entry.to })
        break
      case 'class-node':
        internalUpdateNode(entry.id, { nodeClass: dir === 'undo' ? entry.from : entry.to })
        break
      case 'create-edge':
        if (dir === 'undo') internalRemoveEdge(entry.edge.id)
        else internalAddEdge({ ...entry.edge })
        break
      case 'delete-edge':
        if (dir === 'undo') internalAddEdge({ ...entry.edge })
        else internalRemoveEdge(entry.edge.id)
        break
      case 'settings-edge': {
        const edge = graph.edges.find(e => e.id === entry.id)
        if (edge) setEdgeSettings(edge, dir === 'undo' ? entry.from : entry.to)
        break
      }
    }
    refreshHighlights()
  }

  function performUndo(): void {
    if (!authenticated) return
    const entry = popUndo()
    if (!entry) return
    applyEntry(entry, 'undo')
    pushRedo(entry)
  }

  function performRedo(): void {
    if (!authenticated) return
    const entry = popRedo()
    if (!entry) return
    applyEntry(entry, 'redo')
    pushUndo(entry)
  }

  // ── Remote refresh ─────────────────────────────────────────────────────────

  // Apply a diff pulled from the server (concurrent edits by other users) to the
  // local model and DOM, without persisting it back. Returns false if the apply
  // was deferred because the user is mid-interaction — the caller should retry on
  // its next poll without advancing its known revision.
  //
  // Deletions are applied before upserts: when an id is deleted and recreated
  // within one window, the recreated row is the newest server state, so removing
  // first then re-adding it yields the correct result. Selection/pan/zoom and any
  // unsaved panel edits are left untouched.
  function applyRemoteChanges(changes: GraphChanges): boolean {
    if (activeNode) return false
    if (changes.nodes.length === 0 && changes.edges.length === 0 && changes.deletions.length === 0) return true

    for (const d of changes.deletions) {
      if (d.entityType === 'node') internalRemoveNode(d.entityId, false)
      else internalRemoveEdge(d.entityId, false)
      selectedNodes.delete(d.entityId)
      if (_focusedNodeId === d.entityId) { setFocusedNode(null); hidePanel() }
    }

    for (const node of changes.nodes) {
      const existing = graph.nodes.find(n => n.id === node.id)
      if (!existing) { internalAddNode(node, false); continue }
      if (existing.x !== node.x || existing.y !== node.y) {
        internalMoveNode(node.id, { x: node.x, y: node.y }, false)
      }
      const patch: Partial<Pick<Node, 'label' | 'status' | 'description' | 'nodeClass'>> = {}
      if (existing.label !== node.label) patch.label = node.label
      if (existing.status !== node.status) patch.status = node.status
      if (existing.description !== node.description) patch.description = node.description
      if (existing.nodeClass !== node.nodeClass) patch.nodeClass = node.nodeClass
      if (Object.keys(patch).length > 0) internalUpdateNode(node.id, patch, false)
    }

    for (const edge of changes.edges) {
      const existing = graph.edges.find(e => e.id === edge.id)
      if (!existing) { internalAddEdge(edge, false); continue }
      const patch: EdgeSettingsPatch = {}
      if (existing.routing !== edge.routing) patch.routing = edge.routing
      if (existing.style !== edge.style) patch.style = edge.style
      if (existing.vanish !== edge.vanish) patch.vanish = edge.vanish
      if (Object.keys(patch).length > 0) setEdgeSettings(existing, patch, false)
    }

    refreshHighlights()
    return true
  }

  // ── Public controls ───────────────────────────────────────────────────────

  function setAuthenticated(auth: boolean): void {
    authenticated = auth
    addBtn.style.display = auth ? 'flex' : 'none'
    if (!auth) {
      setAddMode(false)
      clearHistory()
      setFocusedNode(null)
      clearIconClusters()
      closeEdgeDialog()
      alignPanel.style.display = 'none'
    }
    hidePanel()
  }

  function centerOnNode(id: string): void {
    const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
    if (!g) return
    const nodeCx = Number(g.dataset.cx)
    const nodeCy = Number(g.dataset.cy)
    const svgRect = svg.getBoundingClientRect()
    const targetScale = Math.max(1.0, Math.min(2.0, state.scale))
    const targetTx = svgRect.width / 2 - nodeCx * targetScale
    const targetTy = svgRect.height / 2 - nodeCy * targetScale

    const startTx = state.tx, startTy = state.ty, startScale = state.scale
    const animStart = performance.now()

    function step(now: number): void {
      const t = Math.min((now - animStart) / 400, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      state.tx = startTx + (targetTx - startTx) * ease
      state.ty = startTy + (targetTy - startTy) * ease
      state.scale = startScale + (targetScale - startScale) * ease
      applyTransform()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)

    const rectEl = nodeRect(g)
    rectEl.setAttribute('stroke', '#388bfd')
    rectEl.setAttribute('stroke-width', '2.5')
    setTimeout(() => {
      rectEl.setAttribute('stroke-width', String(NODE_STROKE_WIDTH))
      refreshHighlights()
    }, 700)
  }

  // ── Pan ────────────────────────────────────────────────────────────────────
  let panning = false
  let panStart = { x: 0, y: 0 }
  let panOrigin = { tx: 0, ty: 0 }

  // ── Node drag ──────────────────────────────────────────────────────────────
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
      if (authenticated && selectedNodes.size > 1 && selectedNodes.has(nodeId)) {
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
    } else if (authenticated && me.ctrlKey && selectedNodes.size === 1) {
      pendingCtrlAddPos = clientToViewport(me.clientX, me.clientY)
      pendingCtrlAddClientStart = { x: me.clientX, y: me.clientY }
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
      setFocusedNode(null)
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
        if (!authenticated) return
        hasDragged = true
        activeNode.style.cursor = 'grabbing'
      }
      if (hasDragged) {
        if (isMultiDrag) {
          for (const [id, origin] of multiDragOrigins) {
            const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
            const hh = Number(g.dataset.hh) || NODE_HH
            const cx = origin.cx + dx / state.scale
            const cy = origin.cy + dy / state.scale
            g.dataset.cx = String(cx)
            g.dataset.cy = String(cy)
            g.setAttribute('transform', `translate(${cx - 60},${cy - hh})`)
            updateEdgesForNode(id)
          }
        } else {
          const hh = Number(activeNode.dataset.hh) || NODE_HH
          const cx = singleDragOrigin.cx + dx / state.scale
          const cy = singleDragOrigin.cy + dy / state.scale
          activeNode.dataset.cx = String(cx)
          activeNode.dataset.cy = String(cy)
          activeNode.setAttribute('transform', `translate(${cx - 60},${cy - hh})`)
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
        const moved = isMultiDrag ? [...multiDragOrigins.keys()] : [activeNode.dataset.nodeId!]
        const moveRecords: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }> = []
        for (const id of moved) {
          const g = viewport.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!
          const node = graph.nodes.find(n => n.id === id)
          if (node) {
            const origin = isMultiDrag ? multiDragOrigins.get(id)! : singleDragOrigin
            moveRecords.push({ id, from: { x: origin.cx, y: origin.cy }, to: { x: Number(g.dataset.cx), y: Number(g.dataset.cy) } })
            node.x = Number(g.dataset.cx)
            node.y = Number(g.dataset.cy)
            api.upsertNode(node).catch(console.error)
          }
        }
        if (moveRecords.length > 0) record({ type: 'move-nodes', moves: moveRecords })
        // Rebuild vanish masks now that node positions have settled
        rebuildAllVanish()
      } else {
        const nodeId = activeNode.dataset.nodeId!
        if (authenticated && e.ctrlKey) {
          if (selectedNodes.size === 1 && !selectedNodes.has(nodeId)) {
            toggleEdge([...selectedNodes][0], nodeId)
          }
        } else if (e.shiftKey) {
          if (selectedNodes.has(nodeId)) selectedNodes.delete(nodeId)
          else selectedNodes.add(nodeId)
          refreshHighlights()
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

    if (pendingCtrlAddPos) {
      const dx = e.clientX - pendingCtrlAddClientStart.x
      const dy = e.clientY - pendingCtrlAddClientStart.y
      if (Math.sqrt(dx * dx + dy * dy) <= DRAG_THRESHOLD) {
        createNodeAt(pendingCtrlAddPos, false, [...selectedNodes][0])
      }
      pendingCtrlAddPos = null
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
        selectedNodes.clear()
        for (const g of viewport.querySelectorAll<SVGGElement>('[data-node-id]')) {
          const cx = Number(g.dataset.cx)
          const cy = Number(g.dataset.cy)
          if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
            selectedNodes.add(g.dataset.nodeId!)
          }
        }
        refreshHighlights()
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

  // Initial fit: position camera so the whole graph fits within the viewport
  if (graph.nodes.length > 0) {
    requestAnimationFrame(() => {
      const svgRect = svg.getBoundingClientRect()
      // Bounding box of all nodes (120 wide, centered on x/y; height varies with label wrap)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of graph.nodes) {
        const hh = nodeHalfHeight(n.label)
        minX = Math.min(minX, n.x - 60)
        minY = Math.min(minY, n.y - hh)
        maxX = Math.max(maxX, n.x + 60)
        maxY = Math.max(maxY, n.y + hh)
      }
      const graphW = maxX - minX
      const graphH = maxY - minY
      const padding = 80
      const availW = Math.max(1, svgRect.width - padding * 2)
      const availH = Math.max(1, svgRect.height - padding * 2)
      // Scale to fit, but never zoom in past 1:1
      const fitScale = Math.min(availW / graphW, availH / graphH, 1)
      state.scale = Math.max(0.1, fitScale)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      state.tx = svgRect.width / 2 - cx * state.scale
      state.ty = svgRect.height / 2 - cy * state.scale
      applyTransform()
      rebuildAllVanish()
    })
  }

  return { setAuthenticated, centerOnNode, undo: performUndo, redo: performRedo, applyRemoteChanges }
}
