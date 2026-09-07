import { describe, it, expect } from 'vitest'
import { scoreSharpness, scoreExposure, decidePhotoQuality } from './photoQuality'

describe('scoreSharpness', () => {
  it('retourne un score faible pour une image uniforme (floue)', () => {
    // Tous les pixels identiques → variance Laplacien ≈ 0
    const flat = Array.from({ length: 100 }, () => 120)
    expect(scoreSharpness(flat)).toBeLessThan(5)
  })

  it('retourne un score élevé pour une image à forts contrastes (nette)', () => {
    // Motif alterné noir/blanc → forte variance Laplacien
    const sharp = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 30 : 220))
    expect(scoreSharpness(sharp)).toBeGreaterThan(50)
  })
})

describe('scoreExposure', () => {
  it('retourne un contraste faible pour une image grise uniforme', () => {
    expect(scoreExposure(Array.from({ length: 100 }, () => 128)).contrast).toBeCloseTo(0, 1)
  })

  it('retourne une moyenne basse pour une image sombre', () => {
    expect(scoreExposure(Array.from({ length: 100 }, () => 20)).brightness).toBeLessThan(40)
  })

  it('retourne une moyenne haute pour une image claire/brûlée', () => {
    expect(scoreExposure(Array.from({ length: 100 }, () => 250)).brightness).toBeGreaterThan(200)
  })
})

describe('decidePhotoQuality', () => {
  it('accepte une photo nette et correctement exposée', () => {
    expect(decidePhotoQuality({ sharpness: 120, brightness: 128, contrast: 60 })).toBe('good')
  })

  it('détecte une photo floue', () => {
    expect(decidePhotoQuality({ sharpness: 2, brightness: 128, contrast: 30 })).toBe('blurry')
  })

  it('détecte une photo trop sombre', () => {
    expect(decidePhotoQuality({ sharpness: 100, brightness: 15, contrast: 40 })).toBe('too_dark')
  })

  it('détecte une photo surexposée', () => {
    expect(decidePhotoQuality({ sharpness: 100, brightness: 245, contrast: 10 })).toBe('too_bright')
  })
})
