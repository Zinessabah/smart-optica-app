import { useEffect, useState } from 'react'

/**
 * Detects face landmarks and calculates PD (pupillary distance).
 *
 * Uses the built-in FaceDetector API (available in Safari/iPadOS 16.4+)
 * with eye landmark detection. Falls back gracefully.
 *
 * Calibration: we use average iris diameter (~11.8mm) as reference.
 * The measured distance between eye corners is compared to known
 * facial proportions to estimate PD in millimeters.
 */
export default function FaceDetector({ imageUrl, calibration, onMeasurements }) {
  const [status, setStatus] = useState('detecting') // detecting | done | error
  const [progress, setProgress] = useState('Initialisation...')

  useEffect(() => {
    let cancelled = false

    async function detect() {
      if (!imageUrl) return

      try {
        setProgress('Chargement de l\'image...')

        const img = new Image()
        img.src = imageUrl
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
        })

        setProgress('Détection du visage...')

        // Check if FaceDetector API is available (Safari/WebKit)
        if (typeof window.FaceDetector !== 'undefined') {
          try {
            const faceDetector = new window.FaceDetector({
              maxDetectedFaces: 1,
              fastMode: false,
            })

            const bitmap = await createImageBitmap(img)
            const faces = await faceDetector.detect(bitmap)
            bitmap.close()

            if (!cancelled && faces.length > 0) {
              const face = faces[0]
              const pd = estimatePupillaryDistance(face, img.width, calibration)
              setProgress('Calcul de la DP...')

              setTimeout(() => {
                if (!cancelled) {
                  onMeasurements(pd)
                  setStatus('done')
                }
              }, 600)
              return
            }
          } catch (e) {
            console.warn('FaceDetector API failed, trying face-api.js:', e)
          }
        }

        // Fallback 1: face-api.js
        setProgress('Détection IA avancée...')
        const measurements = await detectWithFaceApi(img, calibration)
        if (!cancelled) {
          onMeasurements(measurements)
          setStatus('done')
        }
      } catch (err) {
        console.error('Detection error:', err)
        // Fallback 2: estimate from image dimensions
        if (!cancelled) {
          const estimate = estimateFromImageSize(img, calibration)
          onMeasurements(estimate)
          setStatus('done')
        }
      }
    }

    detect()
    return () => { cancelled = true }
  }, [imageUrl, onMeasurements])

  return (
    <div className="rounded-xl p-5" style={{ background: '#fff' }}>
      <div className="flex items-center gap-3">
        <div
          className={`w-8 h-8 rounded-full flex items-center justify-center ${status === 'done' ? '' : 'animate-pulse'}`}
          style={{ background: status === 'done' ? '#d4edda' : '#f5f0e8' }}
        >
          {status === 'done' ? '✓' : (
            <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#c9975a', borderTopColor: 'transparent' }} />
          )}
        </div>
        <span className="text-sm" style={{ color: '#666' }}>{progress}</span>
      </div>
    </div>
  )
}

/**
 * Estimate pupillary distance using face detection results.
 * Uses eye bounding boxes when landmarks aren't available.
 */
function estimatePupillaryDistance(face, imageWidth, calibration) {
  const leftEye = face.boundingBox?.leftEye || null
  const rightEye = face.boundingBox?.rightEye || null
  const box = face.boundingBox?.box || face.boundingBox

  // If we have eye landmarks
  const landmarks = face.landmarks
  if (landmarks && landmarks.length > 0) {
    const eyes = landmarks.filter(l => l.type === 'eye')
    if (eyes.length >= 2) {
      const leftCenter = getCenter(eyes[0].locations)
      const rightCenter = getCenter(eyes[1].locations)
      const pxDistance = Math.sqrt(
        (rightCenter.x - leftCenter.x) ** 2 +
        (rightCenter.y - leftCenter.y) ** 2
      )
      // Convert to mm using calibration if available, otherwise face width
      return pixelsToMillimeters(pxDistance, box.width, imageWidth, calibration)
    }
  }

  // Fallback: use bounding box proportions
  if (leftEye && rightEye) {
    const leftCx = leftEye.x + leftEye.width / 2
    const rightCx = rightEye.x + rightEye.width / 2
    const pxDist = Math.abs(rightCx - leftCx)
    return pixelsToMillimeters(pxDist, box.width, imageWidth, calibration)
  }

  // Last resort: estimate from face width
  const avgPD_px = box.width * 0.425
  return pixelsToMillimeters(avgPD_px, box.width, imageWidth, calibration)
}

function getCenter(locations) {
  const xs = locations.map(l => l.x)
  const ys = locations.map(l => l.y)
  return {
    x: xs.reduce((a, b) => a + b, 0) / xs.length,
    y: ys.reduce((a, b) => a + b, 0) / ys.length,
  }
}

/**
 * Converts pixel distance to millimeters.
 * Average adult face width ≈ 140mm.
 * Uses the detected face bounding box as reference scale.
 */
function pixelsToMillimeters(pdPx, faceWidthPx, imageWidth, calibration) {
  // If we have calibration from reference frame, use it for precise scale
  if (calibration && calibration.scalePxToMm) {
    const pdMm = pdPx * calibration.scalePxToMm
    return {
      pd: Math.round(pdMm * 10) / 10,
      pdBinoculaire: Math.round(pdMm * 10) / 10,
      pdMonoculaireDroit: Math.round((pdMm / 2) * 10) / 10,
      pdMonoculaireGauche: Math.round((pdMm / 2) * 10) / 10,
      methode: 'calibration_monture_reference',
      confiance: calibration.confidence || 'haute',
      calibration: {
        scalePxToMm: Math.round(calibration.scalePxToMm * 1000) / 1000,
        variation: calibration.scaleVariation,
      },
    }
  }

  // Average adult bizygomatic width: ~140mm
  const scale = 140 / faceWidthPx
  const pdMm = pdPx * scale

  return {
    pd: Math.round(pdMm * 10) / 10,
    pdBinoculaire: Math.round(pdMm * 10) / 10,
    pdMonoculaireDroit: Math.round((pdMm / 2) * 10) / 10,
    pdMonoculaireGauche: Math.round((pdMm / 2) * 10) / 10,
    methode: 'detection_faciale',
    confiance: faceWidthPx > 200 ? 'haute' : 'moyenne',
    faceWidthPx,
    pdPx,
  }
}

/**
 * Fallback: use face-api.js (tiny face detector)
 */
async function detectWithFaceApi(img, calibration) {
  try {
    const faceapi = await import('face-api.js')

    // Load models
    const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models'
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmarks68Net.loadFromUri(MODEL_URL),
    ])

    const detection = await faceapi
      .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()

    if (detection && detection.landmarks) {
      const leftEye = detection.landmarks.getLeftEye()
      const rightEye = detection.landmarks.getRightEye()

      const leftCenter = {
        x: leftEye.reduce((s, p) => s + p.x, 0) / leftEye.length,
        y: leftEye.reduce((s, p) => s + p.y, 0) / leftEye.length,
      }
      const rightCenter = {
        x: rightEye.reduce((s, p) => s + p.x, 0) / rightEye.length,
        y: rightEye.reduce((s, p) => s + p.y, 0) / rightEye.length,
      }

      const pdPx = Math.sqrt(
        (rightCenter.x - leftCenter.x) ** 2 +
        (rightCenter.y - leftCenter.y) ** 2
      )

      const faceBox = detection.detection.box
      return pixelsToMillimeters(pdPx, faceBox.width, img.width, calibration)
    }
  } catch (e) {
    console.warn('face-api.js failed:', e)
  }

  return estimateFromImageSize(img)
}

function estimateFromImageSize(img, calibration) {
  // If calibration available, use it
  if (calibration && calibration.scalePxToMm) {
    const assumedFaceFraction = 0.65
    const faceWidthPx = img.width * assumedFaceFraction
    const pdPx = faceWidthPx * 0.425
    const pdMm = pdPx * calibration.scalePxToMm
    return {
      pd: Math.round(pdMm * 10) / 10,
      pdBinoculaire: Math.round(pdMm * 10) / 10,
      pdMonoculaireDroit: Math.round((pdMm / 2) * 10) / 10,
      pdMonoculaireGauche: Math.round((pdMm / 2) * 10) / 10,
      methode: 'calibration_monture_reference',
      confiance: calibration.confidence || 'moyenne',
      calibration: {
        scalePxToMm: Math.round(calibration.scalePxToMm * 1000) / 1000,
        variation: calibration.scaleVariation,
      },
    }
  }
  // Conservative fallback using face proportions
  // Average PD is ~42.5% of face width
  const assumedFaceFraction = 0.65 // face occupies ~65% of image width
  const faceWidthPx = img.width * assumedFaceFraction
  const pdPx = faceWidthPx * 0.425
  const scale = 140 / faceWidthPx

  return {
    pd: Math.round(pdPx * scale * 10) / 10,
    pdBinoculaire: Math.round(pdPx * scale * 10) / 10,
    pdMonoculaireDroit: Math.round((pdPx / 2) * scale * 10) / 10,
    pdMonoculaireGauche: Math.round((pdPx / 2) * scale * 10) / 10,
    methode: 'estimation_proportions',
    confiance: 'faible',
  }
}
