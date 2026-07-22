/**
 * Validation des mesures optiques — seuils & règles métier
 * Séparé pour être testable unitairement
 */

/**
 * Seuils de validation (configurables)
 */
export const VALIDATION_THRESHOLDS = {
  // DP binoculaire adulte normal
  PD_BINOC_MIN: 50,
  PD_BINOC_MAX: 75,
  // Tolérance somme monoculaires vs binoculaire
  PD_SUM_TOLERANCE: 3,
  // Pont (EIV) réaliste
  PONT_MIN: 5,
  PONT_MAX: 40
}

/**
 * Valide un ensemble de mesures
 * @param {Object} measurements - { pd, pdMonoculaireGauche, pdMonoculaireDroit, pont }
 * @param {Object} [thresholds] - Seuils personnalisés (optionnel)
 * @returns {Object} { valid, issues, level }
 *   level: 'ok' | 'warning' | 'error'
 */
export function validateMeasurements(measurements, thresholds = VALIDATION_THRESHOLDS) {
  const issues = []

  const { pd, pdMonoculaireGauche, pdMonoculaireDroit, pont } = measurements

  // DP binoculaire
  if (pd != null) {
    if (pd < thresholds.PD_BINOC_MIN) {
      issues.push({ code: 'PD_BINOC_LOW', message: `DP binoculaire anormalement basse (< ${thresholds.PD_BINOC_MIN}mm)`, severity: 'error' })
    } else if (pd > thresholds.PD_BINOC_MAX) {
      issues.push({ code: 'PD_BINOC_HIGH', message: `DP binoculaire anormalement haute (> ${thresholds.PD_BINOC_MAX}mm)`, severity: 'error' })
    }
  }

  // Cohérence monoculaires vs binoculaire
  if (pdMonoculaireGauche != null && pdMonoculaireDroit != null && pd != null) {
    const sum = pdMonoculaireGauche + pdMonoculaireDroit
    const diff = Math.abs(sum - pd)
    if (diff > thresholds.PD_SUM_TOLERANCE) {
      issues.push({
        code: 'PD_SUM_MISMATCH',
        message: `Somme des monoculaires (${sum.toFixed(1)}mm) incohérente avec la DP binoculaire (${pd}mm)`,
        severity: 'warning'
      })
    }
  }

  // Pont (EIV)
  if (pont != null) {
    if (pont < thresholds.PONT_MIN || pont > thresholds.PONT_MAX) {
      issues.push({
        code: 'PONT_OUT_OF_RANGE',
        message: `Écart inter-verres (pont) hors norme (${thresholds.PONT_MIN}-${thresholds.PONT_MAX}mm)`,
        severity: 'error'
      })
    }
  }

  // Niveau global
  const hasError = issues.some(i => i.severity === 'error')
  const hasWarning = issues.some(i => i.severity === 'warning')

  return {
    valid: !hasError, // valid = pas d'erreurs (warnings OK)
    issues,
    level: hasError ? 'error' : hasWarning ? 'warning' : 'ok'
  }
}

/**
 * Détermine la couleur d'affichage selon le niveau
 * @param {string} level - 'ok' | 'warning' | 'error'
 * @returns {string} classe CSS ou couleur
 */
export function getValidationColor(level) {
  switch (level) {
    case 'error': return 'var(--color-red)'
    case 'warning': return 'var(--color-gold)'
    default: return 'var(--color-green)'
  }
}

/**
 * Détermine l'icône selon le niveau
 * @param {string} level
 * @returns {string} nom icône lucide
 */
export function getValidationIcon(level) {
  switch (level) {
    case 'error': return 'AlertCircle'
    case 'warning': return 'AlertTriangle'
    default: return 'CheckCircle2'
  }
}