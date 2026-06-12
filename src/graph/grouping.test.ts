import { describe, it, expect } from 'vitest'
import { computeGroupLoops, computeGroupShape, computeGroupOutline, type GroupRect, type Pt } from './grouping'

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

  it('uses a single padded rectangle for spread-out members (no corridor arms)', () => {
    const members = [node(0, 0), node(300, 0), node(150, 200)]
    const shape = computeGroupShape(members, [])
    expect(shape.excluded).toEqual([])
    for (const m of members) expect(pointInLoops(shape.loops, m.x, m.y)).toBe(true)
    expect(shape.loops.length).toBe(1)
    expect(shape.loops[0].length).toBe(4)
    // The middle of the region is inside — no thin bridge required.
    expect(pointInLoops(shape.loops, 150, 100)).toBe(true)
  })

  it('encloses far-apart members in one padded rectangle', () => {
    const loops = computeGroupLoops([node(0, 0), node(360, 0)], [])
    expect(pointInLoops(loops, 0, 0)).toBe(true)
    expect(pointInLoops(loops, 360, 0)).toBe(true)
    expect(pointInLoops(loops, 180, 0)).toBe(true)
    expect(loops[0].length).toBe(4)
  })

  it('keeps the full region when non-members sit outside it', () => {
    const members = [node(0, 0), node(300, 0)]
    const bystanders = [node(150, 200), node(150, -200), node(-250, 0), node(550, 0)]
    const shape = computeGroupShape(members, bystanders)
    expect(shape.excluded).toEqual([])
    expect(shape.loops.length).toBe(1)
    expect(shape.loops[0].length).toBe(4)
    for (const m of members) expect(pointInLoops(shape.loops, m.x, m.y)).toBe(true)
  })

  it('shapes a simple 8-vertex notch around a non-member between members', () => {
    const members = [node(0, 0), node(400, 0)]
    const intruder = node(200, 0)
    const shape = computeGroupShape(members, [intruder])
    expect(shape.excluded).toEqual([])
    // One loop, one rectangular notch: no hole, no corridor.
    expect(shape.loops.length).toBe(1)
    expect(shape.loops[0].length).toBe(8)
    expect(pointInLoops(shape.loops, 0, 0)).toBe(true)
    expect(pointInLoops(shape.loops, 400, 0)).toBe(true)
    expect(pointInLoops(shape.loops, 200, 0)).toBe(false)
  })

  it('shapes a C around a non-member surrounded by members on four corners', () => {
    const members = [node(0, 0), node(400, 0), node(0, 300), node(400, 300)]
    const enclosed = node(200, 150)
    const shape = computeGroupShape(members, [enclosed])
    expect(shape.excluded).toEqual([])
    expect(shape.loops.length).toBe(1) // no interior hole
    expect(shape.loops[0].length).toBe(8)
    expect(pointInLoops(shape.loops, 200, 150)).toBe(false)
    for (const m of members) expect(pointInLoops(shape.loops, m.x, m.y)).toBe(true)
  })

  it('relents to a ring enclave when members surround a non-member on all sides', () => {
    const members = [node(-120, 0), node(120, 0), node(0, -120), node(0, 120)]
    const enclosed = node(0, 0)
    const shape = computeGroupShape(members, [enclosed])
    expect(shape.excluded).toEqual([])
    expect(shape.loops.length).toBe(2) // outer boundary + interior hole
    expect(pointInLoops(shape.loops, 0, 0)).toBe(false)
    for (const m of members) expect(pointInLoops(shape.loops, m.x, m.y)).toBe(true)
  })

  it('avoids a short non-member edge crossing the region', () => {
    const members = [node(0, 0), node(400, 0)]
    const loops = computeGroupLoops(members, [], {
      excludeSegments: [{ x1: 200, y1: -10, x2: 200, y2: 10 }],
    })
    expect(loops.length).toBe(1)
    expect(pointInLoops(loops, 200, 0)).toBe(false)
    expect(pointInLoops(loops, 0, 0)).toBe(true)
    expect(pointInLoops(loops, 400, 0)).toBe(true)
  })

  it('ignores a non-member edge that cannot be avoided without splitting the group', () => {
    const members = [node(0, 0), node(400, 0)]
    const shape = computeGroupShape(members, [], {
      excludeSegments: [{ x1: 200, y1: -300, x2: 200, y2: 300 }],
    })
    expect(shape.excluded).toEqual([])
    expect(shape.loops.length).toBe(1)
    expect(shape.loops[0].length).toBe(4)
    expect(pointInLoops(shape.loops, 200, 0)).toBe(true)
  })

  it('drops a member as an exclave when a non-member severs the region', () => {
    const members = [node(0, 0), node(90, 0), node(600, 0)]
    const wall: GroupRect = { x: 320, y: 0, hw: 30, hh: 220 }
    const shape = computeGroupShape(members, [wall])
    expect(shape.excluded).toEqual([2])
    expect(pointInLoops(shape.loops, 0, 0)).toBe(true)
    expect(pointInLoops(shape.loops, 90, 0)).toBe(true)
    expect(pointInLoops(shape.loops, 600, 0)).toBe(false)
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
