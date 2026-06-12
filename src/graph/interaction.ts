import type { Graph, GraphAPI, GraphChanges, Node, Edge, EdgeRouting, EdgeStyle, MidAxis, Grouping } from '../types'
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
  darkenColor,
  DEFAULT_GROUP_COLOR,
  NODE_HW,
  NODE_STROKE_WIDTH,
  SELECTED_NODE_STROKE_WIDTH,
  buildVanishMask,
  cleanupVanishDefs,
  segPathLength,
  type Seg,
} from './utils'
import { computeEdgeGeometry, edgeMidOverride } from './layout/route'
import { computeGroupLoops, loopsToPath, pointInLoops, type GroupRect, type Pt } from './grouping'
import { SpatialGrid } from './layout/grid'
import { LayoutScheduler } from './layout/scheduler'
import type { LayoutInput, LayoutResult, NodeSnap } from './layout/types'
import { showPanel, hidePanel } from '../ui/panel'
import { showGroupPanel, hideGroupPanel, isGroupPanelOpen } from '../ui/group-panel'
import { record, popUndo, pushRedo, popRedo, pushUndo, clearHistory } from '../history/stack'
import { openEdgeDialog, closeEdgeDialog, isEdgeDialogOpen } from '../ui/edge-dialog'
import type { HistoryEntry, EdgeSettingsPatch } from '../history/stack'

const DRAG_THRESHOLD = 4
const SELECTED_STROKE = '#58a6ff'
// Min interval between mid-drag layout requests. The work is async and results
// are superseded anyway; this just avoids flooding the worker with snapshots.
const DRAG_LAYOUT_INTERVAL_MS = 120

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

  // ── Model-backed indexes ───────────────────────────────────────────────────
  // The interaction hot paths (drag frames, layout application) never query
  // the DOM — elements, positions and adjacency are tracked in maps that are
  // maintained alongside every mutation.

  const nodeElById = new Map<string, SVGGElement>()
  const pathById = new Map<string, SVGPathElement>()
  const edgeById = new Map<string, Edge>()
  const edgesByNode = new Map<string, Set<string>>()
  const livePos = new Map<string, { x: number; y: number; hh: number }>()

  function indexEdge(edge: Edge): void {
    edgeById.set(edge.id, edge)
    for (const id of [edge.from, edge.to]) {
      const set = edgesByNode.get(id)
      if (set) set.add(edge.id)
      else edgesByNode.set(id, new Set([edge.id]))
    }
  }

  function unindexEdge(edge: Edge): void {
    edgeById.delete(edge.id)
    edgesByNode.get(edge.from)?.delete(edge.id)
    edgesByNode.get(edge.to)?.delete(edge.id)
  }

  for (const g of viewport.querySelectorAll<SVGGElement>('[data-node-id]')) {
    nodeElById.set(g.dataset.nodeId!, g)
  }
  for (const p of viewport.querySelectorAll<SVGPathElement>('[data-from]')) {
    pathById.set(p.dataset.edgeId!, p)
  }
  for (const n of graph.nodes) {
    livePos.set(n.id, { x: n.x, y: n.y, hh: nodeHalfHeight(n.label) })
  }
  for (const e of graph.edges) indexEdge(e)

  // ── Grouping indexes ────────────────────────────────────────────────────────
  // Groupings render as a layer behind edges and nodes; their outline is
  // recomputed from live node positions whenever a member (or any nearby node)
  // moves. groupsByNode lets a node move touch only the groups it can affect.
  const groupingById = new Map<string, Grouping>()
  const groupPathById = new Map<string, SVGPathElement>()
  const groupNameById = new Map<string, SVGTextElement>()
  const groupLoopsById = new Map<string, Pt[][]>()
  const groupsByNode = new Map<string, Set<string>>()

  const groupLayer = svgEl('g')
  groupLayer.dataset.role = 'group-layer'
  viewport.insertBefore(groupLayer, viewport.firstChild)

  function indexGrouping(g: Grouping): void {
    groupingById.set(g.id, g)
    for (const nodeId of g.members) {
      const set = groupsByNode.get(nodeId)
      if (set) set.add(g.id)
      else groupsByNode.set(nodeId, new Set([g.id]))
    }
  }

  function unindexGrouping(g: Grouping): void {
    groupingById.delete(g.id)
    for (const nodeId of g.members) groupsByNode.get(nodeId)?.delete(g.id)
  }

  for (const g of graph.groupings ?? []) {
    indexGrouping(g)
    renderGrouping(g)
  }

  function getNodePos(id: string): { x: number; y: number; hh: number } {
    const p = livePos.get(id)
    if (p) return p
    const node = graph.nodes.find(n => n.id === id)!
    const fresh = { x: node.x, y: node.y, hh: nodeHalfHeight(node.label) }
    livePos.set(id, fresh)
    return fresh
  }

  // Obstacle index for elbow routing, rebuilt lazily after any position change.
  let obstacleGrid: SpatialGrid | null = null
  function invalidateGrid(): void {
    obstacleGrid = null
  }
  function getGrid(): SpatialGrid {
    if (!obstacleGrid) {
      const snaps: NodeSnap[] = []
      for (const [id, p] of livePos) snaps.push({ id, x: p.x, y: p.y, hh: p.hh })
      obstacleGrid = new SpatialGrid(snaps)
    }
    return obstacleGrid
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

  // ── Async layout ───────────────────────────────────────────────────────────
  // All stacking runs in the layout worker. Every model change requests a
  // fresh pass with the current snapshot; the scheduler discards superseded
  // results, so what lands here always reflects the latest known model state.

  function getDefs(): SVGDefsElement | null {
    return svg.querySelector<SVGDefsElement>('defs')
  }

  let lastLayout: LayoutResult | null = null
  let vanishTimer: number | null = null

  function layoutInput(): LayoutInput {
    const nodes: NodeSnap[] = []
    for (const [id, p] of livePos) nodes.push({ id, x: p.x, y: p.y, hh: p.hh })
    return {
      nodes,
      edges: graph.edges.map(e => ({
        id: e.id,
        from: e.from,
        to: e.to,
        routing: e.routing,
        midAxis: e.midAxis ?? null,
        midPos: e.midPos ?? null,
      })),
    }
  }

  function requestLayout(): void {
    scheduler.request(layoutInput())
  }

  function draggedNodeIdSet(): Set<string> {
    const ids = new Set<string>()
    if (activeNode && hasDragged) {
      if (isMultiDrag) for (const id of multiDragOrigins.keys()) ids.add(id)
      else ids.add(activeNode.dataset.nodeId!)
    }
    return ids
  }

  function applyLayout(result: LayoutResult): void {
    lastLayout = result
    // Mid-drag results still land (neighbouring stacks adjust locally), but
    // edges attached to the dragged node — and a mid-segment being dragged —
    // are owned by the per-frame local pass, which has newer positions.
    const dragged = draggedNodeIdSet()
    const draggedEdgeId = midDrag?.moved ? midDrag.edge.id : null
    for (const edge of graph.edges) {
      const geo = result.edges[edge.id]
      if (!geo) continue
      if (edge.id === draggedEdgeId || dragged.has(edge.from) || dragged.has(edge.to)) continue
      const path = pathById.get(edge.id)
      if (!path) continue
      const d = displayPathFromSegments(geo.segments)
      if (path.getAttribute('d') !== d) path.setAttribute('d', d)
      path.dataset.midX = String(geo.midX)
      path.dataset.midY = String(geo.midY)
    }
    // Stacking moves edge midpoints, which the icon clusters ride on.
    if (!activeNode && !midDrag) updateIconClusters()
    scheduleVanish()
  }

  const scheduler = new LayoutScheduler(applyLayout)

  function scheduleVanish(): void {
    if (vanishTimer !== null) window.clearTimeout(vanishTimer)
    vanishTimer = window.setTimeout(() => {
      vanishTimer = null
      rebuildVanishMasks()
    }, 0)
  }

  // Rebuild vanish masks from the latest layout. Deferred and skipped while a
  // drag is live — masks are DOM-heavy and the crossings are still changing.
  function rebuildVanishMasks(): void {
    if (activeNode || midDrag) return
    const defs = getDefs()
    if (!defs || !lastLayout) return

    const segMap = new Map<string, Seg[]>()
    for (const edge of graph.edges) {
      const geo = lastLayout.edges[edge.id]
      if (geo) segMap.set(edge.id, geo.segments)
    }

    const allEntries = [...segMap.entries()].map(([id, segs]) => ({
      id,
      segs,
      vanish: edgeById.get(id)?.vanish ?? false,
      length: segPathLength(segs),
    }))

    for (const edge of graph.edges) {
      const path = pathById.get(edge.id)
      if (!edge.vanish) {
        // Remove any stale mask
        cleanupVanishDefs(edge.id, defs)
        path?.removeAttribute('mask')
        continue
      }

      const mySegs = segMap.get(edge.id)
      if (!mySegs || !path) continue

      cleanupVanishDefs(edge.id, defs)

      const myLength = segPathLength(mySegs)
      const otherEdges = allEntries.filter(e => e.id !== edge.id)
      const mask = buildVanishMask(edge.id, mySegs, myLength, edge.from, edge.to, getGrid(), otherEdges, defs)
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

  // Open hand (the standard "grab" cursor): four rounded fingers over a palm.
  function makeGrabHandIcon(): SVGElement {
    const g = svgEl('g')
    const fingers: Array<[cx: number, top: number]> = [[-3.6, -5.2], [-1.2, -6.2], [1.2, -5.8], [3.6, -4.4]]
    for (const [cx, top] of fingers) {
      const f = svgEl('rect')
      f.setAttribute('x', String(cx - 1.1))
      f.setAttribute('y', String(top))
      f.setAttribute('width', '2.2')
      f.setAttribute('height', String(2 - top))
      f.setAttribute('rx', '1.1')
      g.appendChild(f)
    }
    const palm = svgEl('rect')
    palm.setAttribute('x', '-4.7')
    palm.setAttribute('y', '-1.5')
    palm.setAttribute('width', '9.4')
    palm.setAttribute('height', '7.5')
    palm.setAttribute('rx', '3')
    g.appendChild(palm)
    return g
  }

  // ── Elbow2 middle-segment drag ─────────────────────────────────────────────
  // Dragging the grab handle pins the elbow's middle segment at a manual
  // position along its orthogonal axis (edge.midAxis / edge.midPos). The
  // override persists until the user double-clicks the handle or either
  // endpoint node moves.
  let midDrag: {
    edge: Edge
    axis: MidAxis
    startPos: number
    startClient: { x: number; y: number }
    before: { midAxis: MidAxis | null; midPos: number | null }
    btn: SVGGElement
    moved: boolean
  } | null = null
  // A drag's mouseup still counts towards `dblclick`, so a drag followed by a
  // quick click would wrongly reset the override — ignore dblclicks that land
  // right after a real drag ended.
  let lastMidDragEnd = 0

  function startMidDrag(edge: Edge, btn: SVGGElement, e: MouseEvent): void {
    const geo = computeEdgeGeometry(getNodePos(edge.from), getNodePos(edge.to), edge.routing, getGrid(), edgeMidOverride(edge), edge.from, edge.to)
    if (geo.segments.length !== 3) return
    const mid = geo.segments[1]
    // A vertical middle segment moves along x; a horizontal one along y.
    const axis: MidAxis = Math.abs(mid.x2 - mid.x1) < 0.5 ? 'x' : 'y'
    midDrag = {
      edge,
      axis,
      startPos: axis === 'x' ? mid.x1 : mid.y1,
      startClient: { x: e.clientX, y: e.clientY },
      before: { midAxis: edge.midAxis ?? null, midPos: edge.midPos ?? null },
      btn,
      moved: false,
    }
  }

  function clearMidOverridesForNode(nodeId: string): void {
    for (const edge of graph.edges) {
      if (edge.from !== nodeId && edge.to !== nodeId) continue
      if (edge.midAxis == null && edge.midPos == null) continue
      // No persistence here: the worker clears these rows itself whenever the
      // node's new position is PATCHed, so a local reset keeps us in sync.
      edge.midAxis = null
      edge.midPos = null
    }
  }

  function svgIconBtn(
    icon: string | SVGElement,
    hoverColor: string,
    onClick: (e: MouseEvent) => void,
    opts: { r?: number; fontSize?: number; baseStroke?: string } = {},
  ): SVGGElement {
    const r = opts.r ?? 11
    const fontSize = opts.fontSize ?? 14
    const baseStroke = opts.baseStroke ?? '#30363d'

    const g = svgEl('g')
    g.style.cursor = 'pointer'
    g.style.color = '#c9d1d9'   // drives fill:currentColor on inner content

    const circle = svgEl('circle')
    circle.setAttribute('r', String(r))
    circle.setAttribute('fill', '#161b22')
    circle.setAttribute('stroke', baseStroke)
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
      circle.setAttribute('stroke', baseStroke)
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
    const path = pathById.get(edge.id)
    if (!path) return
    const geo = computeEdgeGeometry(getNodePos(edge.from), getNodePos(edge.to), edge.routing, getGrid(), edgeMidOverride(edge), edge.from, edge.to)
    path.setAttribute('d', displayPathFromSegments(geo.segments))
    path.dataset.midX = String(geo.midX)
    path.dataset.midY = String(geo.midY)
    path.setAttribute('stroke-dasharray', edge.style === 'dashed' ? '6 4' : '')
    if (persist) api.patchEdge(edge.id, patch).catch(console.error)
    requestLayout()
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

    type Item = {
      icon: string | SVGElement
      color: string
      fontSize?: number
      baseStroke?: string
      setup?: (btn: SVGGElement) => void
      fn: (e: MouseEvent) => void
    }
    const items: Item[] = []

    if (edge.routing === 'elbow2') {
      const overridden = edgeMidOverride(edge) !== null
      items.push({
        icon: makeGrabHandIcon(),
        color: '#58a6ff',
        // Blue ring = the middle segment is pinned off its automatic position.
        baseStroke: overridden ? SELECTED_STROKE : undefined,
        setup: (btn) => {
          btn.style.cursor = 'grab'
          btn.addEventListener('mousedown', (e) => {
            e.stopPropagation()
            startMidDrag(edge, btn, e)
          })
          btn.addEventListener('dblclick', (e) => {
            e.stopPropagation()
            if (Date.now() - lastMidDragEnd < 500) return
            if (edgeMidOverride(edge) === null) return
            applyEdgePatch(edge, { midAxis: null, midPos: null })
            updateIconClusters()
          })
        },
        fn: (e) => e.stopPropagation(),
      })
    }

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
    items.push({ icon: '⚙', color: '#f97316', fontSize: 20, fn: (e) => {
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

    // Arrange the buttons on a ring around the edge midpoint, starting at the
    // top. The radius grows with the count so neighbouring circles keep at
    // least ~30px between centres.
    const spacing = 30
    const n = items.length
    const ringR = n > 1 ? Math.max(18, spacing / (2 * Math.sin(Math.PI / n))) : 0
    for (let i = 0; i < n; i++) {
      const { icon, color, fontSize, baseStroke, setup, fn } = items[i]
      const btn = svgIconBtn(icon, color, fn, { fontSize, baseStroke })
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
      btn.setAttribute('transform', `translate(${ringR * Math.cos(angle)},${ringR * Math.sin(angle)})`)
      setup?.(btn)
      g.appendChild(btn)
    }

    return g
  }

  function updateIconClusters(): void {
    clearIconClusters()
    if (!authenticated || selectedNodes.size === 0) return
    if (isEdgeDialogOpen()) return

    for (const [edgeId, path] of pathById) {
      const fromId = path.dataset.from!
      const toId = path.dataset.to!
      if (!selectedNodes.has(fromId) && !selectedNodes.has(toId)) continue

      const edge = edgeById.get(edgeId)
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
      const g = nodeElById.get(node.id)
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
    for (const path of pathById.values()) {
      const hl = hasSelection && (selectedNodes.has(path.dataset.from!) || selectedNodes.has(path.dataset.to!))
      // Default edges are colour-coded by the state of their origin node; a
      // selection-highlighted edge brightens to white to stand out.
      const fromStatus = nodeMap.get(path.dataset.from!)?.status ?? 'planned'
      path.setAttribute('stroke', hl ? '#e6edf3' : statusEdgeColor(fromStatus))
      path.setAttribute('marker-end', edgeMarkerUrl(fromStatus, hl))
    }

    if (authenticated) updateIconClusters()
    alignPanel.style.display = (authenticated && selectedNodes.size >= 2) ? 'flex' : 'none'
    createGroupBtn.style.display = (authenticated && selectedNodes.size >= 1) ? 'flex' : 'none'
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

  // Tier-A local update: re-route a single edge from live positions. Used per
  // drag frame for the dragged node's edges only — the rest of the graph keeps
  // its last stacked geometry until the async pass lands.
  function refreshEdgePath(path: SVGPathElement): void {
    const fromId = path.dataset.from!
    const toId = path.dataset.to!
    const edge = path.dataset.edgeId ? edgeById.get(path.dataset.edgeId) : undefined
    const geo = computeEdgeGeometry(getNodePos(fromId), getNodePos(toId), edge?.routing ?? 'straight', getGrid(), edgeMidOverride(edge), fromId, toId)
    path.setAttribute('d', displayPathFromSegments(geo.segments))
    path.dataset.midX = String(geo.midX)
    path.dataset.midY = String(geo.midY)
  }

  function updateEdgesForNode(nodeId: string): void {
    const ids = edgesByNode.get(nodeId)
    if (!ids) return
    for (const id of ids) {
      const path = pathById.get(id)
      if (path) refreshEdgePath(path)
    }
  }

  // ── Internal graph/DOM mutations ───────────────────────────────────────────

  function internalAddNode(node: Node, persist = true): void {
    if (graph.nodes.some(n => n.id === node.id)) return
    graph.nodes.push(node)
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    const el = makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap))
    viewport.appendChild(el)
    nodeElById.set(node.id, el)
    livePos.set(node.id, { x: node.x, y: node.y, hh: nodeHalfHeight(node.label) })
    invalidateGrid()
    if (persist) api.upsertNode(node).catch(console.error)
    requestLayout()
    refreshAllGroups()
  }

  function internalRemoveNode(id: string, persist = true): void {
    const idx = graph.nodes.findIndex(n => n.id === id)
    if (idx >= 0) graph.nodes.splice(idx, 1)
    const removedEdges = graph.edges.filter(e => e.from === id || e.to === id)
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id)
    nodeElById.get(id)?.remove()
    nodeElById.delete(id)
    livePos.delete(id)
    invalidateGrid()
    const defs = getDefs()
    for (const e of removedEdges) {
      unindexEdge(e)
      if (defs) cleanupVanishDefs(e.id, defs)
      pathById.get(e.id)?.remove()
      pathById.delete(e.id)
    }
    edgesByNode.delete(id)
    if (persist) api.deleteNode(id).catch(console.error)
    requestLayout()
    refreshAllGroups()
  }

  function internalAddEdge(edge: Edge, persist = true): void {
    if (graph.edges.some(e => e.id === edge.id)) return
    if (!nodeElById.has(edge.from) || !nodeElById.has(edge.to)) return
    graph.edges.push(edge)
    indexEdge(edge)
    const path = makeEdgePath(getNodePos(edge.from), getNodePos(edge.to), edge.from, edge.to, edge, getGrid(), graph.nodes.find(n => n.id === edge.from)?.status)
    viewport.insertBefore(path, viewport.querySelector<SVGGElement>('[data-node-id]'))
    pathById.set(edge.id, path)
    if (persist) api.upsertEdge(edge).catch(console.error)
    requestLayout()
  }

  function internalRemoveEdge(edgeId: string, persist = true): void {
    const idx = graph.edges.findIndex(e => e.id === edgeId)
    if (idx < 0) return
    const [edge] = graph.edges.splice(idx, 1)
    unindexEdge(edge)
    const defs = getDefs()
    if (defs) cleanupVanishDefs(edge.id, defs)
    pathById.get(edge.id)?.remove()
    pathById.delete(edge.id)
    if (persist) api.deleteEdge(edge.id).catch(console.error)
    requestLayout()
  }

  function internalMoveNode(id: string, pos: { x: number; y: number }, persist = true): void {
    const node = graph.nodes.find(n => n.id === id)
    if (!node) return
    if (node.x !== pos.x || node.y !== pos.y) clearMidOverridesForNode(id)
    node.x = pos.x
    node.y = pos.y
    const p = getNodePos(id)
    p.x = pos.x
    p.y = pos.y
    invalidateGrid()
    const g = nodeElById.get(id)
    if (g) {
      g.dataset.cx = String(pos.x)
      g.dataset.cy = String(pos.y)
      g.setAttribute('transform', `translate(${pos.x - NODE_HW},${pos.y - p.hh})`)
      updateEdgesForNode(id)
      updateGroupsForNodes([id])
    }
    if (persist) api.upsertNode(node).catch(console.error)
  }

  // Rebuild a node's <g> in place so its height/wrapping reflects the current
  // label, then refresh the edges that touch it. Selection styling is restored
  // by the caller's refreshHighlights().
  function rerenderNode(id: string): void {
    const old = nodeElById.get(id)
    const node = graph.nodes.find(n => n.id === id)
    if (!old || !node) return
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
    const fresh = makeNodeEl(node, nodeBorderColor(node, graph.edges, nodeMap), nodeIsReady(node, graph.edges, nodeMap))
    old.replaceWith(fresh)
    nodeElById.set(id, fresh)
    const p = getNodePos(id)
    p.hh = nodeHalfHeight(node.label)
    invalidateGrid()
    updateEdgesForNode(id)
    updateGroupsForNodes([id])
    requestLayout()
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
      const rectEl = nodeElById.get(id)?.querySelector('rect')
      if (rectEl) rectEl.setAttribute('fill', nodeClassFill(node.nodeClass))
    }
    if (persist) api.upsertNode(node).catch(console.error)
  }

  // ── Groupings ───────────────────────────────────────────────────────────────

  function groupRects(grouping: Grouping): { members: GroupRect[]; nonMembers: GroupRect[] } {
    const memberSet = new Set(grouping.members)
    const members: GroupRect[] = []
    const nonMembers: GroupRect[] = []
    for (const [id, p] of livePos) {
      const rect = { x: p.x, y: p.y, hw: NODE_HW, hh: p.hh }
      if (memberSet.has(id)) members.push(rect)
      else nonMembers.push(rect)
    }
    return { members, nonMembers }
  }

  function styleGroupPath(path: SVGPathElement, color: string): void {
    path.setAttribute('fill', darkenColor(color))
    path.setAttribute('fill-opacity', '0.5')
    path.setAttribute('fill-rule', 'evenodd')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', '3')
    path.setAttribute('stroke-dasharray', '10 7')
    path.setAttribute('stroke-linejoin', 'round')
    // Only the dashed outline is interactive, so clicks inside the region still
    // fall through to the canvas for panning and box-selection.
    path.setAttribute('pointer-events', 'stroke')
  }

  function styleGroupName(text: SVGTextElement, color: string): void {
    text.setAttribute('fill', color)
    text.setAttribute('font-size', '14')
    text.setAttribute('font-family', 'system-ui')
    text.setAttribute('font-weight', '600')
    text.setAttribute('text-anchor', 'start')
    text.setAttribute('pointer-events', 'none')
    text.style.userSelect = 'none'
  }

  // The left end of the highest (smallest-y) horizontal edge — where the group
  // name sits, on top of and left-aligned to that edge.
  function nameAnchor(loops: Pt[][]): Pt | null {
    let topY = Infinity
    let leftX = 0
    let found = false
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        if (Math.abs(a.y - b.y) > 1e-6) continue // horizontal edges only
        const minX = Math.min(a.x, b.x)
        if (a.y < topY - 1e-6) { topY = a.y; leftX = minX; found = true }
        else if (Math.abs(a.y - topY) <= 1e-6 && minX < leftX) leftX = minX
      }
    }
    return found ? { x: leftX, y: topY } : null
  }

  function renderGroupName(grouping: Grouping, loops: Pt[][]): void {
    let text = groupNameById.get(grouping.id)
    const anchor = nameAnchor(loops)
    const label = grouping.name.trim()
    if (!anchor || !label) {
      text?.remove()
      groupNameById.delete(grouping.id)
      return
    }
    if (!text) {
      text = svgEl('text')
      groupLayer.appendChild(text)
      groupNameById.set(grouping.id, text)
    }
    styleGroupName(text, grouping.color)
    text.textContent = label
    // Sit on top of the edge, inset past the rounded corner, left-aligned.
    text.setAttribute('x', String(anchor.x + 14))
    text.setAttribute('y', String(anchor.y - 6))
  }

  function renderGrouping(grouping: Grouping): void {
    let path = groupPathById.get(grouping.id)
    if (!path) {
      path = svgEl('path')
      path.dataset.groupId = grouping.id
      path.style.cursor = 'pointer'
      styleGroupPath(path, grouping.color)
      path.addEventListener('mousedown', (e) => e.stopPropagation())
      path.addEventListener('click', (e) => {
        e.stopPropagation()
        const g = groupingById.get(grouping.id)
        if (g) openGroupPanel(g)
      })
      groupLayer.appendChild(path)
      groupPathById.set(grouping.id, path)
    }
    const { members, nonMembers } = groupRects(grouping)
    const loops = computeGroupLoops(members, nonMembers)
    groupLoopsById.set(grouping.id, loops)
    path.setAttribute('d', loopsToPath(loops))
    renderGroupName(grouping, loops)
  }

  // Bounding box of a group's members (live positions), or null when none exist.
  function groupMemberBounds(g: Grouping): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false
    for (const mid of g.members) {
      const mp = livePos.get(mid)
      if (!mp) continue
      minX = Math.min(minX, mp.x - NODE_HW); maxX = Math.max(maxX, mp.x + NODE_HW)
      minY = Math.min(minY, mp.y - mp.hh);   maxY = Math.max(maxY, mp.y + mp.hh)
      found = true
    }
    return found ? { minX, minY, maxX, maxY } : null
  }

  // Whether a moving node is close enough to a group to affect its outline (so a
  // non-member group still recomputes as the node passes through its region).
  function nodeNearGroup(nodeId: string, g: Grouping): boolean {
    const p = livePos.get(nodeId)
    if (!p) return false
    const b = groupMemberBounds(g)
    if (!b) return false
    const M = 70 // ≈ memberPad + excludePad + a little slack
    return p.x >= b.minX - M && p.x <= b.maxX + M && p.y >= b.minY - M && p.y <= b.maxY + M
  }

  function updateGroupsForNodes(ids: Iterable<string>): void {
    const idList = [...ids]
    const affected = new Set<string>()
    for (const id of idList) {
      const set = groupsByNode.get(id)
      if (set) for (const gid of set) affected.add(gid)
    }
    // Non-member groups whose region a moving node has entered must also
    // recompute, so a locked group visibly adjusts to keep the node out (and an
    // unlocked one carves around it until the node is dropped and absorbed).
    for (const g of groupingById.values()) {
      if (affected.has(g.id)) continue
      for (const id of idList) {
        if (nodeNearGroup(id, g)) { affected.add(g.id); break }
      }
    }
    for (const gid of affected) {
      const g = groupingById.get(gid)
      if (g) renderGrouping(g)
    }
  }

  // On drop, an unlocked group absorbs any dragged node whose centre landed in
  // its area. Containment is tested against the members-only region (no
  // exclusions) so a node sitting in the boundary's avoidance notch still counts.
  function absorbDraggedNodes(ids: string[]): void {
    for (const g of groupingById.values()) {
      if (g.locked) continue
      const memberSet = new Set(g.members)
      const candidates = ids.filter(id => !memberSet.has(id) && livePos.has(id))
      if (candidates.length === 0) continue
      // Cheap reject: skip the outline pass unless a candidate is near the group.
      if (!candidates.some(id => nodeNearGroup(id, g))) continue
      const members: GroupRect[] = []
      for (const mid of g.members) {
        const mp = livePos.get(mid)
        if (mp) members.push({ x: mp.x, y: mp.y, hw: NODE_HW, hh: mp.hh })
      }
      if (members.length === 0) continue
      const fillLoops = computeGroupLoops(members, [])
      const toAdd = candidates.filter(id => {
        const p = livePos.get(id)!
        return pointInLoops(fillLoops, p.x, p.y)
      })
      if (toAdd.length === 0) continue
      const before = [...g.members]
      const after = [...g.members, ...toAdd]
      record({ type: 'members-grouping', id: g.id, from: before, to: after })
      internalSetGroupingMembers(g.id, after)
    }
  }

  // A node being added or removed changes the non-member set every group is
  // carved against, so every outline is recomputed.
  function refreshAllGroups(): void {
    for (const g of groupingById.values()) renderGrouping(g)
  }

  function internalAddGrouping(grouping: Grouping, persist = true): void {
    if (groupingById.has(grouping.id)) return
    graph.groupings.push(grouping)
    indexGrouping(grouping)
    renderGrouping(grouping)
    if (persist) api.upsertGrouping(grouping).catch(console.error)
  }

  function internalRemoveGrouping(id: string, persist = true): void {
    const idx = graph.groupings.findIndex(g => g.id === id)
    if (idx < 0) return
    const [removed] = graph.groupings.splice(idx, 1)
    unindexGrouping(removed)
    groupPathById.get(id)?.remove()
    groupPathById.delete(id)
    groupNameById.get(id)?.remove()
    groupNameById.delete(id)
    groupLoopsById.delete(id)
    if (persist) api.deleteGrouping(id).catch(console.error)
  }

  function internalSetGroupingMembers(id: string, members: string[], persist = true): void {
    const grouping = groupingById.get(id)
    if (!grouping) return
    unindexGrouping(grouping)
    grouping.members = [...members]
    indexGrouping(grouping)
    renderGrouping(grouping)
    if (persist) api.patchGrouping(id, { members: grouping.members }).catch(console.error)
  }

  function internalSetGroupingColor(id: string, color: string, persist = true): void {
    const grouping = groupingById.get(id)
    if (!grouping) return
    grouping.color = color
    const path = groupPathById.get(id)
    if (path) styleGroupPath(path, color)
    groupNameById.get(id)?.setAttribute('fill', color)
    if (persist) api.patchGrouping(id, { color }).catch(console.error)
  }

  function internalSetGroupingName(id: string, name: string, persist = true): void {
    const grouping = groupingById.get(id)
    if (!grouping) return
    grouping.name = name
    renderGroupName(grouping, groupLoopsById.get(id) ?? [])
    if (persist) api.patchGrouping(id, { name }).catch(console.error)
  }

  // Locking changes no geometry — a group always excludes non-members — only
  // whether a node dragged into the region is absorbed on drop.
  function internalSetGroupingLocked(id: string, locked: boolean, persist = true): void {
    const grouping = groupingById.get(id)
    if (!grouping) return
    grouping.locked = locked
    if (persist) api.patchGrouping(id, { locked }).catch(console.error)
  }

  // ── Edge toggle ────────────────────────────────────────────────────────────

  function toggleEdge(fromId: string, toId: string): void {
    const existingIdx = graph.edges.findIndex(e => e.from === fromId && e.to === toId)
    if (existingIdx >= 0) {
      const [removed] = graph.edges.splice(existingIdx, 1)
      unindexEdge(removed)
      const defs = getDefs()
      if (defs) cleanupVanishDefs(removed.id, defs)
      pathById.get(removed.id)?.remove()
      pathById.delete(removed.id)
      api.deleteEdge(removed.id).catch(console.error)
      record({ type: 'delete-edge', edge: { ...removed } })
    } else {
      const edge: Edge = { id: `${fromId}-${toId}`, from: fromId, to: toId, routing: 'straight', style: 'solid', vanish: false }
      graph.edges.push(edge)
      indexEdge(edge)
      const path = makeEdgePath(getNodePos(fromId), getNodePos(toId), fromId, toId, edge, getGrid(), graph.nodes.find(n => n.id === fromId)?.status)
      viewport.insertBefore(path, viewport.querySelector<SVGGElement>('[data-node-id]'))
      pathById.set(edge.id, path)
      api.upsertEdge(edge).catch(console.error)
      record({ type: 'create-edge', edge: { ...edge } })
    }
    requestLayout()
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
    hideGroupPanel()
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
          const rectEl = nodeElById.get(id)?.querySelector('rect')
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

  // ── Grouping actions ────────────────────────────────────────────────────────

  function cloneGrouping(g: Grouping): Grouping {
    return {
      id: g.id,
      name: g.name,
      members: [...g.members],
      vertices: g.vertices.map(v => ({ ...v })),
      color: g.color,
      locked: g.locked,
    }
  }

  function createGrouping(): void {
    if (!authenticated || selectedNodes.size === 0) return
    const grouping: Grouping = {
      id: crypto.randomUUID(),
      name: 'Unnamed',
      members: [...selectedNodes],
      vertices: [],
      color: DEFAULT_GROUP_COLOR,
      locked: false,
    }
    internalAddGrouping(grouping)
    record({ type: 'create-grouping', grouping: cloneGrouping(grouping) })
    openGroupPanel(grouping)
  }

  function modifyGroupMembers(id: string, mode: 'add' | 'remove'): void {
    const grouping = groupingById.get(id)
    if (!grouping || selectedNodes.size === 0) return
    const before = [...grouping.members]
    const set = new Set(grouping.members)
    if (mode === 'add') for (const nid of selectedNodes) set.add(nid)
    else for (const nid of selectedNodes) set.delete(nid)
    const after = [...set]
    if (after.length === before.length && after.every(m => before.includes(m))) return
    record({ type: 'members-grouping', id, from: before, to: after })
    internalSetGroupingMembers(id, after)
    const g = groupingById.get(id)
    if (g) openGroupPanel(g) // re-render so the member count refreshes
  }

  function openGroupPanel(grouping: Grouping): void {
    hidePanel()
    closeEdgeDialog()
    showGroupPanel(grouping, {
      getSelectionCount: () => selectedNodes.size,
      onAddSelection: () => modifyGroupMembers(grouping.id, 'add'),
      onRemoveSelection: () => modifyGroupMembers(grouping.id, 'remove'),
      onNameCommit: (from, to) => {
        if (from === to) return
        record({ type: 'name-grouping', id: grouping.id, from, to })
        internalSetGroupingName(grouping.id, to)
      },
      onToggleLock: (next) => {
        const cur = groupingById.get(grouping.id)
        if (!cur || cur.locked === next) return
        record({ type: 'lock-grouping', id: grouping.id, from: cur.locked, to: next })
        internalSetGroupingLocked(grouping.id, next)
      },
      onColorPreview: (color) => internalSetGroupingColor(grouping.id, color, false),
      onColorCommit: (from, to) => {
        if (from === to) return
        record({ type: 'color-grouping', id: grouping.id, from, to })
        internalSetGroupingColor(grouping.id, to)
      },
      onDelete: () => {
        record({ type: 'delete-grouping', grouping: cloneGrouping(grouping) })
        hideGroupPanel()
        internalRemoveGrouping(grouping.id)
      },
      onClose: () => {},
    }, !authenticated)
  }

  // ── Add-node mode ─────────────────────────────────────────────────────────

  let addMode = false
  let addModeDocListener: ((e: MouseEvent) => void) | null = null

  // Bottom-left button stack. column-reverse keeps "Create node" pinned to the
  // bottom; the grouping button and the alignment buttons stack above it.
  const bottomStack = document.createElement('div')
  bottomStack.style.cssText =
    'position:fixed;bottom:1rem;left:1rem;display:flex;flex-direction:column-reverse;' +
    'align-items:flex-start;gap:.375rem;z-index:100;'
  document.body.appendChild(bottomStack)

  const addBtn = document.createElement('button')
  addBtn.textContent = 'Create node'
  addBtn.style.cssText =
    'height:1.875rem;padding:0 .75rem;' +
    'background:#0d1117;border:1px solid #30363d;' +
    'color:#8b949e;font-size:.8rem;font-family:system-ui;letter-spacing:.02em;' +
    'cursor:pointer;display:none;align-items:center;justify-content:center;'
  bottomStack.appendChild(addBtn)

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

  // Create Grouping — shown above the stack whenever ≥1 node is selected.
  const createGroupBtn = makeAlignBtn('Create grouping', () => createGrouping())
  createGroupBtn.style.display = 'none'
  bottomStack.appendChild(createGroupBtn)

  const alignPanel = document.createElement('div')
  alignPanel.style.cssText =
    'display:none;flex-direction:column;gap:.375rem;'
  bottomStack.appendChild(alignPanel)

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
    requestLayout()
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
    requestLayout()
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
    hideGroupPanel()
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
        requestLayout()
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
        const edge = edgeById.get(entry.id)
        if (edge) setEdgeSettings(edge, dir === 'undo' ? entry.from : entry.to)
        break
      }
      case 'create-grouping':
        if (dir === 'undo') internalRemoveGrouping(entry.grouping.id)
        else internalAddGrouping(cloneGrouping(entry.grouping))
        break
      case 'delete-grouping':
        if (dir === 'undo') internalAddGrouping(cloneGrouping(entry.grouping))
        else internalRemoveGrouping(entry.grouping.id)
        break
      case 'members-grouping':
        internalSetGroupingMembers(entry.id, dir === 'undo' ? entry.from : entry.to)
        break
      case 'color-grouping':
        internalSetGroupingColor(entry.id, dir === 'undo' ? entry.from : entry.to)
        break
      case 'name-grouping':
        internalSetGroupingName(entry.id, dir === 'undo' ? entry.from : entry.to)
        break
      case 'lock-grouping':
        internalSetGroupingLocked(entry.id, dir === 'undo' ? entry.from : entry.to)
        break
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
    // Defer while any interaction is live — a node or middle-segment drag, a
    // pan, a box select, a pending click-to-add, or an open edge dialog.
    if (activeNode || midDrag || panning || boxSelecting) return false
    if (pendingAddPos || pendingCtrlAddPos || isEdgeDialogOpen()) return false
    if (changes.nodes.length === 0 && changes.edges.length === 0 &&
        changes.groupings.length === 0 && changes.deletions.length === 0) return true

    for (const d of changes.deletions) {
      if (d.entityType === 'node') internalRemoveNode(d.entityId, false)
      else if (d.entityType === 'grouping') {
        const existed = groupingById.has(d.entityId)
        internalRemoveGrouping(d.entityId, false)
        if (existed && isGroupPanelOpen()) hideGroupPanel()
        continue
      } else internalRemoveEdge(d.entityId, false)
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
      const existing = edgeById.get(edge.id)
      if (!existing) { internalAddEdge(edge, false); continue }
      const patch: EdgeSettingsPatch = {}
      if (existing.routing !== edge.routing) patch.routing = edge.routing
      if (existing.style !== edge.style) patch.style = edge.style
      if (existing.vanish !== edge.vanish) patch.vanish = edge.vanish
      if ((existing.midAxis ?? null) !== (edge.midAxis ?? null)) patch.midAxis = edge.midAxis ?? null
      if ((existing.midPos ?? null) !== (edge.midPos ?? null)) patch.midPos = edge.midPos ?? null
      if (Object.keys(patch).length > 0) setEdgeSettings(existing, patch, false)
    }

    for (const grouping of changes.groupings) {
      const existing = groupingById.get(grouping.id)
      if (!existing) { internalAddGrouping(grouping, false); continue }
      const sameMembers =
        existing.members.length === grouping.members.length &&
        existing.members.every(m => grouping.members.includes(m))
      if (!sameMembers) internalSetGroupingMembers(grouping.id, grouping.members, false)
      if (existing.color !== grouping.color) internalSetGroupingColor(grouping.id, grouping.color, false)
      if (existing.name !== grouping.name) internalSetGroupingName(grouping.id, grouping.name, false)
      if (existing.locked !== grouping.locked) internalSetGroupingLocked(grouping.id, grouping.locked, false)
      existing.vertices = grouping.vertices
    }

    refreshHighlights()
    requestLayout()
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
      hideGroupPanel()
      alignPanel.style.display = 'none'
      createGroupBtn.style.display = 'none'
    }
    hidePanel()
  }

  function centerOnNode(id: string): void {
    const g = nodeElById.get(id)
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

  // ── Drag frame batching ───────────────────────────────────────────────────
  // Mousemove during a node/mid-segment drag only records the pointer; the
  // actual position updates and edge re-routes run once per animation frame.
  let dragFrame: number | null = null
  let lastDragClient: { x: number; y: number } | null = null
  let lastDragLayoutAt = 0

  function scheduleDragFrame(e: MouseEvent): void {
    lastDragClient = { x: e.clientX, y: e.clientY }
    if (dragFrame === null) dragFrame = requestAnimationFrame(processDragFrame)
  }

  // Run a pending drag frame immediately (mouseup must see final positions).
  function flushDragFrame(): void {
    if (dragFrame !== null) {
      cancelAnimationFrame(dragFrame)
      processDragFrame()
    }
  }

  // Throttled mid-drag layout request: lets neighbouring stacks adjust locally
  // while the drag is live. Results are async and superseded, and applyLayout
  // leaves the dragged edges to the local per-frame pass.
  function maybeRequestDragLayout(): void {
    const now = performance.now()
    if (now - lastDragLayoutAt >= DRAG_LAYOUT_INTERVAL_MS) {
      lastDragLayoutAt = now
      requestLayout()
    }
  }

  function moveDraggedNode(id: string, originCx: number, originCy: number, dx: number, dy: number): void {
    const g = nodeElById.get(id)
    if (!g) return
    const p = getNodePos(id)
    p.x = originCx + dx / state.scale
    p.y = originCy + dy / state.scale
    g.dataset.cx = String(p.x)
    g.dataset.cy = String(p.y)
    g.setAttribute('transform', `translate(${p.x - NODE_HW},${p.y - p.hh})`)
  }

  function processDragFrame(): void {
    dragFrame = null
    if (!lastDragClient) return
    const { x: clientX, y: clientY } = lastDragClient

    if (midDrag) {
      const d = midDrag.axis === 'x'
        ? clientX - midDrag.startClient.x
        : clientY - midDrag.startClient.y
      if (!midDrag.moved && Math.abs(d) > DRAG_THRESHOLD) {
        midDrag.moved = true
        midDrag.btn.querySelector('circle')?.setAttribute('stroke', SELECTED_STROKE)
        midDrag.btn.style.cursor = 'grabbing'
      }
      if (midDrag.moved) {
        const edge = midDrag.edge
        edge.midAxis = midDrag.axis
        edge.midPos = midDrag.startPos + d / state.scale
        const path = pathById.get(edge.id)
        if (path) {
          refreshEdgePath(path)
          // Keep the icon cluster riding on the segment as it moves.
          const cluster = iconClusters.find(c => c.edgeId === edge.id)
          if (cluster) {
            cluster.midVpX = Number(path.dataset.midX)
            cluster.midVpY = Number(path.dataset.midY)
            positionIconClusters()
          }
        }
        maybeRequestDragLayout()
      }
      return
    }

    if (activeNode) {
      const dx = clientX - dragClientStart.x
      const dy = clientY - dragClientStart.y
      if (!hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        if (!authenticated) return
        hasDragged = true
        activeNode.style.cursor = 'grabbing'
        // Moving a node resets any manual middle-segment placement on its
        // edges; the server clears the persisted values when the move lands.
        if (isMultiDrag) for (const id of multiDragOrigins.keys()) clearMidOverridesForNode(id)
        else clearMidOverridesForNode(activeNode.dataset.nodeId!)
      }
      if (hasDragged) {
        if (isMultiDrag) {
          for (const [id, origin] of multiDragOrigins) {
            moveDraggedNode(id, origin.cx, origin.cy, dx, dy)
          }
          invalidateGrid()
          for (const id of multiDragOrigins.keys()) updateEdgesForNode(id)
          updateGroupsForNodes(multiDragOrigins.keys())
        } else {
          const id = activeNode.dataset.nodeId!
          moveDraggedNode(id, singleDragOrigin.cx, singleDragOrigin.cy, dx, dy)
          invalidateGrid()
          updateEdgesForNode(id)
          updateGroupsForNodes([id])
        }
        maybeRequestDragLayout()
      }
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  svg.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent
    me.preventDefault()

    const nodeG = (me.target as Element).closest<SVGGElement>('[data-node-id]')

    if (nodeG) {
      setAddMode(false)
      activeNode = nodeG
      hasDragged = false
      lastDragClient = null
      dragClientStart = { x: me.clientX, y: me.clientY }
      const startPos = getNodePos(nodeG.dataset.nodeId!)
      singleDragOrigin = { cx: startPos.x, cy: startPos.y }

      const nodeId = nodeG.dataset.nodeId!
      if (authenticated && selectedNodes.size > 1 && selectedNodes.has(nodeId)) {
        isMultiDrag = true
        multiDragOrigins.clear()
        for (const id of selectedNodes) {
          const p = getNodePos(id)
          multiDragOrigins.set(id, { cx: p.x, cy: p.y })
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
      hideGroupPanel()
      panning = true
      panStart = { x: me.clientX, y: me.clientY }
      panOrigin = { tx: state.tx, ty: state.ty }
      svg.style.cursor = 'grabbing'
      clearSelection()
    }
  })

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (midDrag || activeNode) {
      scheduleDragFrame(e)
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
    if (midDrag) {
      flushDragFrame()
      const { edge, before, moved } = midDrag
      midDrag = null
      if (moved) {
        lastMidDragEnd = Date.now()
        // Roll the edge back to its pre-drag values so applyEdgePatch records
        // the change as one undoable step and persists the final position.
        const finalAxis = edge.midAxis ?? null
        const finalPos = edge.midPos ?? null
        edge.midAxis = before.midAxis
        edge.midPos = before.midPos
        applyEdgePatch(edge, { midAxis: finalAxis, midPos: finalPos })
        updateIconClusters()
      }
      return
    }

    if (activeNode) {
      flushDragFrame()
      if (hasDragged) {
        const moved = isMultiDrag ? [...multiDragOrigins.keys()] : [activeNode.dataset.nodeId!]
        const moveRecords: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }> = []
        for (const id of moved) {
          const node = graph.nodes.find(n => n.id === id)
          if (node) {
            const p = getNodePos(id)
            const origin = isMultiDrag ? multiDragOrigins.get(id)! : singleDragOrigin
            moveRecords.push({ id, from: { x: origin.cx, y: origin.cy }, to: { x: p.x, y: p.y } })
            node.x = p.x
            node.y = p.y
            api.upsertNode(node).catch(console.error)
          }
        }
        if (moveRecords.length > 0) record({ type: 'move-nodes', moves: moveRecords })
        // After the move is recorded, unlocked groups absorb any node dropped
        // inside them (recorded as its own undoable step, applied after the move).
        absorbDraggedNodes(moved)
      }
      const wasDrag = hasDragged
      activeNode.style.cursor = 'grab'
      const releasedNodeId = activeNode.dataset.nodeId!
      activeNode = null
      isMultiDrag = false
      hasDragged = false
      if (wasDrag) {
        // Positions settled: run the authoritative async pass (and, when it
        // lands, the vanish masks).
        requestLayout()
        return
      }
      if (authenticated && e.ctrlKey) {
        if (selectedNodes.size === 1 && !selectedNodes.has(releasedNodeId)) {
          toggleEdge([...selectedNodes][0], releasedNodeId)
        }
      } else if (e.shiftKey) {
        if (selectedNodes.has(releasedNodeId)) selectedNodes.delete(releasedNodeId)
        else selectedNodes.add(releasedNodeId)
        refreshHighlights()
      } else {
        clearSelection()
        selectNode(releasedNodeId)
        const node = graph.nodes.find(n => n.id === releasedNodeId)!
        openPanel(node)
      }
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
        for (const [id, g] of nodeElById) {
          const cx = Number(g.dataset.cx)
          const cy = Number(g.dataset.cy)
          if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
            selectedNodes.add(id)
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
        minX = Math.min(minX, n.x - NODE_HW)
        minY = Math.min(minY, n.y - hh)
        maxX = Math.max(maxX, n.x + NODE_HW)
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
      requestLayout()
    })
  }

  return { setAuthenticated, centerOnNode, undo: performUndo, redo: performRedo, applyRemoteChanges }
}
