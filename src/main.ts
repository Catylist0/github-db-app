import { isAuthenticated } from './auth/github'

function render(): void {
  const app = document.getElementById('app')
  if (!app) return

  if (isAuthenticated()) {
    app.innerHTML = '<p>Authenticated — loading data...</p>'
    return
  }

  app.innerHTML = `
    <p>Placeholder — auth not yet configured</p>
    <button id="login-btn">Login with GitHub</button>
  `

  document.getElementById('login-btn')?.addEventListener('click', () => {
    alert('Auth flow not yet implemented.')
  })
}

render()
