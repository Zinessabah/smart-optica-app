import { describe, it, expect } from 'vitest'
import { calculatePantoscopicAngle, isProfileMeasurementReady, shouldRecomputeVertexAfterDrag } from './profileGeometry'

describe('profileGeometry', () => {
  it('calcule la pantoscopie comme l’écart absolu à 90 degrés', () => {
    const branchEnd = { x: 0, y: 0 }
    const vertex = { x: 100, y: 0 }
    const lensPlaneEnd = { x: 100, y: 100 }

    expect(calculatePantoscopicAngle([branchEnd, vertex, lensPlaneEnd])).toBe(0)
  })

  it('conserve le signe physique sous forme de valeur absolue et borne à 30 degrés', () => {
    const vertex = { x: 0, y: 0 }
    const branchEnd = { x: -100, y: 0 }
    const angle120 = 120 * Math.PI / 180
    const lensPlaneEnd = { x: Math.cos(angle120) * 100, y: Math.sin(angle120) * 100 }

    expect(calculatePantoscopicAngle([branchEnd, vertex, lensPlaneEnd])).toBe(30)
  })

  it('rejette un segment pantoscopique de longueur nulle', () => {
    const vertex = { x: 100, y: 100 }
    expect(calculatePantoscopicAngle([vertex, vertex, { x: 100, y: 200 }])).toBeNull()
    expect(calculatePantoscopicAngle([{ x: 0, y: 100 }, vertex, vertex])).toBeNull()
  })

  it('recalcule le vertex après déplacement d’une mire ou d’un point vertex', () => {
    expect(shouldRecomputeVertexAfterDrag('verify', true)).toBe(true)
    expect(shouldRecomputeVertexAfterDrag('vertex', true)).toBe(true)
    expect(shouldRecomputeVertexAfterDrag('angle', true)).toBe(false)
    expect(shouldRecomputeVertexAfterDrag('verify', false)).toBe(false)
  })

  it('n’autorise la validation que si angle, points vertex et distance calculée sont présents', () => {
    const anglePts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
    const vertexLine = [{ x: 0, y: 0 }, { x: 10, y: 0 }]

    expect(isProfileMeasurementReady(anglePts, vertexLine, null, false, true)).toBe(false)
    expect(isProfileMeasurementReady(anglePts, vertexLine, 12.5, true, true)).toBe(false)
    expect(isProfileMeasurementReady(anglePts, vertexLine, 12.5, false, false)).toBe(false)
    expect(isProfileMeasurementReady(anglePts, vertexLine, 12.5, false, true)).toBe(true)
  })
})
