/**
 * Contrôle qualité photo (net / sombre / surexposée) — logique pure.
 * Le score est calculé sur un tableau de niveaux de gris (0-255) échantillonné
 * depuis un canvas. La décision est pure et testable.
 */

export type GrayArray = number[]
export type QualityVerdict = 'good' | 'blurry' | 'too_dark' | 'too_bright'
export interface ExposureScores {
  brightness: number
  contrast: number
}

/**
 * Netteté : variance du Laplacien 1D sur les niveaux de gris.
 * ~0 = image uniforme/floue ; élevé = beaucoup de transitions (net).
 */
export function scoreSharpness(gray: GrayArray): number {
  if (!gray || gray.length < 3) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let i = 1; i < gray.length; i++) {
    const lap = gray[i - 1] - 2 * gray[i] + (gray[i + 1] ?? gray[i])
    sum += lap
    sumSq += lap * lap
    n += 1
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

/**
 * Exposition : luminance moyenne + contraste (écart-type).
 */
export function scoreExposure(gray: GrayArray): ExposureScores {
  if (!gray || gray.length === 0) return { brightness: 0, contrast: 0 }
  const n = gray.length
  const mean = gray.reduce((a, b) => a + b, 0) / n
  const variance = gray.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n
  return {
    brightness: Math.round(mean),
    contrast: Math.round(Math.sqrt(variance)),
  }
}

/**
 * Décide la qualité d'une photo à partir des scores de netteté et d'exposition.
 */
export function decidePhotoQuality(scores: ExposureScores & { sharpness: number }): QualityVerdict {
  const { sharpness, brightness } = scores
  if (sharpness < 12) return 'blurry'
  if (brightness < 40) return 'too_dark'
  if (brightness > 225) return 'too_bright'
  return 'good'
}

/**
 * Message d'aide associé à chaque verdict qualité.
 */
export function photoQualityMessage(verdict: QualityVerdict): string {
  switch (verdict) {
    case 'good': return '✅ Photo de bonne qualité'
    case 'blurry': return '🌫 Photo floue — maintenez la caméra stable'
    case 'too_dark': return '🌑 Photo trop sombre — augmentez la lumière'
    case 'too_bright': return '☀️ Photo surexposée — réduisez la lumière'
    default: return ''
  }
}
