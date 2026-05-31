const ALLOWED_ORIGIN = 'https://catylist0.github.io'
const ALLOWED_ORG = 'OpenVicProject'

const SEED_NODES = [
  { id: '1', label: 'Project Alpha', x: 400, y: 300, description: null, status: 'planned' },
  { id: '2', label: 'Design',        x: 200, y: 150, description: null, status: 'planned' },
  { id: '3', label: 'Frontend',      x: 400, y: 150, description: null, status: 'planned' },
  { id: '4', label: 'Backend',       x: 600, y: 150, description: null, status: 'planned' },
  { id: '5', label: 'Wireframes',    x: 100, y:  50, description: null, status: 'planned' },
  { id: '6', label: 'Components',    x: 400, y:  50, description: null, status: 'planned' },
]

const SEED_EDGES = [
  { id: '1-2', source: '1', target: '2' },
  { id: '1-3', source: '1', target: '3' },
  { id: '1-4', source: '1', target: '4' },
  { id: '2-5', source: '2', target: '5' },
  { id: '3-6', source: '3', target: '6' },
]

function cors(origin) {
  if (origin !== ALLOWED_ORIGIN) return {}
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

async function validateToken(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'openvic-pm-worker/1.0',
  }

  const userRes = await fetch('https://api.github.com/user', { headers })
  if (!userRes.ok) return { ok: false, reason: `invalid_token:${userRes.status}` }

  const orgsRes = await fetch('https://api.github.com/user/orgs?per_page=100', { headers })
  if (!orgsRes.ok) return { ok: false, reason: `orgs_fetch_failed:${orgsRes.status}` }

  const orgs = await orgsRes.json()
  if (!Array.isArray(orgs)) return { ok: false, reason: 'orgs_unexpected_response' }

  const isMember = orgs.some(o => o.login === ALLOWED_ORG)
  return { ok: isMember, reason: isMember ? null : 'not_org_member' }
}

async function initSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, label TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL)'),
  ])
  try {
    await db.prepare('ALTER TABLE nodes ADD COLUMN description TEXT').run()
  } catch { /* column already exists */ }
  try {
    await db.prepare("ALTER TABLE nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'planned'").run()
  } catch { /* column already exists */ }
}

async function runBackup(env) {
  const [nr, er] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM nodes'),
    env.DB.prepare('SELECT * FROM edges'),
  ])
  const timestamp = new Date().toISOString()
  const backup = JSON.stringify({
    timestamp,
    nodes: nr.results,
    edges: er.results,
  })

  await env.BACKUPS.put(`backups/${timestamp}.json`, backup, {
    httpMetadata: { contentType: 'application/json' },
  })

  // Delete backups older than 2 days
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000
  const list = await env.BACKUPS.list({ prefix: 'backups/' })
  for (const obj of list.objects) {
    const ts = new Date(obj.key.replace('backups/', '').replace('.json', '')).getTime()
    if (ts < cutoff) await env.BACKUPS.delete(obj.key)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const corsHeaders = cors(origin)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // OAuth callback — no auth required
    if (url.pathname === '/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code')
      if (!code) return new Response('Missing code', { status: 400 })

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code }),
      })
      const { access_token } = await tokenRes.json()
      if (!access_token) return new Response('OAuth failed', { status: 400 })

      const redirect = new URL('https://catylist0.github.io/github-db-app/')
      redirect.hash = `token=${access_token}`
      return Response.redirect(redirect.toString(), 302)
    }

    await initSchema(env.DB)

    // ── Public: GET /graph ────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/graph') {
      const [nr, er] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM nodes'),
        env.DB.prepare('SELECT * FROM edges'),
      ])
      if (nr.results.length === 0) {
        await env.DB.batch([
          ...SEED_NODES.map(n =>
            env.DB.prepare('INSERT OR IGNORE INTO nodes (id,label,x,y,description,status) VALUES (?,?,?,?,?,?)')
              .bind(n.id, n.label, n.x, n.y, n.description, n.status)
          ),
          ...SEED_EDGES.map(e =>
            env.DB.prepare('INSERT OR IGNORE INTO edges (id,source,target) VALUES (?,?,?)')
              .bind(e.id, e.source, e.target)
          ),
        ])
        return json({ nodes: SEED_NODES, edges: SEED_EDGES }, 200, corsHeaders)
      }
      return json({ nodes: nr.results, edges: er.results }, 200, corsHeaders)
    }

    // ── Auth middleware ───────────────────────────────────────────────────────
    const authHeader = request.headers.get('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) return json({ error: 'Unauthorized', reason: 'no_token' }, 401, corsHeaders)

    const auth = await validateToken(token)
    if (!auth.ok) return json({ error: 'Unauthorized', reason: auth.reason }, 401, corsHeaders)

    const path = url.pathname
    const segments = path.split('/').filter(Boolean)

    // GET /backups — list available backups
    if (request.method === 'GET' && path === '/backups') {
      const list = await env.BACKUPS.list({ prefix: 'backups/' })
      const keys = list.objects.map(o => ({ key: o.key, uploaded: o.uploaded }))
      return json(keys, 200, corsHeaders)
    }

    // GET /backups/:timestamp — fetch a specific backup
    if (request.method === 'GET' && segments[0] === 'backups' && segments[1]) {
      const key = `backups/${decodeURIComponent(segments[1])}.json`
      const obj = await env.BACKUPS.get(key)
      if (!obj) return json({ error: 'Not found' }, 404, corsHeaders)
      const data = await obj.json()
      return json(data, 200, corsHeaders)
    }

    // POST /nodes
    if (request.method === 'POST' && path === '/nodes') {
      const { id, label, x, y, description, status } = await request.json()
      await env.DB.prepare('INSERT INTO nodes (id,label,x,y,description,status) VALUES (?,?,?,?,?,?)')
        .bind(id, label, x, y, description ?? null, status ?? 'planned').run()
      return json({ ok: true }, 201, corsHeaders)
    }

    // PATCH /nodes/:id
    if (request.method === 'PATCH' && segments[0] === 'nodes' && segments[1]) {
      const id = decodeURIComponent(segments[1])
      const { label, x, y, description, status } = await request.json()
      await env.DB.prepare('INSERT OR REPLACE INTO nodes (id,label,x,y,description,status) VALUES (?,?,?,?,?,?)')
        .bind(id, label, x, y, description ?? null, status ?? 'planned').run()
      return json({ ok: true }, 200, corsHeaders)
    }

    // DELETE /nodes/:id
    if (request.method === 'DELETE' && segments[0] === 'nodes' && segments[1]) {
      const id = decodeURIComponent(segments[1])
      await env.DB.batch([
        env.DB.prepare('DELETE FROM edges WHERE source=? OR target=?').bind(id, id),
        env.DB.prepare('DELETE FROM nodes WHERE id=?').bind(id),
      ])
      return json({ ok: true }, 200, corsHeaders)
    }

    // POST /edges
    if (request.method === 'POST' && path === '/edges') {
      const { id, source, target } = await request.json()
      await env.DB.prepare('INSERT OR IGNORE INTO edges (id,source,target) VALUES (?,?,?)')
        .bind(id, source, target).run()
      return json({ ok: true }, 201, corsHeaders)
    }

    // DELETE /edges/:id
    if (request.method === 'DELETE' && segments[0] === 'edges' && segments[1]) {
      const id = decodeURIComponent(segments[1])
      await env.DB.prepare('DELETE FROM edges WHERE id=?').bind(id).run()
      return json({ ok: true }, 200, corsHeaders)
    }

    return json({ error: 'Not found' }, 404, corsHeaders)
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env))
  },
}