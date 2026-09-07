import { describe, it, expect } from 'vitest'
import { serializeSession, restoreSession, isStepResumable } from './sessionPersistence'

const baseState = {
  step: 'pupils',
  photoSource: 'upload',
  imageData: 'data:image/jpeg;base64,AAAA',
  profileImageUrl: 'data:image/jpeg;base64,BBBB',
  calibration: { scalePxToMm: 0.5, confidence: 'haute' },
  measurements: { pd: 62 },
  faceData: { face_detected: true },
}

describe('sessionPersistence', () => {
  it('sérialise un état à reprendre sans retomber sur le JSON par défaut', () => {
    const raw = serializeSession(baseState)
    expect(typeof raw).toBe('string')
    const parsed = JSON.parse(raw)
    expect(parsed.step).toBe('pupils')
    expect(parsed.imageData).toContain('data:image/jpeg')
  })

  it('restaure un état complet', () => {
    const raw = serializeSession(baseState)
    const restored = restoreSession(raw)
    expect(restored).not.toBeNull()
    expect(restored.calibration.scalePxToMm).toBe(0.5)
    expect(restored.measurements.pd).toBe(62)
  })

  it('retourne null sur un JSON corrompu', () => {
    expect(restoreSession('{invalid json')).toBeNull()
    expect(restoreSession(null)).toBeNull()
    expect(restoreSession('')).toBeNull()
  })

  it('n’autorise pas la reprise d\'une étape privée de ses prérequis', () => {
    // calibrate exige l'image face
    expect(isStepResumable('calibrate', { ...baseState, imageData: null })).toBe(false)
    expect(isStepResumable('calibrate', baseState)).toBe(true)

    // pupils exige l'image face, mais la calibration peut être skippée (non exigée)
    expect(isStepResumable('pupils', { ...baseState, imageData: null })).toBe(false)
    expect(isStepResumable('pupils', { ...baseState, calibration: null })).toBe(true)
    expect(isStepResumable('pupils', baseState)).toBe(true)

    // profile-measure exige l'image profil (+ l'image face), pas forcément la calibration
    expect(isStepResumable('profile-measure', { ...baseState, profileImageUrl: null })).toBe(false)
    expect(isStepResumable('profile-measure', { ...baseState, calibration: null })).toBe(true)
    expect(isStepResumable('profile-measure', baseState)).toBe(true)

    // result exige des mesures
    expect(isStepResumable('result', { ...baseState, measurements: null })).toBe(false)
    expect(isStepResumable('result', baseState)).toBe(true)

    // home / photo : toujours resumable
    expect(isStepResumable('home', baseState)).toBe(true)
    expect(isStepResumable('photo', baseState)).toBe(true)
  })

  it('boucle complète : sérialiser un état calibrate → restaurer → reprendre à la même étape', () => {
    const atCalibrate = {
      step: 'calibrate',
      photoSource: 'camera',
      imageData: 'data:image/png;base64,XYZ',
      profileImageUrl: null,
      calibration: null,
      measurements: null,
      faceData: { face_detected: true, calibration: [{x:1,y:1},{x:2,y:2},{x:3,y:3}] },
    }
    const raw = serializeSession(atCalibrate)
    const restored = restoreSession(raw)
    expect(restored).not.toBeNull()
    expect(restored.step).toBe('calibrate')
    expect(isStepResumable(restored.step, restored)).toBe(true)
    // Les données de placement (faceData calibration) sont bien conservées
    expect(restored.faceData.calibration).toHaveLength(3)
  })
})
