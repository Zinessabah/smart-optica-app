import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import MeasureRuler from '../components/MeasureRuler'

/**
 * Réglette métrologique — rotation à DEUX DOIGTS (choix Driss).
 *
 * La poignée centrale 1-doigt a été retirée : sur iPad, un doigt masquait le
 * centre et le levier de 15 px rendait la rotation imprécise. Désormais :
 *   · 1 doigt        → déplacement de la réglette (inchangé)
 *   · 2 doigts       → ROTATION, pilotée par l'angle du VECTEUR entre les doigts
 *   · un indice « 🖐 2 doigts pour pivoter » est affiché au premier affichage
 */

function setup() {
  Element.prototype.getBoundingClientRect = function () {
    return { x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 200, width: 400, height: 100, toJSON() {} }
  }
  const utils = render(
    <MeasureRuler
      variant="ruler"
      visible
      scaleMmPerPx={0.5}
      imageSize={{ width: 400, height: 533 }}
      displayRect={{ width: 400, height: 533 }}
    />
  )
  const ruler = utils.container.querySelector('.mr-ruler')
  return { ...utils, ruler }
}

/** Extrait la valeur de `rotate(Xdeg)` du style inline de la réglette. */
const angleOf = (el) => {
  const m = /rotate\(([-\d.]+)deg\)/.exec(el.getAttribute('style') || '')
  return m ? parseFloat(m[1]) : 0
}

describe('MeasureRuler — rotation 2 doigts', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('la poignée de rotation centrale (1 doigt) a été retirée', () => {
    const { ruler } = setup()
    expect(ruler).toBeTruthy()
    expect(ruler.querySelector('.mr-rot')).toBeFalsy()
  })

  it("affiche l'indice « 2 doigts pour pivoter » au premier affichage", () => {
    const { container } = setup()
    expect(container.textContent).toMatch(/2 doigts/i)
  })

  it('deux doigts font pivoter la réglette (angle du vecteur inter-doigts)', () => {
    const { ruler } = setup()
    expect(angleOf(ruler)).toBe(0)

    // Doigts posés à l'horizontale : vecteur (100,0) → 0°
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 150, clientY: 150 })
    fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 250, clientY: 150 })

    // Pivot de 90° : les doigts passent à la verticale → vecteur (0,100) → 90°
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 200, clientY: 200 })

    expect(Math.abs(angleOf(ruler))).toBeGreaterThan(45)
  })

  it('un seul doigt DÉPLACE la réglette (pas de rotation)', () => {
    const { ruler } = setup()
    const leftBefore = ruler.style.left

    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 200, clientY: 150 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 180 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(angleOf(ruler)).toBe(0)
    expect(ruler.style.left).not.toBe(leftBefore)
  })

  it("lever un doigt met fin à la rotation sans faire sauter l'angle", () => {
    const { ruler } = setup()

    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 150, clientY: 150 })
    fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 250, clientY: 150 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 200, clientY: 200 })
    const frozen = angleOf(ruler)

    // On relâche UN doigt → plus de rotation ; un move résiduel ne change rien
    fireEvent.pointerUp(window, { pointerId: 2 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 400 })

    expect(angleOf(ruler)).toBe(frozen)
  })

  it("les angles prédéfinis (0°/45°/90°) ont été retirés", () => {
    const { container } = setup()
    expect(container.querySelector('.mr-snaps')).toBeFalsy()
    const labels = [...container.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).not.toContain('45°')
  })

  it("l'inclinaison est affichée dans le badge Δ, sans libellé", () => {
    const { container } = setup()
    const incl = container.querySelector('.mr-incl')
    expect(incl).toBeTruthy()
    // Réglette non tournée → horizontale ; valeur + « ° » seulement
    expect(incl.textContent).toBe('0.0°')
    // Aucun mot : ni « inclinaison », ni « horizontale »
    expect(container.textContent).not.toMatch(/inclinaison/i)
    expect(container.textContent).not.toMatch(/horizontale/i)
  })

  it("l'inclinaison est un SEUL badge avec le Δ (aucun badge séparé)", () => {
    const { container } = setup()
    // Un seul élément badge sous la règle : plus aucun recouvrement possible
    expect(container.querySelectorAll('.mr-diff').length).toBe(1)
    expect(container.querySelector('.mr-angle')).toBeFalsy()
    expect(container.querySelector('.mr-diff').querySelector('.mr-incl')).toBeTruthy()
  })

  it("la lecture d'angle suit la rotation (90° = verticale)", () => {
    const { ruler, container } = setup()

    // Doigts à l'horizontale → vecteur 0°, puis à la verticale → pivot de +90°
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 150, clientY: 150 })
    fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 250, clientY: 150 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 200, clientY: 200 })

    expect(container.querySelector('.mr-incl').textContent).toMatch(/\+?90\.0°/)
  })

  it("l'inclinaison reste dans ]-90, 90] (symétrie 180° de la réglette)", () => {
    const { ruler, container } = setup()

    // Pivot de 180° : doigts horizontaux retournés → l'inclinaison reste 0°
    fireEvent.pointerDown(ruler, { pointerId: 1, clientX: 150, clientY: 150 })
    fireEvent.pointerDown(ruler, { pointerId: 2, clientX: 250, clientY: 150 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 250, clientY: 150 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 150, clientY: 150 })

    expect(container.querySelector('.mr-incl').textContent).toMatch(/0\.0°/)
  })

  it('les index de lecture démarrent à 35 % et 65 % de la règle', () => {
    const { container } = setup()
    expect(container.querySelector('[data-idx="a"]').style.left).toBe('35%')
    expect(container.querySelector('[data-idx="b"]').style.left).toBe('65%')
  })

  it('le Δ reflète l’écart réel des index (30 mm entre 35 % et 65 %)', () => {
    const { container } = setup()
    expect(container.querySelector('.mr-diff').textContent).toMatch(/30\.0 mm/)
  })
})
