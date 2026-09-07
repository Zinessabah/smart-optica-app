/**
 * Persistance de session Smart Optica — fonctions pures (testables).
 * Sauvegarde l'état du flux (calibration, mesures, images) dans localStorage
 * pour permettre la reprise après refresh, avec validation des prérequis.
 */

export const SESSION_KEY = 'smart-optica:session:v1'

export interface SessionState {
  step: string
  photoSource?: string | null
  imageData?: string | null
  profileImageUrl?: string | null
  calibration?: Record<string, unknown> | null
  measurements?: Record<string, unknown> | null
  faceData?: Record<string, unknown> | null
  savedAt?: number
}

/**
 * Étapes qui nécessitent les prérequis listés pour être resumables.
 * imageData = photo de FACE ; profileImageUrl = photo de PROFIL.
 */
const STEP_REQUIREMENTS: Record<string, string[]> = {
  photo: [],
  'photo-lateral': ['imageData'],
  calibrate: ['imageData'],
  pupils: ['imageData'], // la calibration peut être skippée → non exigée
  'profile-measure': ['profileImageUrl', 'imageData'],
  result: ['measurements'],
}

/**
 * Sérialise l'état vers une chaîne JSON prête pour localStorage.
 */
export function serializeSession(state: SessionState): string | null {
  if (!state) return null
  const clean: SessionState = {
    step: state.step,
    photoSource: state.photoSource ?? null,
    imageData: state.imageData ?? null,
    profileImageUrl: state.profileImageUrl ?? null,
    calibration: state.calibration ?? null,
    measurements: state.measurements ?? null,
    faceData: state.faceData ?? null,
    savedAt: Date.now(),
  }
  try {
    return JSON.stringify(clean)
  } catch {
    return null // trop gros (quota) — on ne persiste rien
  }
}

/**
 * Restaure un état depuis une chaîne JSON. Retourne null si la donnée est
 * illisible (corrompue, absente, ou structure invalide).
 */
export function restoreSession(raw: string | null): SessionState | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const state = parsed as SessionState
  if (typeof state.step !== 'string') return null
  return state
}

/**
 * Vérifie qu'une étape peut être reprise (tous ses prérequis présents).
 * 'home' et 'photo' sont toujours resumables.
 */
export function isStepResumable(step: string, state: SessionState | null): boolean {
  if (!state) return false
  if (step === 'home' || step === 'photo') return true
  const needs = STEP_REQUIREMENTS[step]
  if (!needs) return false // étape inconnue → on repart de zéro
  return needs.every((key) => Boolean(state[key as keyof SessionState]))
}
