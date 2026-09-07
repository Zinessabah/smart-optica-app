import { describe, it, expect } from 'vitest'
import { classifyCameraFraming, framingGuideMessage } from './cameraFraming'

describe('classifyCameraFraming', () => {
  const video = { width: 1600, height: 1200 }

  it('retourne "ok" pour un visage bien cadré et centré', () => {
    // 500×500 = 13% de surface, centré
    const box = { x: 550, y: 400, width: 500, height: 500 }
    expect(classifyCameraFraming({ box, videoWidth: video.width, videoHeight: video.height })).toBe('ok')
  })

  it('retourne "too_far" si le visage est trop petit (< 8% de surface)', () => {
    const box = { x: 700, y: 550, width: 150, height: 150 } // ≈ 1.2%
    expect(classifyCameraFraming({ box, videoWidth: video.width, videoHeight: video.height })).toBe('too_far')
  })

  it('retourne "too_close" si le visage est trop grand (> 55% de surface)', () => {
    const box = { x: 250, y: 80, width: 1100, height: 1100 } // ≈ 63%
    expect(classifyCameraFraming({ box, videoWidth: video.width, videoHeight: video.height })).toBe('too_close')
  })

  it('retourne "too_offset" si le visage est excentré horizontalement', () => {
    // 450×450 = 10.5% surface (passe le check distance), mais cx ≈ 17% → excentré
    const box = { x: 60, y: 450, width: 450, height: 450 }
    expect(classifyCameraFraming({ box, videoWidth: video.width, videoHeight: video.height })).toBe('too_offset')
  })

  it('retourne "none" si aucun visage', () => {
    expect(classifyCameraFraming({ box: null, videoWidth: video.width, videoHeight: video.height })).toBe('none')
  })

  it('gère des dimensions vidéo nulles (pas de crash)', () => {
    expect(classifyCameraFraming({ box: { x: 0, y: 0, width: 200, height: 200 }, videoWidth: 0, videoHeight: 0 })).toBe('none')
  })
})

describe('framingGuideMessage', () => {
  it('donne un message contextuel pour chaque verdict', () => {
    expect(framingGuideMessage('ok')).toContain('clip de calibration')
    expect(framingGuideMessage('too_far')).toContain('approchez')
    expect(framingGuideMessage('too_close')).toContain('reculez')
    expect(framingGuideMessage('too_offset')).toContain('centrez')
    expect(framingGuideMessage('none')).toContain('cadre')
  })
})
