/**
 * Smart Optica — API Service
 * Utilise le proxy Vite pour contacter le backend Python.
 */

import { fetchWithTimeout, LONG_TIMEOUT_MS } from '../core/http'
export async function analyzeCalibration(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'photo.jpg')

  const res = await fetchWithTimeout('/api/analyze-calibration', {
    method: 'POST',
    body: formData,
  }, LONG_TIMEOUT_MS)

  if (!res.ok) {
    throw new Error(`API calibration error: ${res.status}`)
  }

  return res.json()
}

export async function analyzeImage(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'photo.jpg')

  const res = await fetchWithTimeout('/api/analyze', {
    method: 'POST',
    body: formData,
  }, LONG_TIMEOUT_MS)

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }

  return res.json()
}

/**
 * Analyse la photo de PROFIL — détecte les 2 mires latérales du clip,
 * l'angle de la branche et la cornée, puis retourne les segments prêts
 * pour le placement auto dans ProfileMeasure.
 * @param {Blob} imageBlob
 * @param {number|null} scaleMmPerPx - échelle mm/px de la calibration frontale (facultatif)
 */
export async function analyzeProfile(imageBlob, scaleMmPerPx) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'profile.jpg')
  if (scaleMmPerPx) formData.append('scale_mm_per_px', String(scaleMmPerPx))

  const res = await fetchWithTimeout('/api/analyze-profile', {
    method: 'POST',
    body: formData,
  }, LONG_TIMEOUT_MS)

  if (!res.ok) {
    throw new Error(`API profile error: ${res.status}`)
  }

  return res.json()
}

export async function checkHealth() {
  try {
    const res = await fetchWithTimeout('/health')
    return res.ok
  } catch {
    return false
  }
}
