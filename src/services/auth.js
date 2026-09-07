/**
 * Smart Optica — Service d'authentification (JWT)
 */

const TOKEN_KEY = 'so_token'
const USER_KEY = 'so_user'

export function getToken() { return localStorage.getItem(TOKEN_KEY) }
export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null }
}

export function storeSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

async function request(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || 'Erreur serveur')
  return data
}

export async function register(email, name, password) {
  const user = await request('/api/auth/register', { email, name, password })
  return user
}

export async function login(email, password) {
  const data = await request('/api/auth/login', { email, password })
  storeSession(data.access_token, data.user)
  return data.user
}

/** Vérifie le token auprès du backend. Retourne le user ou null. */
export async function fetchMe() {
  const token = getToken()
  if (!token) return null
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) { clearSession(); return null }
    return await res.json()
  } catch {
    return null
  }
}
