/**
 * Angle d'inclinaison de la réglette par rapport à l'HORIZONTALE.
 *
 * La réglette est symétrique : la retourner de 180° redonne exactement le même
 * tracé (mêmes graduations, mêmes index). On ramène donc la rotation brute à
 * l'intervalle ]-90°, +90°] :
 *    0°   = réglette horizontale
 *   +90°  = réglette verticale (sens horaire, repère écran avec y vers le bas)
 *   -45°  = inclinée de 45° dans l'autre sens
 *
 * Aucune valeur empirique : simple normalisation angulaire.
 */
export function inclinationFromRotation(rotationDeg: number): number {
  if (!Number.isFinite(rotationDeg)) return 0
  let a = ((rotationDeg % 180) + 180) % 180   // → [0, 180[
  if (a > 90) a -= 180                        // → ]-90, 90]
  return Object.is(a, -0) ? 0 : a
}

/** Formatage signé et lisible : « 0.0° », « +12.3° », « -45.0° ». */
export function formatInclination(rotationDeg: number, digits = 1): string {
  const a = inclinationFromRotation(rotationDeg)
  return `${a > 0 ? '+' : ''}${a.toFixed(digits)}°`
}
