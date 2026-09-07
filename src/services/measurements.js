/**
 * Smart Optica — Service Historique des mesures
 */
const headers = () => ({
  Authorization: `Bearer ${localStorage.getItem('so_token')}`,
})

export async function saveMeasurement({ results, patientName, patientPhone, patientEmail, frameRef, notes, faceImage, profileImage }) {
  const fd = new FormData()
  fd.append('results', JSON.stringify(results))
  if (patientName) fd.append('patient_name', patientName)
  if (patientPhone) fd.append('patient_phone', patientPhone)
  if (patientEmail) fd.append('patient_email', patientEmail)
  if (frameRef) fd.append('frame_ref', frameRef)
  if (notes) fd.append('notes', notes)
  if (faceImage) fd.append('face_image', faceImage)
  if (profileImage) fd.append('profile_image', profileImage)
  const res = await fetch('/api/measurements', { method: 'POST', headers: headers(), body: fd })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur sauvegarde')
  return res.json()
}

export async function listMeasurements({ limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit, offset })
  const res = await fetch(`/api/measurements?${params}`, { headers: headers() })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur liste')
  return res.json()
}

export async function getMeasurement(id) {
  const res = await fetch(`/api/measurements/${id}`, { headers: headers() })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur détail')
  return res.json()
}

export async function deleteMeasurement(id) {
  const res = await fetch(`/api/measurements/${id}`, { method: 'DELETE', headers: headers() })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur suppression')
  return true
}

/** Admin — liste toutes les mesures de tous les opticiens (réservé rôle admin).
 *  `user_id` optionnel pour filtrer par opticien. */
export async function listAllMeasurements({ user_id, limit = 100, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit, offset })
  if (user_id) params.set('user_id', user_id)
  const res = await fetch(`/api/measurements/admin/all?${params}`, { headers: headers() })
  if (!res.ok) throw new Error((await res.json()).detail || 'Erreur liste admin')
  return res.json()
}
