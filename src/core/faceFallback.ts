/**
 * Détection faciale multi-backend pour le guide de cadrage caméra.
 * Priorité : FaceDetector natif (Chrome) → face-api.js local (iPad) → proportions.
 * Fonctions pures testables ; le chargement des modèles est géré côté intégration.
 */

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

interface ImageSize {
  width: number
  height: number
}

/**
 * Normalise une détection (face-api ou native) en bounding box {x,y,width,height}.
 * Accepte soit `{ detection: { box } }` (face-api) soit `{ box }` directement.
 */
export function normalizeDetectionBox(input: unknown): FaceBox | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as { detection?: { box?: FaceBox | null } | null; box?: FaceBox | null }
  const box = (obj.detection && obj.detection.box) || obj.box
  if (!box) return null
  const { x, y, width, height } = box
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * Estime une box de visage par proportions géométriques (fallback sans ML).
 * Visage centré horizontalement, dans le tiers supérieur, largeur ~12% de l'image.
 */
export function buildProportionBox(imageSize: ImageSize): FaceBox | null {
  if (!imageSize || !imageSize.width || !imageSize.height) return null
  const w = imageSize.width * 0.12
  const h = w * 1.25
  const cx = imageSize.width / 2
  const cy = imageSize.height * 0.42
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
}

// ── Intégration (non testée unitairement) ─────────────────────────
// Chargement paresseux des modèles face-api depuis /models (pré-cache local).
let faceApiPromise: Promise<unknown> | null = null

async function loadFaceApi() {
  if (!faceApiPromise) {
    faceApiPromise = import('face-api.js').then(async (fa: any) => {
      await fa.nets.tinyFaceDetector.loadFromUri('/models')
      await fa.nets.faceLandmarks68Net.loadFromUri('/models')
      return fa
    })
  }
  return faceApiPromise
}

/**
 * Détecte la bounding box du visage sur une vidéo, avec fallback face-api local
 * quand l'API native `FaceDetector` est absente (cas iPad/Safari).
 * @param videoElement - élément <video> alimenté par le flux caméra
 * @returns {Promise<FaceBox|null>}
 */
export async function detectFaceBoxFromVideo(videoElement: HTMLVideoElement): Promise<FaceBox | null> {
  try {
    const fa: any = await loadFaceApi()
    const opts = new fa.TinyFaceDetectorOptions()
    const detection = await fa.detectSingleFace(videoElement, opts)
    if (!detection) return null
    // detection.detection.box (format face-api) OU detection.box
    const raw = detection.detection?.box ?? detection.box
    const box = normalizeDetectionBox({ box: raw })
    return box
  } catch (err) {
    console.warn('[faceFallback] face-api détection échouée:', (err as Error).message)
    return null
  }
}
