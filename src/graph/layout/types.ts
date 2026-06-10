// Pure data types shared by the layout pipeline, the layout worker and the
// main thread. Nothing in this module (or the modules it feeds) may touch the
// DOM: the worker runs them without `document`, and the tests run them in node.

import type { EdgeRouting, MidAxis } from '../../types'

export type Pt = { x: number; y: number }
export type Seg = { x1: number; y1: number; x2: number; y2: number }
export type Orient = 'H' | 'V'

export const NODE_HW = 60
// Minimum / default half-height. Nodes grow taller than this when their label
// wraps onto multiple lines; the snapshot carries the true value because text
// measurement is only possible on the main thread.
export const NODE_HH = 20

// A node as the layout pipeline sees it: position plus measured half-height.
export interface NodeSnap {
  id: string
  x: number
  y: number
  hh: number
}

export interface EdgeSnap {
  id: string
  from: string
  to: string
  routing: EdgeRouting
  midAxis?: MidAxis | null
  midPos?: number | null
}

export interface LayoutInput {
  nodes: NodeSnap[]
  edges: EdgeSnap[]
}

export interface EdgeLayout {
  segments: Seg[]
  midX: number
  midY: number
}

// Plain Record (not Map) so the result survives structured clone unchanged.
export interface LayoutResult {
  edges: Record<string, EdgeLayout>
}

// ── Worker protocol ───────────────────────────────────────────────────────────

export interface LayoutRequest {
  gen: number
  input: LayoutInput
}

export interface LayoutResponse {
  gen: number
  result: LayoutResult
}

export function segOrient(s: Seg): Orient {
  return Math.abs(s.y2 - s.y1) < 0.5 ? 'H' : 'V'
}

export function pointsToSegs(pts: Pt[]): Seg[] {
  const segs: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  }
  return segs
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
