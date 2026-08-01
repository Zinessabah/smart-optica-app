/**
 * Smart Optica — API Service
 * Utilise le proxy Vite pour contacter le backend Python.
 */

export async function analyzeCalibration(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'photo.jpg')

  const res = await fetch('/api/analyze-calibration', {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    throw new Error(`API calibration error: ${res.status}`)
  }

  return res.json()
}

export async function analyzeImage(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'photo.jpg')

  const res = await fetch('/api/analyze', {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }

  return res.json()
}

export async function analyzeProfile(imageBlob) {
  const formData = new FormData()
  formData.append('file', imageBlob, 'profile.jpg')

  const res = await fetch('/api/analyze-profile', {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    throw new Error(`API profile error: ${res.status}`)
  }

  return res.json()
}

export async function checkHealth() {
  try {
    const res = await fetch('/health')
    return res.ok
  } catch {
    return false
  }
}
