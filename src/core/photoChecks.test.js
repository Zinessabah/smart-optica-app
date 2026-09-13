import { describe, it, expect } from 'vitest'
import {
  luma, blockSharpness, gridSharpness, eyeRegions, analyzeEyeSharpness,
  headRollDeg, bridgeOffsetPct, isNearEdge, evaluatePhotoQuality,
  SHARPNESS_MIN_RATIO,
} from './photoChecks'

/** Fabrique une image en niveaux de gris à partir d'une fonction (x, y) → 0-255. */
function makeGray(w, h, fn) {
  const g = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y)
  return g
}

const FLAT = makeGray(60, 60, () => 128)
const CHECKER = makeGray(60, 60, (x, y) => ((x + y) % 2 ? 255 : 0))
// Image plate SAUF un damier dans un bloc central (le « bloc le plus net »)
const BLOCKY = makeGray(60, 60, (x, y) =>
  (x >= 24 && x < 36 && y >= 24 && y < 36) ? ((x + y) % 2 ? 255 : 0) : 120)

describe('photoQuality — netteté', () => {
  it('une zone uniforme a un score de netteté nul', () => {
    expect(blockSharpness(FLAT, 60, 60, { x: 5, y: 5, width: 30, height: 30 })).toBe(0)
  })

  it('une zone contrastée a un score élevé', () => {
    // Normalisé par la luminance² : une mire noir/blanc parfaite vaut ~64
    const s = blockSharpness(CHECKER, 60, 60, { x: 5, y: 5, width: 40, height: 40 })
    expect(s).toBeGreaterThan(50)
  })

  it('le score est indépendant de l’exposition (normalisation par la luminance²)', () => {
    const dark = makeGray(40, 40, (x, y) => ((x + y) % 2 ? 100 : 0))
    const bright = makeGray(40, 40, (x, y) => ((x + y) % 2 ? 255 : 0))
    const rect = { x: 4, y: 4, width: 30, height: 30 }
    expect(blockSharpness(dark, 40, 40, rect)).toBeCloseTo(blockSharpness(bright, 40, 40, rect), 6)
  })

  it('une zone trop petite ne donne aucun score', () => {
    expect(blockSharpness(FLAT, 60, 60, { x: 0, y: 0, width: 2, height: 2 })).toBe(0)
  })

  it('gridSharpness repère le bloc le plus net de la photo', () => {
    const best = gridSharpness(BLOCKY, 60, 60, 5, 5)
    expect(best).toBeGreaterThan(0)
    // Le bloc net central est bien plus net que n'importe quel bloc du reste
    expect(best).toBeGreaterThan(blockSharpness(BLOCKY, 60, 60, { x: 0, y: 0, width: 10, height: 10 }) + 50)
  })

  it('analyzeEyeSharpness : ratio = netteté des yeux / bloc le plus net', () => {
    const imageSize = { width: 60, height: 60 }
    // Yeux dans le bloc net → ratio élevé ; yeux sur du plat → ratio nul
    const onSharp = analyzeEyeSharpness(BLOCKY, 60, 60, eyeRegions({ x: 30, y: 30 }, { x: 31, y: 30 }, imageSize))
    const onFlat = analyzeEyeSharpness(BLOCKY, 60, 60, eyeRegions({ x: 3, y: 3 }, { x: 4, y: 3 }, imageSize))
    expect(onSharp.ratio).toBeGreaterThan(SHARPNESS_MIN_RATIO)
    expect(onFlat.ratio).toBeLessThan(SHARPNESS_MIN_RATIO)
  })

  it('eyeRegions utilise une fenêtre PHYSIQUE quand le calibrage est connu', () => {
    const imageSize = { width: 1000, height: 1333 }
    const [r] = eyeRegions({ x: 400, y: 500 }, null, imageSize, { mmPerPx: 0.25, windowMm: 10 })
    expect(r.width).toBeCloseTo(40, 6)          // 10 mm / 0,25 mm/px
    expect(r.x).toBeCloseTo(400 - 20, 6)        // centrée sur la pupille
  })
})

describe('photoQuality — géométrie', () => {
  it('axe interpupillaire horizontal → 0°', () => {
    expect(headRollDeg({ x: 100, y: 200 }, { x: 300, y: 200 })).toBe(0)
  })

  it('axe incliné à 45° → 45°', () => {
    expect(headRollDeg({ x: 100, y: 100 }, { x: 200, y: 200 })).toBeCloseTo(45, 6)
    expect(headRollDeg({ x: 100, y: 200 }, { x: 200, y: 100 })).toBeCloseTo(45, 6) // le signe n'importe pas
  })

  it('pont sur le milieu des pupilles → 0 %', () => {
    expect(bridgeOffsetPct({ x: 200, y: 100 }, { x: 100, y: 200 }, { x: 300, y: 200 })).toBe(0)
  })

  it('pont décalé d’un quart de DP → 25 %', () => {
    // DP = 200 px ; pont 50 px à droite du milieu → 25 %
    expect(bridgeOffsetPct({ x: 150, y: 100 }, { x: 100, y: 200 }, { x: 300, y: 200 })).toBeCloseTo(25, 6)
    // 150 px de décalage sur 300 px de DP → 50 %
    expect(bridgeOffsetPct({ x: 400, y: 100 }, { x: 100, y: 200 }, { x: 400, y: 200 })).toBeCloseTo(50, 6)
  })

  it('repère collé au bord détecté', () => {
    const size = { width: 1000, height: 1000 }
    expect(isNearEdge({ x: 1, y: 500 }, size)).toBe(true)
    expect(isNearEdge({ x: 500, y: 999 }, size)).toBe(true)
    expect(isNearEdge({ x: 500, y: 500 }, size)).toBe(false)
  })
})

describe('photoQuality — verdicts', () => {
  const eyes = { leftEye: { x: 400, y: 500 }, rightEye: { x: 620, y: 502 } }
  const bridge = { x: 510, y: 620 }
  const imageSize = { width: 1000, height: 1333 }
  const find = (list, id) => list.find((c) => c.id === id)

  it('sans calibrage → verdict bloquant', () => {
    const r = evaluatePhotoQuality({ ...eyes, bridge, imageSize, sharpnessRatio: 0.8 })
    expect(find(r, 'calib').level).toBe('bad')
  })

  it('tout est bon → tous les contrôles au vert', () => {
    const r = evaluatePhotoQuality({ ...eyes, bridge, imageSize, sharpnessRatio: 0.7, calibration: { scalePxToMm: 0.25 } })
    expect(r.filter((c) => c.level !== 'ok')).toEqual([])
  })

  it('zone des yeux floue → avertissement de netteté', () => {
    const r = evaluatePhotoQuality({ ...eyes, bridge, imageSize, sharpnessRatio: 0.05, calibration: { scalePxToMm: 0.25 } })
    expect(find(r, 'sharp').level).toBe('warn')
  })

  it('tête inclinée à 10° → avertissement', () => {
    const r = evaluatePhotoQuality({
      leftEye: { x: 400, y: 500 }, rightEye: { x: 620, y: 539 }, bridge, imageSize,
      sharpnessRatio: 0.7, calibration: { scalePxToMm: 0.25 },
    })
    expect(find(r, 'roll').level).toBe('warn')
    expect(find(r, 'roll').detail).toContain('10')
  })

  it('pont très décalé → avertissement (tête tournée ou repère décalé)', () => {
    const r = evaluatePhotoQuality({
      ...eyes, bridge: { x: 700, y: 620 }, imageSize,
      sharpnessRatio: 0.7, calibration: { scalePxToMm: 0.25 },
    })
    expect(find(r, 'bridge').level).toBe('warn')
  })

  it('repères absents → contrôles en attente, jamais de faux « ok »', () => {
    const r = evaluatePhotoQuality({ imageSize, calibration: { scalePxToMm: 0.25 } })
    expect(find(r, 'roll').level).toBe('warn')
    expect(find(r, 'bridge').level).toBe('warn')
    expect(find(r, 'edge').level).toBe('ok')
  })

  it('luma reste une moyenne pondérée perceptuelle', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(255, 6)
    expect(luma(0, 0, 0)).toBe(0)
  })
})
