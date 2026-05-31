const CLIENT_ID = 'Ov23liyv0Lgo9rQNB1fU'

let _token: string | null = null

export function storeToken(token: string): void {
  _token = token
}

export function getToken(): string | null {
  return _token
}

export function isAuthenticated(): boolean {
  return _token !== null
}

export function login(): void {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('scope', 'read:user')
  window.location.href = url.toString()
}

export function logout(): void {
  _token = null
}
