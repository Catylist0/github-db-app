'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const GRAPH_PATH = path.join(ROOT, 'data', 'graph.json')
const USERS_DIR = path.join(ROOT, 'data', 'users')

function readJSON(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  if (!raw) throw new Error('file is empty')
  return JSON.parse(raw)
}

function isValidGraph(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    Array.isArray(data.nodes) &&
    Array.isArray(data.edges)
  )
}

function getLastCommitTimestamp(relPath) {
  try {
    const out = execSync(`git log --format="%at" -1 -- "${relPath}"`, {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim()
    return out ? parseInt(out, 10) : 0
  } catch {
    return 0
  }
}

// ── Read base graph ────────────────────────────────────────────────────────

let base = { nodes: [], edges: [] }
try {
  const data = readJSON(GRAPH_PATH)
  if (isValidGraph(data)) {
    base = data
  } else {
    console.warn('Warning: data/graph.json has invalid shape — starting from empty graph')
  }
} catch (err) {
  console.warn(`Warning: could not read data/graph.json (${err.message}) — starting from empty graph`)
}

// ── Collect user files ─────────────────────────────────────────────────────

let userFiles = []
if (fs.existsSync(USERS_DIR)) {
  userFiles = fs.readdirSync(USERS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ abs: path.join(USERS_DIR, name), rel: `data/users/${name}`, name }))
}

if (userFiles.length === 0) {
  console.log('No user files to merge — nothing to do')
  process.exit(0)
}

// Sort ascending by last commit timestamp so the newest file is applied last and wins
userFiles.sort((a, b) => getLastCommitTimestamp(a.rel) - getLastCommitTimestamp(b.rel))

// ── Merge ──────────────────────────────────────────────────────────────────

const nodeMap = new Map(base.nodes.map(n => [n.id, n]))
const edgeSet = new Set(base.edges.map(e => `${e.from}→${e.to}`))
const edges = [...base.edges]

for (const { abs, name } of userFiles) {
  let data
  try {
    data = readJSON(abs)
  } catch (err) {
    console.warn(`Warning: skipping ${name} — ${err.message}`)
    continue
  }
  if (!isValidGraph(data)) {
    console.warn(`Warning: skipping ${name} — missing nodes or edges arrays`)
    continue
  }
  for (const node of data.nodes) nodeMap.set(node.id, node)
  for (const edge of data.edges) {
    const key = `${edge.from}→${edge.to}`
    if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(edge) }
  }
  console.log(`Merged ${name}`)
}

const merged = { nodes: [...nodeMap.values()], edges }

// ── Write graph.json ───────────────────────────────────────────────────────

fs.writeFileSync(GRAPH_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8')
console.log('Written data/graph.json')

// ── Delete user files only after successful write ──────────────────────────

for (const { abs, name } of userFiles) {
  try {
    fs.unlinkSync(abs)
    console.log(`Deleted ${name}`)
  } catch (err) {
    console.warn(`Warning: could not delete ${name} — ${err.message}`)
  }
}
