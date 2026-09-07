import { describe, it, expect } from 'vitest'
import { resolveFaceApiModelsUrl } from './faceModelUrl'

describe('resolveFaceApiModelsUrl', () => {
  it('préfère les modèles locaux quand ils sont disponibles', () => {
    expect(resolveFaceApiModelsUrl({ useLocal: true })).toBe('/models')
  })

  it('retombe sur le CDN quand les modèles locaux sont absents', () => {
    expect(resolveFaceApiModelsUrl({ useLocal: false })).toContain('justadudewhohacks')
  })

  it('préfère les modèles locaux par défaut (pré-cache hors-ligne)', () => {
    expect(resolveFaceApiModelsUrl({})).toBe('/models')
    expect(resolveFaceApiModelsUrl({ useLocal: true })).toBe('/models')
  })
})
