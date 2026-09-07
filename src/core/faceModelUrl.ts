/**
 * Résolution de l'URL des modèles face-api — pré-cache local prioritaire.
 *
 * Les modèles (tinyFaceDetector + faceLandmarks68) sont empaquetés dans `public/models/`
 * (servis par Vite à `/models`). On les charge d'abord localement (démarrage hors-ligne),
 * et on ne retombe sur le CDN que si les modèles locaux sont absents.
 */

export const LOCAL_MODELS_URL = '/models'
export const CDN_MODELS_URL = 'https://justadudewhohacks.github.io/face-api.js/models'

export interface ResolveOpts {
  useLocal?: boolean
}

/**
 * Choisit l'URL de base des modèles face-api.
 */
export function resolveFaceApiModelsUrl(opts: ResolveOpts = {}): string {
  // Par défaut, on préfère les modèles locaux — mais si le flag est explicitement
  // à false, on retombe sur le CDN.
  return opts.useLocal === false ? CDN_MODELS_URL : LOCAL_MODELS_URL
}
