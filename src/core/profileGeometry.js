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

export function isProfileMeasurementReady(anglePoints, vertexLine, vertexMm, vertexLoading, vertexAdjusted) {
  return Boolean(
    anglePoints?.length >= 3 &&
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
