/**
 * Contrôles OBJECTIFS de la photo faciale, avant de valider une mesure.
 *
 * Règle du projet : aucun facteur de correction empirique, aucune « estimation »
 * présentée comme une mesure. Ce module ne corrige RIEN — il signale seulement
 * les situations où la mesure ne peut pas être fiable, avec un critère explicite.
 *
 *  1. Calibrage physique présent (sinon aucun mm n'est exploitable)
 *  2. Netteté de la zone des yeux — RATIO relatif au bloc le plus net de la photo
 *     (donc indépendant de l'exposition et du niveau de détail global)
 *  3. Axe interpupillaire : inclinaison de tête (roulis), en degrés
 *  4. Alignement du pont : le repère du nez doit être proche du milieu des pupilles
 *  5. Repères non rognés par le bord de l'image
 */

// ── Seuils (documentés, indicatifs — ce ne sont pas des corrections) ──────────
// ── Résolution minimale, en pixels sur le GRAND côté ────────────────────────
// Non arbitraire : voir la dérivation complète dans backend/image_quality.py.
//   L'erreur relative d'échelle vaut  pointé_mire / écartement_px. À 1 px de pointé
//   et 0,3 mm de budget d'échelle sur une DP de 65 mm (0,46 %), il faut ~217 px
//   entre les deux mires.
//     · mires faciale  50 mm · champ ~400 mm → 12,5 % de la largeur → ~1740 px
//     · mires latérales 25 mm · champ ~300 mm →  8,3 % de la largeur → ~2600 px
//   Le grand côté est utilisé : indépendant de l'orientation, donc de la rotation EXIF.
// ⚠️ Ces valeurs DOIVENT rester égales à celles de backend/image_quality.py —
//    un test de contrat le vérifie (src/__tests__/resolutionContract.test.js).
export const MIN_LONG_SIDE_FACE = 2000
export const MIN_LONG_SIDE_PROFILE = 2600

/**
 * Message d'erreur si la résolution est insuffisante, null sinon.
 * Même formulation que le serveur : c'est la même règle des deux côtés.
 */
export function resolutionError(width, height, kind = 'face') {
  const seuil = kind === 'profile' ? MIN_LONG_SIDE_PROFILE : MIN_LONG_SIDE_FACE
  const grand = Math.max(width || 0, height || 0)
  if (!grand) return "Dimensions de l'image illisibles"
  if (grand >= seuil) return null
  const nom = kind === 'profile' ? 'latérale' : 'faciale'
  return `Résolution insuffisante pour la photo ${nom} : ${width}×${height}. ` +
    `Le grand côté doit atteindre ${seuil} px pour garantir la précision de ±0,5 mm ` +
    `— il en fait ${grand}.`
}

/** Dimensions réelles du fichier, une fois décodé par le navigateur. */
export function readImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Image illisible'))
    img.src = dataUrl
  })
}

export const SHARPNESS_MIN_RATIO = 0.25   // netteté des yeux / bloc le plus net
export const ROLL_WARN_DEG = 3            // inclinaison de l'axe interpupillaire
export const BRIDGE_OFFSET_WARN_PCT = 15  // décalage du pont, en % de la DP
export const EDGE_MARGIN_PX = 2           // repère à moins de 2 px du bord

/** Luminance perceptuelle (0-255). */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Variance du laplacien sur un rectangle, normalisée par la luminance moyenne² :
 * un score de netteté insensible au niveau d'exposition.
 * @returns {number} score ≥ 0 (0 si la zone est trop petite)
 */
export function blockSharpness(gray, w, h, rect) {
  const x0 = Math.max(1, Math.floor(rect.x))
  const y0 = Math.max(1, Math.floor(rect.y))
  const x1 = Math.min(w - 1, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(h - 1, Math.ceil(rect.y + rect.height))

  let sum = 0, sum2 = 0, lum = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += lap
      sum2 += lap * lap
      lum += gray[i]
      n++
    }
  }
  if (n < 8) return 0
  const meanLap = sum / n
  const varLap = Math.max(0, sum2 / n - meanLap * meanLap)
  const meanLum = lum / n
  return varLap / Math.max(1, meanLum * meanLum)
}

/**
 * Score de netteté du bloc le plus net de l'image (référence interne).
 * Sert de dénominateur au ratio : aucune constante « absolue » n'est nécessaire.
 */
export function gridSharpness(gray, w, h, cols = 8, rows = 11) {
  let best = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = { x: (c * w) / cols, y: (r * h) / rows, width: w / cols, height: h / rows }
      const s = blockSharpness(gray, w, h, rect)
      if (s > best) best = s
    }
  }
  return best
}

/**
 * Fenêtres d'analyse autour de chaque pupille. Taille PHYSIQUE (mm) quand le
 * calibrage est disponible, sinon une fraction de la largeur de l'image.
 */
export function eyeRegions(leftEye, rightEye, imageSize, { mmPerPx = null, windowMm = 10 } = {}) {
  if (!imageSize) return []
  const side = mmPerPx ? windowMm / mmPerPx : imageSize.width * 0.08
  return [leftEye, rightEye]
    .filter(Boolean)
    .map((p) => ({ x: p.x - side / 2, y: p.y - side / 2, width: side, height: side }))
}

/**
 * Netteté relative de la zone des yeux.
 * @returns {{eye:number, best:number, ratio:number|null}}
 */
export function analyzeEyeSharpness(gray, w, h, regions) {
  const scores = regions.map((r) => blockSharpness(gray, w, h, r)).filter((s) => s > 0)
  const eye = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  const best = gridSharpness(gray, w, h)
  return { eye, best, ratio: best > 0 ? eye / best : null }
}

/** Inclinaison de l'axe interpupillaire, en degrés (0 = parfaitement horizontal). */
export function headRollDeg(leftEye, rightEye) {
  if (!leftEye || !rightEye) return null
  const dx = rightEye.x - leftEye.x
  const dy = rightEye.y - leftEye.y
  if (dx === 0 && dy === 0) return null
  return Math.abs((Math.atan2(dy, dx) * 180) / Math.PI)
}

/**
 * Décalage latéral du repère du pont par rapport au milieu des pupilles,
 * exprimé en % de la distance interpupillaire. Un pont bien placé reste sur
 * l'axe médian du visage : un écart marqué trahit une tête tournée ou un
 * repère mal posé.
 */
export function bridgeOffsetPct(bridge, leftEye, rightEye) {
  if (!bridge || !leftEye || !rightEye) return null
  const dip = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
  if (dip === 0) return null
  const midX = (leftEye.x + rightEye.x) / 2
  return (Math.abs(bridge.x - midX) / dip) * 100
}

/** Le repère est-il collé au bord de l'image (tap rogné par le clamp) ? */
export function isNearEdge(pos, imageSize, margin = EDGE_MARGIN_PX) {
  if (!pos || !imageSize) return false
  return pos.x <= margin || pos.y <= margin
    || pos.x >= imageSize.width - margin || pos.y >= imageSize.height - margin
}

/**
 * Évalue les contrôles et renvoie une liste de verdicts affichables.
 * @returns {Array<{id:string, level:'ok'|'warn'|'bad', label:string, detail:string}>}
 */
export function evaluatePhotoQuality({
  calibration = null,
  leftEye = null,
  rightEye = null,
  bridge = null,
  imageSize = null,
  sharpnessRatio = null,   // null = analyse pas encore disponible
} = {}) {
  const out = []

  // 1. Calibrage physique
  out.push(calibration?.scalePxToMm
    ? { id: 'calib', level: 'ok', label: 'Calibrage physique', detail: `${(1 / calibration.scalePxToMm).toFixed(2)} px/mm` }
    : { id: 'calib', level: 'bad', label: 'Calibrage physique', detail: 'absent — aucune mesure en mm n’est exploitable' })

  // 2. Netteté de la zone des yeux (ratio relatif)
  if (sharpnessRatio == null) {
    out.push({ id: 'sharp', level: 'warn', label: 'Netteté des yeux', detail: 'analyse en cours' })
  } else if (sharpnessRatio >= SHARPNESS_MIN_RATIO) {
    out.push({ id: 'sharp', level: 'ok', label: 'Netteté des yeux', detail: `${Math.round(sharpnessRatio * 100)} % du bloc le plus net` })
  } else {
    out.push({
      id: 'sharp', level: 'warn', label: 'Netteté des yeux',
      detail: `seulement ${Math.round(sharpnessRatio * 100)} % du bloc le plus net — reprendre si les pupilles sont floues`,
    })
  }

  // 3. Inclinaison de l'axe interpupillaire
  const roll = headRollDeg(leftEye, rightEye)
  if (roll == null) {
    out.push({ id: 'roll', level: 'warn', label: 'Inclinaison de tête', detail: 'placez les deux pupilles' })
  } else if (roll <= ROLL_WARN_DEG) {
    out.push({ id: 'roll', level: 'ok', label: 'Inclinaison de tête', detail: `${roll.toFixed(1)}° — axe interpupillaire horizontal` })
  } else {
    out.push({
      id: 'roll', level: 'warn', label: 'Inclinaison de tête',
      detail: `${roll.toFixed(1)}° d’inclinaison — la DP se mesure sur un visage de face`,
    })
  }

  // 4. Alignement du pont
  const off = bridgeOffsetPct(bridge, leftEye, rightEye)
  if (off == null) {
    out.push({ id: 'bridge', level: 'warn', label: 'Alignement du pont', detail: 'placez le pont et les deux pupilles' })
  } else if (off <= BRIDGE_OFFSET_WARN_PCT) {
    out.push({ id: 'bridge', level: 'ok', label: 'Alignement du pont', detail: `${off.toFixed(1)} % de la DP` })
  } else {
    out.push({
      id: 'bridge', level: 'warn', label: 'Alignement du pont',
      detail: `${off.toFixed(1)} % de la DP — tête tournée ou repère décalé`,
    })
  }

  // 5. Repères rognés au bord
  const clipped = [leftEye, rightEye, bridge].filter((p) => p && isNearEdge(p, imageSize))
  out.push(clipped.length === 0
    ? { id: 'edge', level: 'ok', label: 'Repères dans le cadre', detail: 'aucun repère collé au bord' }
    : { id: 'edge', level: 'warn', label: 'Repères dans le cadre', detail: `${clipped.length} repère(s) collé(s) au bord — placement rogné` })

  return out
}
