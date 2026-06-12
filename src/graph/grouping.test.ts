import { describe, it, expect } from 'vitest'
import { computeGroupLoops, computeGroupOutline, type GroupRect, type Pt } from './grouping'

const node = (x: number, y: number): GroupRect => ({ x, y, hw: 60, hh: 20 })

// Even-odd point-in-polygon over every loop: a point is inside the region iff
// it is enclosed by an odd number of loops (so holes count as outside).
function pointInLoops(loops: Pt[][], px: number, py: number): boolean {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j]
      if ((a.y > py) !== (b.y > py)) {
        const xCross = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x)
        if (px < xCross) inside = !inside
      }
    }
  }
  return inside
}

describe('computeGroupLoops', () => {
  it('returns nothing without members', () => {
    expect(computeGroupLoops([], [node(0, 0)])).toEqual([])
  })

  it('encloses a single member with only horizontal/vertical edges', () => {
    const loops = computeGroupLoops([node(0, 0)], [])
    expect(loops.length).toBe(1)
    const loop = loops[0]
    expect(loop.length).toBeGreaterThanOrEqual(4)
    // Every edge of the simplified rectilinear polygon is axis-aligned.
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const axisAligned = Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6
      expect(axisAligned).toBe(true)
    }
    // The member centre is enclosed; a point far outside is not.
    expect(pointInLoops(loops, 0, 0)).toBe(true)
    expect(pointInLoops(loops, 1000, 1000)).toBe(false)
  })

  it('encloses all members of a multi-node selection', () => {
    const members = [node(0, 0), node(300, 0), node(150, 200)]
    const loops = computeGroupLoops(members, [])
    for (const m of members) expect(pointInLoops(loops, m.x, m.y)).toBe(true)
  })

  it('excludes a non-member node sitting between members', () => {
    // Two members with an intruding non-member centred between them.
    const members = [node(0, 0), node(400, 0)]
    const intruder = node(200, 0)
    const loops = computeGroupLoops(members, [intruder])
    expect(pointInLoops(loops, 0, 0)).toBe(true)
    expect(pointInLoops(loops, 400, 0)).toBe(true)
    // The intruder's centre is carved out of the region.
    expect(pointInLoops(loops, 200, 0)).toBe(false)
  })

  it('keeps a member enclosed even if a non-member overlaps it', () => {
    const loops = computeGroupLoops([node(0, 0)], [node(10, 0)])
    expect(pointInLoops(loops, 0, 0)).toBe(true)
  })
})

describe('computeGroupOutline', () => {
  it('produces a closed SVG path with rounded corners for a member', () => {
    const d = computeGroupOutline([node(0, 0)], [])
    expect(d).toMatch(/^M /)
    expect(d).toContain('Q') // rounded corners
    expect(d.trim().endsWith('Z')).toBe(true)
  })

  it('is empty without members', () => {
    expect(computeGroupOutline([], [])).toBe('')
  })
})
