export function addInteraction(svg: SVGElement, viewport: SVGGElement): void {
  const state = { tx: 0, ty: 0, scale: 1 }

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`)
  }

  let panning = false
  let panStart = { x: 0, y: 0 }
  let panOrigin = { tx: 0, ty: 0 }

  let draggingNode: SVGGElement | null = null
  let dragStart = { x: 0, y: 0 }
  let nodeOrigin = { cx: 0, cy: 0 }

  function updateEdges(nodeId: string, cx: number, cy: number): void {
    for (const line of viewport.querySelectorAll<SVGLineElement>('line')) {
      if (line.dataset.from === nodeId) {
        line.setAttribute('x1', String(cx))
        line.setAttribute('y1', String(cy))
      }
      if (line.dataset.to === nodeId) {
        line.setAttribute('x2', String(cx))
        line.setAttribute('y2', String(cy))
      }
    }
  }

  svg.addEventListener('mousedown', (e) => {
    const nodeG = (e.target as Element).closest<SVGGElement>('[data-node-id]')
    if (nodeG) {
      draggingNode = nodeG
      dragStart = { x: e.clientX, y: e.clientY }
      nodeOrigin = { cx: Number(nodeG.dataset.cx), cy: Number(nodeG.dataset.cy) }
      nodeG.style.cursor = 'grabbing'
      e.stopPropagation()
    } else {
      panning = true
      panStart = { x: e.clientX, y: e.clientY }
      panOrigin = { tx: state.tx, ty: state.ty }
      svg.style.cursor = 'grabbing'
    }
  })

  window.addEventListener('mousemove', (e) => {
    if (draggingNode) {
      const cx = nodeOrigin.cx + (e.clientX - dragStart.x) / state.scale
      const cy = nodeOrigin.cy + (e.clientY - dragStart.y) / state.scale
      draggingNode.dataset.cx = String(cx)
      draggingNode.dataset.cy = String(cy)
      draggingNode.setAttribute('transform', `translate(${cx - 60},${cy - 20})`)
      updateEdges(draggingNode.dataset.nodeId!, cx, cy)
    } else if (panning) {
      state.tx = panOrigin.tx + (e.clientX - panStart.x)
      state.ty = panOrigin.ty + (e.clientY - panStart.y)
      applyTransform()
    }
  })

  window.addEventListener('mouseup', () => {
    if (draggingNode) {
      draggingNode.style.cursor = 'grab'
      draggingNode = null
    }
    panning = false
    svg.style.cursor = ''
  })

  // Zoom toward cursor
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const newScale = Math.max(0.1, Math.min(10, state.scale * factor))
    const rect = svg.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    state.tx = cx - (cx - state.tx) * (newScale / state.scale)
    state.ty = cy - (cy - state.ty) * (newScale / state.scale)
    state.scale = newScale
    applyTransform()
  }, { passive: false })
}
