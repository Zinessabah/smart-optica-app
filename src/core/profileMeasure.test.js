/**
 * Chaînes de mesure du profil — verrous de non-régression.
 *
 * Le vertex est calculé par le serveur (`/api/compute-vertex`) à partir de
 * `effectiveScale`, qui vaut SOIT l'échelle posée à la main sur les mires de 25 mm,
 * SOIT l'échelle faciale. Vérifié en direct : 100 px à 0,12 mm/px → 12,0 mm.
 *
 * L'angle pantoscopique se définit comme l'écart à 90° entre l'axe de la branche et
 * le plan du verre : deux segments perpendiculaires donnent 0°, un plan incliné de
 * 10° donne 10°. C'est cette convention qu'on verrouille ici.
 */
import { describe, it, expect } from 'vitest'
import { calculatePantoscopicAngle, isProfileMeasurementReady } from './profileGeometry'

const P = (x, y) => ({ x, y })

describe('Angle pantoscopique', () => {
  it('segments perpendiculaires → 0° (verre dans l’axe)', () => {
    // branche vers la droite, plan du verre vers le bas : angle droit
    expect(calculatePantoscopicAngle([P(200, 100), P(100, 100), P(100, 300)])).toBe(0)
  })

  it('plan du verre incliné de 10° → 10°', () => {
    // le plan descend en s'écartant de 10° de la verticale
    const bas = P(100, 300)
    const incline = P(100 + 200 * Math.tan(10 * Math.PI / 180), 300)
    const a = calculatePantoscopicAngle([P(200, 100), P(100, 100), incline])
    expect(Math.abs(a - 10)).toBeLessThan(0.2)
    expect(bas).toBeTruthy()
  })

  it('plan incliné de 20° → 20°', () => {
    const incline = P(100 + 200 * Math.tan(20 * Math.PI / 180), 300)
    const a = calculatePantoscopicAngle([P(200, 100), P(100, 100), incline])
    expect(Math.abs(a - 20)).toBeLessThan(0.2)
  })

  it('est borné à 30° — au-delà, ce n’est plus une pose de lunettes', () => {
    const incline = P(100 + 200 * Math.tan(60 * Math.PI / 180), 300)
    expect(calculatePantoscopicAngle([P(200, 100), P(100, 100), incline])).toBe(30)
  })

  it('ne dépend PAS de la longueur des segments — invariant d’échelle', () => {
    const court = calculatePantoscopicAngle([P(150, 100), P(100, 100), P(130, 200)])
    const long = calculatePantoscopicAngle([P(500, 100), P(100, 100), P(400, 1100)])
    expect(Math.abs(court - long)).toBeLessThan(0.2)
  })

  it('refuse un jeu de points incomplet', () => {
    expect(calculatePantoscopicAngle([])).toBeNull()
    expect(calculatePantoscopicAngle([P(1, 1), P(2, 2)])).toBeNull()
    expect(calculatePantoscopicAngle(null)).toBeNull()
  })

  it('refuse des segments de longueur nulle', () => {
    expect(calculatePantoscopicAngle([P(100, 100), P(100, 100), P(100, 300)])).toBeNull()
  })
})

describe('Mesure de profil — état de complétude', () => {
  const angleOK = [P(0, 0), P(1, 1), P(2, 2)]
  const vertexOK = [P(0, 0), P(1, 1)]

  it('exige l’angle, un vertex calculé, ET que le vertex ait été AJUSTÉ', () => {
    // « ajusté » = l'utilisateur a confirmé le vertex. Sans cette confirmation la
    // mesure n'est pas réputée prête : rien n'est validé à sa place.
    expect(isProfileMeasurementReady(angleOK, vertexOK, 12.5, false, true)).toBe(true)
    expect(isProfileMeasurementReady(angleOK, vertexOK, 12.5, false, false)).toBe(false)
  })

  it('refuse un vertex non calculé, nul ou négatif', () => {
    expect(isProfileMeasurementReady(angleOK, vertexOK, null, false, true)).toBe(false)
    expect(isProfileMeasurementReady(angleOK, vertexOK, 0, false, true)).toBe(false)
    expect(isProfileMeasurementReady(angleOK, vertexOK, -3, false, true)).toBe(false)
    expect(isProfileMeasurementReady(angleOK, [], 12.5, false, true)).toBe(false)
    expect(isProfileMeasurementReady([], vertexOK, 12.5, false, true)).toBe(false)
  })

  it('n’est pas prêt tant que le vertex charge', () => {
    expect(isProfileMeasurementReady(angleOK, vertexOK, 12.5, true, true)).toBe(false)
  })
})
