import { describe, it, expect } from 'vitest'
import { normalizeDetectionBox, buildProportionBox } from './faceFallback'

describe('normalizeDetectionBox', () => {
  it('extrait une bounding box normalisée depuis une détection face-api', () => {
    const detection = {
      detection: { box: { x: 120, y: 80, width: 300, height: 320 } },
    }
    expect(normalizeDetectionBox(detection)).toEqual({ x: 120, y: 80, width: 300, height: 320 })
  })

  it('gère aussi une box directement', () => {
    expect(normalizeDetectionBox({ box: { x: 10, y: 20, width: 40, height: 50 } })).toEqual({ x: 10, y: 20, width: 40, height: 50 })
  })

  it('retourne null si aucune box exploitable', () => {
    expect(normalizeDetectionBox(null)).toBeNull()
    expect(normalizeDetectionBox({ detection: { box: null } })).toBeNull()
    expect(normalizeDetectionBox({})).toBeNull()
  })
})

describe('buildProportionBox', () => {
  it('estime une box à partir de proportions du visage (fallback sans ML)', () => {
    const box = buildProportionBox({ width: 1600, height: 1200 })
    expect(box.x).toBeGreaterThan(0)
    expect(box.width).toBeGreaterThan(0)
    // Le visage estimé doit être centré ~50% horizontalement
    expect((box.x + box.width / 2) / 1600).toBeCloseTo(0.5, 1)
  })

  it('gère des dimensions nulles sans crash', () => {
    expect(buildProportionBox({ width: 0, height: 0 })).toBeNull()
  })
})
