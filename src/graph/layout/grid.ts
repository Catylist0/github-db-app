// Spatial hash over node boxes. Routing and vanish-mask passes ask "which
// nodes could this segment / shape touch" — the grid answers from the handful
// of cells the query rect covers instead of scanning every node in the graph.

import { NODE_HW, type NodeSnap } from './types'

const CELL = 256

// Anything that can answer rectangular node queries. `SpatialGrid` is the real
// implementation; `arrayObstacles` wraps a plain list for tiny call sites.
export interface ObstacleSource {
  query(minX: number, minY: number, maxX: number, maxY: number): NodeSnap[]
}

export class SpatialGrid implements ObstacleSource {
  private cells = new Map<string, NodeSnap[]>()

  constructor(nodes: NodeSnap[]) {
    for (const n of nodes) {
      const c0 = Math.floor((n.x - NODE_HW) / CELL)
      const c1 = Math.floor((n.x + NODE_HW) / CELL)
      const r0 = Math.floor((n.y - n.hh) / CELL)
      const r1 = Math.floor((n.y + n.hh) / CELL)
      for (let c = c0; c <= c1; c++) {
        for (let r = r0; r <= r1; r++) {
          const key = `${c},${r}`
          const list = this.cells.get(key)
          if (list) list.push(n)
          else this.cells.set(key, [n])
        }
      }
    }
  }

  query(minX: number, minY: number, maxX: number, maxY: number): NodeSnap[] {
    const c0 = Math.floor(minX / CELL)
    const c1 = Math.floor(maxX / CELL)
    const r0 = Math.floor(minY / CELL)
    const r1 = Math.floor(maxY / CELL)
    const seen = new Set<string>()
    const out: NodeSnap[] = []
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const list = this.cells.get(`${c},${r}`)
        if (!list) continue
        for (const n of list) {
          if (seen.has(n.id)) continue
          seen.add(n.id)
          // Cell membership is conservative; confirm the box really overlaps.
          if (n.x + NODE_HW < minX || n.x - NODE_HW > maxX) continue
          if (n.y + n.hh < minY || n.y - n.hh > maxY) continue
          out.push(n)
        }
      }
    }
    return out
  }
}

export function arrayObstacles(nodes: NodeSnap[]): ObstacleSource {
  return {
    query(minX, minY, maxX, maxY) {
      return nodes.filter(n =>
        n.x + NODE_HW >= minX && n.x - NODE_HW <= maxX &&
        n.y + n.hh >= minY && n.y - n.hh <= maxY,
      )
    },
  }
}

export const NO_OBSTACLES: ObstacleSource = { query: () => [] }
