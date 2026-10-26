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
    // ⚠️ Le code HTTP est porté sur l'ERREUR, pas seulement noyé dans le message :
    // l'appelant doit pouvoir distinguer « le serveur a échoué » (500) de
    // « la détection n'a rien trouvé » — deux situations opposées pour
    // l'opticien, qui doit recadrer dans un cas et patienter dans l'autre.
    const err = new Error(`API calibration error: ${res.status}`)
    err.status = res.status
    throw err
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
 *
 * ⚠️ Aucune échelle n'est transmise : la détection est INDÉPENDANTE de la photo faciale (les
 * deux clichés sont pris à des distances différentes). Le backend mesure l'échelle sur les mires
 * latérales elles-mêmes (25,00 mm). L'endpoint accepte encore `scale_mm_per_px` comme simple
 * ordre d'essai, mais l'app n'a rien à lui donner.
 * @param {Blob} imageBlob
 */
export async function analyzeProfile(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'profile.jpg')

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
