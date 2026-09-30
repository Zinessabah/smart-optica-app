export function calculatePantoscopicAngle(points) {
  if (!points || points.length < 3) return null
  const [branchEnd, vertex, lensPlaneEnd] = points
  const branchLength = Math.hypot(branchEnd.x - vertex.x, branchEnd.y - vertex.y)
  const lensLength = Math.hypot(lensPlaneEnd.x - vertex.x, lensPlaneEnd.y - vertex.y)
  if (branchLength <= 0 || lensLength <= 0) return null
  const v1 = Math.atan2(branchEnd.y - vertex.y, branchEnd.x - vertex.x) * 180 / Math.PI
  const v2 = Math.atan2(lensPlaneEnd.y - vertex.y, lensPlaneEnd.x - vertex.x) * 180 / Math.PI
  let rawAngle = Math.abs(v2 - v1)
  if (rawAngle > 180) rawAngle = 360 - rawAngle
  const deviation = Math.abs(rawAngle - 90)
  return Math.round(Math.max(0, Math.min(30, deviation)) * 10) / 10
}

/**
 * Pantoscopie quand la BRANCHE est une référence MESURÉE (voie A).
 *
 * Les 2 mires BASSES du clip sont dans l'axe avant-arrière de la branche : leur droite EST donc
 * la direction de la branche, mesurée sur la photo — plus besoin de la poser au doigt. L'angle
 * pantoscopique est l'écart à 90° entre cette référence et LA LIGNE DU VERRE (2 points posés).
 *
 * Deux gains sur la méthode à 3 points :
 *   · un geste en moins ;
 *   · le roulis de l'appareil s'annule — les deux directions sont mesurées dans la MÊME image.
 * Sensibilité résiduelle au lacet : 0,18° pour 20° de lacet (mesuré sur les cotes du clip).
 *
 * @param {Array<{x:number,y:number}>} lensPoints - 2 points sur le plan du verre
 * @param {Array<{x:number,y:number}>} basePoints - les 2 mires basses, MESURÉES
 * @returns {number|null} écart à 90° en degrés (0-30), ou null si indéfini
 */
export function calculatePantoscopicAngleWithBase(lensPoints, basePoints) {
  if (!lensPoints || lensPoints.length < 2 || !basePoints || basePoints.length < 2) return null
  const [l0, l1] = lensPoints
  const [b0, b1] = basePoints
  const lensLength = Math.hypot(l1.x - l0.x, l1.y - l0.y)
  const baseLength = Math.hypot(b1.x - b0.x, b1.y - b0.y)
  if (lensLength <= 0 || baseLength <= 0) return null
  const angleLens = Math.atan2(l1.y - l0.y, l1.x - l0.x) * 180 / Math.PI
  const angleBase = Math.atan2(b1.y - b0.y, b1.x - b0.x) * 180 / Math.PI
  let raw = Math.abs(angleLens - angleBase)
  if (raw > 180) raw = 360 - raw
  // Deux DROITES : leur angle est dans [0, 90] — la ligne du verre n'a pas de sens de parcours.
  if (raw > 90) raw = 180 - raw
  const deviation = Math.abs(raw - 90)
  return Math.round(Math.max(0, Math.min(30, deviation)) * 10) / 10
}

export function isProfileMeasurementReady(anglePoints, vertexLine, vertexMm, vertexLoading, vertexAdjusted, requiredAnglePoints = 3) {
  return Boolean(
    anglePoints?.length >= requiredAnglePoints &&
    vertexLine?.length === 2 &&
    vertexAdjusted &&
    Number.isFinite(vertexMm) &&
    vertexMm > 0 &&
    !vertexLoading
  )
}

/**
 * Décide si le vertex doit être recalculé après le drag d'un point.
 * Une mire latérale (`verify`) ou un point vertex (`vertex`) modifie l'échelle/la mesure
 * → invalide le vertex. Un point d'angle (`angle`) n'y touche pas.
 * @param {string} ptType - 'verify' | 'vertex' | 'angle'
 * @param {boolean} dragged - le drag a réellement déplacé quelque chose
 * @returns {boolean}
 */
export function shouldRecomputeVertexAfterDrag(ptType, dragged) {
  if (!dragged) return false
  return ptType === 'verify' || ptType === 'vertex'
}
