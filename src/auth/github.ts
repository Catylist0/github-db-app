// GitHub OAuth flow using the device flow or a proxy server.
// Stub — to be implemented once a backend proxy or GitHub App is configured.

export interface AuthState {
  token: string | null
  username: string | null
}

export function getAuthState(): AuthState {
  return {
    token: localStorage.getItem('gh_token'),
    username: localStorage.getItem('gh_username'),
  }
}

export function isAuthenticated(): boolean {
  return Boolean(getAuthState().token)
}

export async function initiateLogin(): Promise<void> {
  // TODO: implement OAuth device flow or redirect to proxy
  throw new Error('Auth not yet configured')
}

export function logout(): void {
  localStorage.removeItem('gh_token')
  localStorage.removeItem('gh_username')
}
