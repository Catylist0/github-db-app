import { storeToken, getToken, login, isAuthenticated } from './auth/github'

async function extractTokenFromHash(): Promise<void> {
  const hash = window.location.hash
  if (!hash.startsWith('#token=')) return
  const token = hash.slice('#token='.length)
  if (token) {
    storeToken(token)
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}

async function fetchUsername(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch user: ${res.status}`)
  const user = await res.json() as { login: string }
  return user.login
}

async function render(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return

  await extractTokenFromHash()

  if (!isAuthenticated()) {
    app.innerHTML = `
      <p>Not logged in</p>
      <button id="login-btn">Login with GitHub</button>
    `
    document.getElementById('login-btn')?.addEventListener('click', login)
    return
  }

  app.innerHTML = '<p>Loading user info...</p>'
  try {
    const username = await fetchUsername(getToken()!)
    app.innerHTML = `
      <p>Logged in as <strong>${username}</strong></p>
    `
  } catch {
    app.innerHTML = '<p>Logged in — could not fetch username</p>'
  }
}

render()
