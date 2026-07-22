/**
 * Optiques & calculs de centrage — logique métier pure (sans React)
 * Mapping convention : image gauche = patient OD (œil droit), image droite = patient OG (œil gauche)
 */

import { validateMeasurements } from './validation'

/**
 * Calcule l'échelle pixel→mm à partir des 3 repères de calibration
 * Distance totale Gauche↔Droite = 100mm (clip physique 3 mires × 50mm)
 * @param {Array} points - [{x,y}, {x,y}, {x,y}] dans l'ordre Gauche, Centre, Droite
 * @param {number} spacingMm - Écart entre mires adjacentes (défaut 50mm)
 * @returns {Object} { scalePxToMm, pixelDist1, pixelDist2, headRotation, poseAssessment, totalSpanMm }
 */
export function calculateScale(points, spacingMm = 50) {
  if (!points || points.length !== 3) {
    throw new Error('calculateScale nécessite exactement 3 points [gauche, centre, droite]')
  }

  // Distance géométrique directe Gauche → Droite (100mm physiques)
  const dTotal = Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y)
  const totalSpacingMm = spacingMm * 2
  const scalePxToMm = totalSpacingMm / dTotal

  // Analyse symétrie (rotation/inclinaison tête)
  const d1 = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) // G → C
  const d2 = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y) // C → D
  const ratio = Math.abs(d1 - d2) / ((d1 + d2) / 2)
  const headRotation = Math.round(ratio * 100)

  let poseAssessment = 'Excellente (Centrage 100%)'
  if (headRotation > 4) poseAssessment = `Bonne (Légère inclinaison ${headRotation}%)`
  if (headRotation > 10) poseAssessment = `Correction requise (Tête tournée à ${headRotation}%)`

  return {
    scalePxToMm,
    pixelDist1: Math.round(d1),
    pixelDist2: Math.round(d2),
    scaleVariation: 0, // Option chirurgicale : 0% d'erreur sur l'échelle
    headRotation,
    poseAssessment,
    totalSpanMm: totalSpacingMm
  }
}

/**
 * Calcule les DP monoculaires par projection sur l'axe Centre Nez
 * @param {Object} leftEye - {x,y} côté gauche image = patient OD
 * @param {Object} rightEye - {x,y} côté droit image = patient OG
 * @param {Object} bridge - {x,y} centre du nez (haut du clip)
 * @param {number} scale - scalePxToMm
 * @returns {Object} { pdOD, pdOG, pdBinoc }
 */
export function calculateMonocularPD(leftEye, rightEye, bridge, scale) {
  if (!leftEye || !rightEye || !bridge || !scale) {
    return { pdOD: null, pdOG: null, pdBinoc: null }
  }

  // leftEye = côté gauche image = patient OD (œil droit)
  // rightEye = côté droit image = patient OG (œil gauche)
  const pdOD = Math.round(Math.hypot(leftEye.x - bridge.x, leftEye.y - bridge.y) * scale * 10) / 10
  const pdOG = Math.round(Math.hypot(rightEye.x - bridge.x, rightEye.y - bridge.y) * scale * 10) / 10
  const pdBinoc = Math.round(Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) * scale * 10) / 10

  return { pdOD, pdOG, pdBinoc }
}

/**
 * Calcule le Pont (EIV, écart inter-verres) via Boxing
 * boxOG = gauche image = verre OD, boxOD = droite image = verre OG
 * @param {Object} boxOG - {x, y, width, height}
 * @param {Object} boxOD - {x, y, width, height}
 * @param {number} scale - scalePxToMm
 * @returns {number|null} Pont en mm
 */
export function calculatePont(boxOG, boxOD, scale) {
  if (!boxOG || !boxOD || !scale) return null
  const wOG = Number(boxOG.width) || 0
  const wOD = Number(boxOD.width) || 0
  if (wOG <= 0 || wOD <= 0) return null

  // Bord nasal OG (côté droit du rectangle gauche image)
  const nasalOG = boxOG.x + wOG
  // Bord nasal OD (côté gauche du rectangle droit image)
  const nasalOD = boxOD.x
  const gapPx = Math.abs(nasalOG - nasalOD)
  return Math.round(gapPx * scale * 10) / 10
}

/**
 * Calcule les dimensions boxing (largeurs calibres, hauteurs montage)
 * @param {Object} boxOG - {x, y, width, height}
 * @param {Object} boxOD - {x, y, width, height}
 * @param {Object} leftEye - pupille OD (gauche image)
 * @param {Object} rightEye - pupille OG (droite image)
 * @param {number} scale - scalePxToMm
 * @returns {Object} { largeurOD, largeurOG, hauteurCalibre, hauteurMontageOG, hauteurMontageOD }
 */
export function calculateBoxingDimensions(boxOG, boxOD, leftEye, rightEye, scale) {
  if (!scale) return {
    largeurOD: null, largeurOG: null, hauteurCalibre: null,
    hauteurMontageOG: null, hauteurMontageOD: null
  }

  const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
  const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0

  let largeurOD = null, largeurOG = null
  let hauteurCalibre = null
  let hauteurMontageOG = null, hauteurMontageOD = null

  if (boxOGOk) {
    largeurOD = Math.round(boxOG.width * scale * 10) / 10
    if (leftEye) {
      const bottomY = boxOG.y + boxOG.height / 2
      hauteurMontageOG = Math.round(Math.abs(bottomY - leftEye.y) * scale * 10) / 10
    }
  }
  if (boxODOk) {
    largeurOG = Math.round(boxOD.width * scale * 10) / 10
    if (rightEye) {
      const bottomY = boxOD.y + boxOD.height / 2
      hauteurMontageOD = Math.round(Math.abs(bottomY - rightEye.y) * scale * 10) / 10
    }
  }
  if (boxOGOk && boxODOk) {
    hauteurCalibre = Math.round(((boxOG.height + boxOD.height) / 2) * scale * 10) / 10
  } else if (boxOGOk) {
    hauteurCalibre = Math.round(boxOG.height * scale * 10) / 10
  } else if (boxODOk) {
    hauteurCalibre = Math.round(boxOD.height * scale * 10) / 10
  }

  return { largeurOD, largeurOG, hauteurCalibre, hauteurMontageOG, hauteurMontageOD }
}

/**
 * Taille par défaut du rectangle boxing (45×35mm convertis en pixels selon l'échelle)
 * @param {number} scale - scalePxToMm
 * @returns {Object} { width, height } en pixels
 */
export function getDefaultBoxSize(scale) {
  if (scale && scale > 0) {
    return { width: Math.round(45 / scale), height: Math.round(35 / scale) }
  }
  return { width: 72, height: 56 } // fallback proportionnel
}

/**
 * Calcule la position miroir d'un rectangle par rapport au Centre Nez
 * @param {Object} bridge - {x, y} centre nez (peut être null)
 * @param {Object} sourceBox - {x, y, width, height} rectangle source
 * @returns {Object} { x, y, width, height } rectangle miroir
 */
export function mirrorBox(bridge, sourceBox) {
  if (!sourceBox) return null

  // Axe de miroir : bridge.x si dispo, sinon centre du sourceBox
  const bridgeCenterX = bridge ? bridge.x : sourceBox.x
  const offset = sourceBox.x - bridgeCenterX
  const mirrorX = bridgeCenterX - offset // symétrie

  return {
    x: mirrorX,
    y: sourceBox.y, // même hauteur
    width: sourceBox.width,
    height: sourceBox.height
  }
}

/**
 * Calcule toutes les mesures finales à partir de l'état complet
 * @param {Object} state - { imageSize, calibration, bridge, leftEye, rightEye, boxOG, boxOD }
 * @returns {Object} Mesures complètes + validation
 */
export function computeAllMeasurements(state) {
  const { imageSize, calibration, bridge, leftEye, rightEye, boxOG, boxOD } = state

  if (!imageSize) return null

  const scale = calibration?.scalePxToMm || (140 / (imageSize.width * 0.65))
  const confiance = calibration?.confidence || 'moyenne'
  const pontOk = !!bridge
  const pupilsOk = !!(leftEye && rightEye)

  // DP
  const { pdOD, pdOG, pdBinoc } = calculateMonocularPD(leftEye, rightEye, bridge, scale)

  // Boxing
  const boxOGOk = boxOG && boxOG.width > 0 && boxOG.height > 0
  const boxODOk = boxOD && boxOD.width > 0 && boxOD.height > 0
  const frameOk = boxOGOk || boxODOk

  // Pont (EIV) via boxing
  const pontMm = calculatePont(boxOG, boxOD, scale)

  // Dimensions boxing
  const { largeurOD, largeurOG, hauteurCalibre, hauteurMontageOG, hauteurMontageOD } =
    calculateBoxingDimensions(boxOG, boxOD, leftEye, rightEye, scale)

  return {
    pd: pdBinoc || 0,
    pdMonoculaireGauche: pdOG ?? 0,
    pdMonoculaireDroit: pdOD ?? 0,
    pont: pontMm,
    pontOk,
    pupilsOk,
    frameOk,
    largeurOG,
    largeurOD,
    hauteurCalibre,
    hauteurMontageOG,
    hauteurMontageOD,
    confiance,
    methode: calibration ? 'calibration_monture_reference' : 'marquage_manuel',
    validation: validateMeasurements({
      pd: pdBinoc,
      pdMonoculaireGauche: pdOG,
      pdMonoculaireDroit: pdOD,
      pont: pontMm
    })
  }
}