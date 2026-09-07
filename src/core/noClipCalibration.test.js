import { describe, it, expect } from 'vitest'
import { calibrateFromKnownDistance } from './noClipCalibration'

describe('calibrateFromKnownDistance', () => {
  it('calcule l\'échelle à partir de 2 points et d\'une distance réelle connue', () => {
    // 2 points à 200px, distance réelle 100mm → échelle 0.5 mm/px
    const points = [{ x: 0, y: 0 }, { x: 200, y: 0 }]
    const result = calibrateFromKnownDistance(points, 100)
    expect(result.scalePxToMm).toBeCloseTo(0.5, 5)
    expect(result.distancePx).toBe(200)
    expect(result.headRotation).toBe(0)
  })

  it('gère une distance oblique (pythagore)', () => {
    // dx=300, dy=400 → distance 500px
    const points = [{ x: 0, y: 0 }, { x: 300, y: 400 }]
    const result = calibrateFromKnownDistance(points, 100)
    expect(result.distancePx).toBe(500)
    expect(result.scalePxToMm).toBeCloseTo(0.2, 5)
  })

  it('retourne null si moins de 2 points', () => {
    expect(calibrateFromKnownDistance([{ x: 0, y: 0 }], 100)).toBeNull()
    expect(calibrateFromKnownDistance([], 100)).toBeNull()
  })

  it('retourne null si distance réelle invalide (≤ 0)', () => {
    const points = [{ x: 0, y: 0 }, { x: 200, y: 0 }]
    expect(calibrateFromKnownDistance(points, 0)).toBeNull()
    expect(calibrateFromKnownDistance(points, -5)).toBeNull()
  })

  it('retourne null si les 2 points sont confondus (distance nulle à l\'écran)', () => {
    const points = [{ x: 100, y: 100 }, { x: 100, y: 100 }]
    expect(calibrateFromKnownDistance(points, 100)).toBeNull()
  })
})
