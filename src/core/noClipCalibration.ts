/**
 * Calibration sans clip — étalon de dépannage.
 * L'utilisateur place 2 points sur une distance réelle physiquement connue
 * (largeur monture, DP connue, objet de référence) et saisit cette distance en mm.
 * L'échelle px→mm est déduite : scale = knownMm / distancePx.
 */

export interface Point2D {
  x: number
  y: number
}

export interface NoClipScale {
  scalePxToMm: number
  distancePx: number
  headRotation: number
  method: 'no_clip'
}

/**
 * @param points - exactement 2 points [{x,y},{x,y}]
 * @param knownMm - distance réelle physiquement connue (mm)
 */
export function calibrateFromKnownDistance(points: Point2D[], knownMm: number): NoClipScale | null {
  if (!points || points.length !== 2) return null
  const [a, b] = points
  if (a == null || b == null) return null
  const distancePx = Math.hypot(b.x - a.x, b.y - a.y)
  if (distancePx <= 0) return null
  if (!knownMm || knownMm <= 0) return null

  return {
    scalePxToMm: knownMm / distancePx,
    distancePx: Math.round(distancePx),
    headRotation: 0,
    method: 'no_clip',
  }
}
