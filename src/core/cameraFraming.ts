/**
 * Classification du cadrage caméra — fonction pure (testable).
 * À partir de la bounding box d'un visage détecté et des dimensions vidéo,
 * décide si le cadrage est correct ou pourquoi il ne l'est pas.
 */

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export type FramingVerdict = 'ok' | 'too_far' | 'too_close' | 'too_offset' | 'none'

export interface FramingInput {
  box: FaceBox | null
  videoWidth: number
  videoHeight: number
}

export function classifyCameraFraming({ box, videoWidth, videoHeight }: FramingInput): FramingVerdict {
  if (!box || !videoWidth || !videoHeight) return 'none'

  const area = (box.width * box.height) / (videoWidth * videoHeight)
  const cx = (box.x + box.width / 2) / videoWidth
  const cy = (box.y + box.height / 2) / videoHeight

  // Trop loin : visage réduit (< 8% de surface) → détection peu fiable
  if (area < 0.08) return 'too_far'
  // Trop près : visage qui déborde (> 55% de surface) → clip/cadre hors champ
  if (area > 0.55) return 'too_close'
  // Excentré : centre du visage hors de la zone centrale
  if (cx < 0.25 || cx > 0.75 || cy < 0.2 || cy > 0.7) return 'too_offset'

  return 'ok'
}

/**
 * Message d'aide contextuel pour chaque verdict.
 */
export function framingGuideMessage(verdict: FramingVerdict): string {
  switch (verdict) {
    case 'ok': return '✅ Visage bien cadré — placez le clip de calibration'
    case 'too_far': return '📏 Trop loin — approchez la caméra'
    case 'too_close': return '🙂 Trop près — reculez un peu'
    case 'too_offset': return '🎯 Visage excentré — centrez-vous dans le cadre'
    case 'none':
    default: return '🎭 Alignez le visage dans le cadre · Placez le clip de calibration'
  }
}
