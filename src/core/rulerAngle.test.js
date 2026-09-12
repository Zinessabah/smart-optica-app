import { describe, it, expect } from 'vitest'
import { inclinationFromRotation, formatInclination } from './rulerAngle'

describe("inclinaison de la réglette par rapport à l'horizontale", () => {
  it('rotation nulle → réglette horizontale (0°)', () => {
    expect(inclinationFromRotation(0)).toBe(0)
  })

  it('45° de rotation → 45° d’inclinaison', () => {
    expect(inclinationFromRotation(45)).toBe(45)
  })

  it('90° de rotation → réglette verticale', () => {
    expect(inclinationFromRotation(90)).toBe(90)
  })

  it('180° → même tracé qu’à l’horizontale (symétrie de la réglette)', () => {
    expect(inclinationFromRotation(180)).toBe(0)
  })

  it('135° → équivaut à -45° (symétrie 180°)', () => {
    expect(inclinationFromRotation(135)).toBe(-45)
  })

  it('270° → verticale', () => {
    expect(Math.abs(inclinationFromRotation(270))).toBe(90)
  })

  it('gère les rotations négatives', () => {
    expect(inclinationFromRotation(-30)).toBe(-30)
    expect(inclinationFromRotation(-200)).toBe(-20)
  })

  it('toujours dans ]-90, 90] pour des rotations arbitraires', () => {
    for (const deg of [0, 12, 89, 91, 179, 181, 359, 720, -720, -91, -179]) {
      const a = inclinationFromRotation(deg)
      expect(a).toBeGreaterThan(-90)
      expect(a).toBeLessThanOrEqual(90)
    }
  })

  it('rotation non numérique → 0 (pas de NaN affiché)', () => {
    expect(inclinationFromRotation(NaN)).toBe(0)
    expect(inclinationFromRotation(Infinity)).toBe(0)
  })

  it('formatage signé', () => {
    expect(formatInclination(0)).toBe('0.0°')
    expect(formatInclination(12.34)).toBe('+12.3°')
    expect(formatInclination(-45)).toBe('-45.0°')
    expect(formatInclination(180)).toBe('0.0°')
  })
})
