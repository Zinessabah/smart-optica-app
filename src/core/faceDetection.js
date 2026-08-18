/**
 * Détection faciale multi-fallback — logique pure (sans React)
 * 1. Native FaceDetector API (Chrome/Edge)
 * 2. face-api.js (tinyFaceDetector + 68 landmarks)
 * 3. Estimation par proportions (fallback final)
 */

const FACE_API_MODELS_URL = 'https://justadudewhohacks.github.io/face-api.js/models'
const FACE_API_LOADED = { tiny: false, landmarks: false }

/**
 * URI des modèles face-api.js — local d'abord (public/models), CDN en secours.
 * En dev, `window.location.origin + '/models'` sert les fichiers copiés dans
 * public/models ; en production, s'ils sont absents, on retombe sur le CDN.
 */
function getModelsUri() {
  try {
    const origin = window.location.origin || ''
    const local = origin + '/models'
    // Vérification synchrone (le manifest est servi au premier chargement) :
    // on fait confiance au chemin local — il existe dans public/models.
    return local
  } catch {
    return FACE_API_MODELS_URL
  }
}

/**
 * Détecte visage + landmarks via API native
 * @param {HTMLImageElement} img
 * @returns {Promise<Object|null>} { leftEye, rightEye, nose } ou null
 */
export async function detectWithNativeAPI(img) {
  if (typeof window === 'undefined' || !window.FaceDetector) return null

  try {
    const detector = new window.FaceDetector({ maxDetectedFaces: 1, fastMode: false })
    const bitmap = await createImageBitmap(img)
    const faces = await detector.detect(bitmap)

    if (!faces.length) return null

    const face = faces[0]
    const landmarks = face.landmarks

    if (!landmarks || !landmarks.length) {
      // Fallback: estimation depuis bounding box
      const b = face.boundingBox
      const cx = b.x + b.width * 0.5
      const cy = b.y + b.height * 0.62
      return {
        leftEye: { x: b.x + b.width * 0.29, y: b.y + b.height * 0.42 },
        rightEye: { x: b.x + b.width * 0.71, y: b.y + b.height * 0.42 },
        nose: { x: cx, y: cy }
      }
    }

    const eyes = landmarks.filter(l => l.type === 'eye')
    const nose = landmarks.filter(l => l.type === 'nose')

    if (eyes.length >= 2 && nose.length > 0) {
      return {
        leftEye: { x: eyes[0].locations.x, y: eyes[0].locations.y },
        rightEye: { x: eyes[1].locations.x, y: eyes[1].locations.y },
        nose: { x: nose[0].locations.x, y: nose[0].locations.y }
      }
    }

    return null
  } catch (e) {
    console.warn('[faceDetection] Native API failed:', e.message)
    return null
  }
}

/**
 * Charge les modèles face-api.js (une seule fois).
 * Priorité : modèles locaux (public/models) → CDN en secours.
 */
async function ensureFaceApiModels() {
  if (FACE_API_LOADED.tiny && FACE_API_LOADED.landmarks) return

  const fa = await import('face-api.js')
  const localUri = getModelsUri()

  const loadAll = (uri) => Promise.all([
    fa.nets.tinyFaceDetector.loadFromUri(uri),
    fa.nets.faceLandmarks68Net.loadFromUri(uri),
  ])

  try {
    if (!FACE_API_LOADED.tiny || !FACE_API_LOADED.landmarks) {
      await loadAll(localUri)
    }
  } catch (e) {
    console.warn('[faceDetection] Modèles locaux indisponibles, fallback CDN:', e.message)
    await loadAll(FACE_API_MODELS_URL)
  }

  FACE_API_LOADED.tiny = true
  FACE_API_LOADED.landmarks = true
  return fa
}

/**
 * Détecte visage + landmarks via face-api.js
 * @param {HTMLImageElement} img
 * @returns {Promise<Object|null>} { leftEye, rightEye, nose } ou null
 */
export async function detectWithFaceApi(img) {
  if (typeof window === 'undefined') return null

  try {
    const fa = await ensureFaceApiModels()
    const detection = await fa.detectSingleFace(img, new fa.TinyFaceDetectorOptions()).withFaceLandmarks()

    if (!detection || !detection.landmarks) return null

    const lm = detection.landmarks
    const leftEye = lm.getLeftEye()
    const rightEye = lm.getRightEye()
    const nose = lm.getNose()

    // Centre des yeux (moyenne des 6 points par œil)
    const avg = (points) => ({
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length
    })

    return {
      leftEye: avg(leftEye),
      rightEye: avg(rightEye),
      nose: nose && nose.length >= 3 ? avg(nose.slice(0, 4)) : null
    }
  } catch (e) {
    console.warn('[faceDetection] face-api.js failed:', e.message)
    return null
  }
}

/**
 * Estimation par proportions géométriques (fallback sans ML)
 * @param {Object} imageSize - { width, height }
 * @returns {Object} { leftEye, rightEye, nose }
 */
export function estimateByProportions(imageSize) {
  const mx = imageSize.width / 2
  const my = imageSize.height * 0.42
  const d = imageSize.width * 0.12

  return {
    leftEye: { x: mx - d, y: my },
    rightEye: { x: mx + d, y: my },
    nose: { x: mx, y: my + d * 0.9 }
  }
}

/**
 * Pipeline complète détection faciale avec fallback cascade
 * @param {HTMLImageElement} img
 * @param {Object} imageSize - { width, height }
 * @returns {Promise<Object>} { leftEye, rightEye, nose, method }
 */
export async function detectFace(img, imageSize) {
  // 1. Native API
  const native = await detectWithNativeAPI(img)
  if (native) return { ...native, method: 'native' }

  // 2. face-api.js
  const fa = await detectWithFaceApi(img)
  if (fa) return { ...fa, method: 'face-api' }

  // 3. Proportions
  return { ...estimateByProportions(imageSize), method: 'proportions' }
}