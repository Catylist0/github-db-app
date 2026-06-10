import { describe, it, expect } from 'vitest'
import { layoutEdges, createLayoutCache } from './pipeline'
import { segIntersectT } from './route'
import type { LayoutInput, NodeSnap, EdgeSnap, Seg } from './types'

function node(id: string, x: number, y: number, hh = 20): NodeSnap {
  return { id, x, y, hh }
}

function straight(id: string, from: string, to: string): EdgeSnap {
  return { id, from, to, routing: 'straight' }
}

function elbow2(id: string, from: string, to: string): EdgeSnap {
  return { id, from, to, routing: 'elbow2' }
}

function crossings(a: Seg[], b: Seg[]): number {
  let n = 0
  for (const sa of a) {
    for (const sb of b) {
      if (segIntersectT(sa.x1, sa.y1, sa.x2, sa.y2, sb.x1, sb.y1, sb.x2, sb.y2) !== null) n++
    }
  }
  return n
}

function assertConnected(segs: Seg[]): void {
  for (let i = 0; i + 1 < segs.length; i++) {
    expect(segs[i].x2).toBeCloseTo(segs[i + 1].x1, 6)
    expect(segs[i].y2).toBeCloseTo(segs[i + 1].y1, 6)
  }
}

describe('layoutEdges', () => {
  it('separates reciprocal A⇄B edges into crossing-free parallel lines', () => {
    const input: LayoutInput = {
      nodes: [node('a', 0, 0), node('b', 300, 0)],
      edges: [straight('ab', 'a', 'b'), straight('ba', 'b', 'a')],
    }
    const { edges } = layoutEdges(input)
    const ab = edges['ab'].segments
    const ba = edges['ba'].segments
    expect(ab).toHaveLength(1)
    expect(ba).toHaveLength(1)
    // Distinct perpendicular positions — the pair was actually stacked apart.
    expect(ab[0].y1).not.toBeCloseTo(ba[0].y1, 3)
    expect(crossings(ab, ba)).toBe(0)
    // Endpoints stay on the node sides (perp within the nodes' vertical range).
    for (const s of [...ab, ...ba]) {
      expect(Math.abs(s.y1)).toBeLessThanOrEqual(16)
    }
  })

  it('keeps parallel elbow2 edges crossing-free across shared H and V corridors', () => {
    const input: LayoutInput = {
      nodes: [node('a1', 0, 0), node('a2', 0, 4), node('b1', 400, 300), node('b2', 400, 304)],
      edges: [elbow2('e1', 'a1', 'b1'), elbow2('e2', 'a2', 'b2')],
    }
    const { edges } = layoutEdges(input)
    const s1 = edges['e1'].segments
    const s2 = edges['e2'].segments
    expect(s1).toHaveLength(3)
    expect(s2).toHaveLength(3)
    assertConnected(s1)
    assertConnected(s2)
    expect(crossings(s1, s2)).toBe(0)
    // Middle (vertical) runs were spread apart instead of overlapping.
    expect(s1[1].x1).not.toBeCloseTo(s2[1].x1, 3)
  })

  it('ladders a multi-member corridor with distinct perps in stable order', () => {
    const input: LayoutInput = {
      nodes: [
        node('a1', 0, 0), node('b1', 600, 0),
        node('a2', 0, 30), node('b2', 600, 30),
        node('a3', 0, 60), node('b3', 600, 60),
      ],
      edges: [straight('e1', 'a1', 'b1'), straight('e2', 'a2', 'b2'), straight('e3', 'a3', 'b3')],
    }
    const { edges } = layoutEdges(input)
    const perps = ['e1', 'e2', 'e3'].map(id => edges[id].segments[0].y1)
    // Distinct, and preserving the natural top-to-bottom order.
    expect(perps[0]).toBeLessThan(perps[1])
    expect(perps[1]).toBeLessThan(perps[2])
  })

  it('is invariant under input permutation and deterministic across runs', () => {
    const nodes = [
      node('a', 0, 0), node('b', 300, 0),
      node('a1', 0, 100), node('a2', 0, 104), node('b1', 400, 400), node('b2', 400, 404),
      node('c', 700, 50), node('d', 700, 250),
    ]
    const edges = [
      straight('ab', 'a', 'b'), straight('ba', 'b', 'a'),
      elbow2('e1', 'a1', 'b1'), elbow2('e2', 'a2', 'b2'),
      straight('cd', 'c', 'd'), elbow2('bc', 'b', 'c'),
    ]
    const forward = layoutEdges({ nodes, edges })
    const shuffled = layoutEdges({ nodes: [...nodes].reverse(), edges: [...edges].reverse() })
    const again = layoutEdges({ nodes, edges })
    for (const e of edges) {
      expect(shuffled.edges[e.id]).toEqual(forward.edges[e.id])
      expect(again.edges[e.id]).toEqual(forward.edges[e.id])
    }
  })

  it('produces connected polylines for every edge', () => {
    const input: LayoutInput = {
      nodes: [
        node('a', 0, 0), node('b', 300, 2), node('c', 300, 200), node('d', 0, 198),
      ],
      edges: [
        straight('ab', 'a', 'b'), straight('ba', 'b', 'a'),
        elbow2('ac', 'a', 'c'), elbow2('db', 'd', 'b'),
        straight('dc', 'd', 'c'),
      ],
    }
    const { edges } = layoutEdges(input)
    for (const id of Object.keys(edges)) {
      expect(edges[id].segments.length).toBeGreaterThan(0)
      assertConnected(edges[id].segments)
    }
  })

  it('returns identical results from a warm cache', () => {
    const input: LayoutInput = {
      nodes: [node('a', 0, 0), node('b', 300, 0), node('c', 300, 30), node('d', 0, 30)],
      edges: [straight('ab', 'a', 'b'), straight('ba', 'b', 'a'), straight('dc', 'd', 'c')],
    }
    const cache = createLayoutCache()
    const cold = layoutEdges(input, cache)
    const warm = layoutEdges(input, cache)
    expect(warm).toEqual(cold)
  })

  it('handles a large dense graph quickly', () => {
    const COLS = 20
    const ROWS = 15
    const nodes: NodeSnap[] = []
    const edges: EdgeSnap[] = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        nodes.push(node(`n${r}-${c}`, c * 200, r * 200))
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        // Neighbour straights plus skip-2 elbows that overlap them, so real
        // corridors form everywhere; sprinkle reciprocal pairs for cycles.
        if (c + 1 < COLS) edges.push(straight(`h${r}-${c}`, `n${r}-${c}`, `n${r}-${c + 1}`))
        if (r + 1 < ROWS && c % 2 === 0) edges.push(straight(`v${r}-${c}`, `n${r}-${c}`, `n${r + 1}-${c}`))
        if (c + 2 < COLS && r % 2 === 0) edges.push(elbow2(`s${r}-${c}`, `n${r}-${c}`, `n${r}-${c + 2}`))
        if (c + 1 < COLS && r % 5 === 0) edges.push(straight(`r${r}-${c}`, `n${r}-${c + 1}`, `n${r}-${c}`))
      }
    }
    expect(edges.length).toBeGreaterThan(600)

    const start = performance.now()
    const result = layoutEdges({ nodes, edges })
    const elapsed = performance.now() - start

    expect(Object.keys(result.edges)).toHaveLength(edges.length)
    expect(elapsed).toBeLessThan(2000)
  })
})
