/**
 * Smart Optica — Service Admin (gestion des comptes)
 * Nécessite un token d'admin.
 */

const headers = () => ({
  Authorization: `Bearer ${localStorage.getItem('so_token')}`,
  'Content-Type': 'application/json',
})

export async function listUsers({ page = 1, per_page = 20, search = '' } = {}) {
  const params = new URLSearchParams({ page, per_page })
  if (search) params.set('search', search)
  const res = await fetch(`/api/admin/users?${params}`, { headers: headers() })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur liste')
  return res.json()
}

export async function createUser(data) {
  const res = await fetch('/api/admin/users', {
    method: 'POST', headers: headers(), body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur création')
  return res.json()
}

export async function updateUser(id, data) {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur modification')
  return res.json()
}

export async function resetPassword(id, newPassword) {
  const res = await fetch(`/api/admin/users/${id}/reset-password`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ new_password: newPassword }),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur reset')
  return res.json()
}

export async function deleteUser(id) {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: 'DELETE', headers: headers(),
  })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur suppression')
  return true
}
