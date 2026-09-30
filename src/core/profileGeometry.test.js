import { describe, it, expect } from 'vitest'
import { calculatePantoscopicAngle, calculatePantoscopicAngleWithBase, isProfileMeasurementReady, shouldRecomputeVertexAfterDrag } from './profileGeometry'

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

  it('accepte 2 points d’angle quand la branche est MESURÉE (6e argument)', () => {
    const deux = [{ x: 0, y: 0 }, { x: 0, y: 10 }]
    const vLine = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    // Par défaut le contrat reste 3 points : les appelants existants ne changent pas.
    expect(isProfileMeasurementReady(deux, vLine, 12.5, false, true)).toBe(false)
    expect(isProfileMeasurementReady(deux, vLine, 12.5, false, true, 2)).toBe(true)
  })
})

/**
 * Pantoscopie à BRANCHE MESURÉE : la droite des 2 mires basses du clip EST la direction de la
 * branche (les mires sont montées dans son axe avant-arrière). Il ne reste que la ligne du verre
 * à poser — 2 points au lieu de 3 — et le roulis de l'appareil s'annule puisque les deux
 * directions sont mesurées dans la même image.
 */
describe('calculatePantoscopicAngleWithBase — la branche vient des mires', () => {
  const base = [{ x: 0, y: 0 }, { x: 200, y: 0 }]        // 2 mires basses = branche horizontale

  it('rend 0 quand la ligne du verre est perpendiculaire à la branche', () => {
    expect(calculatePantoscopicAngleWithBase([{ x: 100, y: 0 }, { x: 100, y: 300 }], base)).toBe(0)
  })

  it('rend la DÉVIATION quand le verre est incliné de 8°', () => {
    const a = (8 * Math.PI) / 180
    const p2 = { x: 100 + 300 * Math.sin(a), y: 300 * Math.cos(a) }
    expect(calculatePantoscopicAngleWithBase([{ x: 100, y: 0 }, p2], base)).toBe(8)
  })

  it('est insensible au SENS de parcours — ce sont deux DROITES', () => {
    const verre = [{ x: 100, y: 0 }, { x: 100, y: 300 }]
    expect(calculatePantoscopicAngleWithBase([...verre].reverse(), base)).toBe(0)
    expect(calculatePantoscopicAngleWithBase(verre, [...base].reverse())).toBe(0)
  })

  it('rend null si une direction est indéfinie (jamais un angle inventé)', () => {
    expect(calculatePantoscopicAngleWithBase([{ x: 100, y: 0 }], base)).toBeNull()
    expect(calculatePantoscopicAngleWithBase([{ x: 100, y: 0 }, { x: 100, y: 0 }], base)).toBeNull()
    expect(calculatePantoscopicAngleWithBase([{ x: 0, y: 0 }, { x: 0, y: 10 }], null)).toBeNull()
  })
})
