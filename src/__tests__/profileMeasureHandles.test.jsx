import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Tests des poignées de drag du profil — design validé (Driss) :
 *   · octogone translucide de rayon 11,52 (deux fois −20 % depuis r=18)
 *   · directions par DÉFAUT fixes, sans aucun automatisme de positionnement :
 *       – échelle (mires)   → à DROITE (0°)
 *       – vertex            → HORIZONTAL et OPPOSÉ
 *       – sommet de l'angle → VERTICAL vers le haut (270°)
 *   · angle pantoscopique : 🟠 et 🔵 ont l'octogone POSÉ sur le point (ni segment)
 *   · chaque poignée écartée reste pivotable au double-tap (45° par pas)
 */

const IVORY = '#f6f4ee'
const R = 11.52                             // rayon de l'octogone
const OFF = 46
const NEAR = OFF - R * Math.cos(Math.PI / 8)      // bord le plus proche ≈ 35,4
const FAR = OFF + R * Math.cos(Math.PI / 8)       // bord le plus éloigné ≈ 56,6
const SEG_END = OFF - R + 2                       // bout du segment ≈ 36,5

function stubImageLoad(w = 1000, h = 1333) {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = w
      this.naturalHeight = h
      if (this.onload) this.onload()
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

let fakeNow = 1000
let nowSpy

describe('ProfileMeasure — poignées du profil', () => {
  beforeEach(() => {
    stubImageLoad()
    fakeNow = 1000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 533, width: 400, height: 533, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 533 })
  })

  afterEach(() => {
    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  const renderPM = () =>
    render(<ProfileMeasure imageUrl="blob:fake" onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />)

  const byType = (container, type) => [...container.querySelectorAll(`[data-pt-type="${type}"]`)]
  const handleOf = (container, idx = 0) => byType(container, 'verify')[idx]
  const octagonOf = (handle) =>
    [...handle.querySelectorAll('polygon')].find(p => p.getAttribute('fill') === IVORY)
  const polygonXs = (poly) =>
    poly.getAttribute('points').trim().split(/\s+/).map(p => Number(p.split(',')[0]))

  const octOffset = (handle) => {
    const g = octagonOf(handle).closest('g')
    const m = (g.getAttribute('transform') || '').match(/translate\((-?[\d.]+)\s+(-?[\d.]+)\)/)
    return m ? { dx: Number(m[1]), dy: Number(m[2]) } : null
  }
  const octEffectiveXs = (handle) => {
    const { dx } = octOffset(handle)
    return polygonXs(octagonOf(handle)).map(x => x + dx)
  }
  const angleOf = (handle) => {
    const a = octagonOf(handle).closest('g').getAttribute('data-handle-angle')
    return a === null ? null : Number(a)
  }
  const rotatable = (handle) => octagonOf(handle).closest('g').hasAttribute('data-handle-rot')
  const connectSeg = (handle) =>
    [...handle.querySelectorAll('line')]
      .find(l => Math.hypot(Number(l.getAttribute('x2')), Number(l.getAttribute('y2'))) > 20)

  const doubleTapOctagon = (handle) => {
    fireEvent.pointerDown(octagonOf(handle), { clientX: 100, clientY: 150 })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 150 })
    fakeNow += 50
    fireEvent.pointerDown(octagonOf(handle), { clientX: 100, clientY: 150 })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 150 })
  }

  // Clique un bouton de la barre d'outils par son libellé
  const clickTool = (container, label) => {
    const btn = [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label))
    expect(btn, `bouton « ${label} » introuvable`).toBeTruthy()
    fireEvent.click(btn)
    return btn
  }

  // Les 2 poignées de l'échelle sont créées dès l'arrivée (l'outil est actif)
  async function renderBase() {
    const utils = renderPM()
    const { container } = utils
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2))
    return { ...utils, stage: container.querySelector('.aspect-\\[3\\/4\\]') }
  }

  // Mires + angle + vertex : chaque outil doit être ACTIVÉ (boutons interrupteurs)
  async function withEveryHandle() {
    const utils = await renderBase()
    clickTool(utils.container, 'Angle pantoscopique')
    clickTool(utils.container, 'Vertex')
    await waitFor(() => expect(utils.container.querySelectorAll('[data-pt-type]').length).toBeGreaterThanOrEqual(7))
    return utils
  }

  it("les 2 poignées de l'échelle sont créées dès l'arrivée", async () => {
    const { container } = await renderBase()
    expect(byType(container, 'verify').length).toBe(2)
  })

  it('l’octogone est 20 % plus petit qu’à l’étape précédente (r = 11,52)', async () => {
    const { container } = await renderBase()
    const maxAbs = Math.max(...polygonXs(octagonOf(handleOf(container))).map(Math.abs))
    expect(maxAbs).toBeCloseTo(R * Math.cos(Math.PI / 8), 1)   // ≈ 10,6
  })

  it("échelle : les 2 poignées sont à DROITE (aucun automatisme)", async () => {
    const { container } = await renderBase()
    const [m0, m1] = byType(container, 'verify')
    expect(angleOf(m0)).toBe(0)
    expect(angleOf(m1)).toBe(0)
    expect(octOffset(m0).dx).toBeGreaterThan(0)
    expect(octOffset(m1).dx).toBeGreaterThan(0)
  })

  it("la poignée écartée ne couvre jamais le point de mesure", async () => {
    const { container } = await renderBase()
    const xs = octEffectiveXs(handleOf(container))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(NEAR - 1)   // dégagé du point (à droite)
    expect(Math.max(...xs)).toBeLessThanOrEqual(FAR + 1)
  })

  it('un segment relie le point de mesure à la poignée écartée', async () => {
    const { container } = await renderBase()
    const seg = connectSeg(handleOf(container))
    expect(seg).toBeTruthy()
    expect(Number(seg.getAttribute('x1'))).toBeCloseTo(9.5, 1)
    expect(Number(seg.getAttribute('x2'))).toBeCloseTo(SEG_END, 1)
    expect(Number(seg.getAttribute('y1'))).toBeCloseTo(0, 2)   // horizontal, comme la poignée
  })

  it('vertex : index 0 = lentille de contact AU POINT, index 1 = octogone ; horizontaux et opposés', async () => {
    const { container } = await withEveryHandle()
    const [v0, v1] = byType(container, 'vertex')
    expect(v0 && v1).toBeTruthy()

    // v0 (cornée) = lentille de contact AU POINT (dans <g transform="translate(0,0)">)
    const v0Groups = v0.querySelectorAll('svg > g')
    expect(v0Groups.length).toBe(2) // 1er = lentille au point, 2e = poignée octogone
    const lensGroup = v0Groups[0]
    const v0Path = lensGroup.querySelector('path')
    expect(v0Path).toBeTruthy()
    expect(v0Path.getAttribute('d')).toContain('M -')
    // Pas d'octogone au point
    const lensOct = lensGroup.querySelector('polygon')
    expect(lensOct).toBeFalsy()
    // Pas de rotation sur le marqueur
    expect(lensGroup.hasAttribute('data-handle-rot')).toBe(false)

    // La poignée de drag (2e <g>) = octogone standard avec rotation
    const handleGroup = v0Groups[1]
    const v0HandleOct = handleGroup.querySelector('polygon')
    expect(v0HandleOct).toBeTruthy()
    expect(v0HandleOct.getAttribute('fill')).toBe(IVORY)
    expect(handleGroup.hasAttribute('data-handle-rot')).toBe(true)

    // Lire transform AVANT de vérifier l'angle (dx0 nécessaire pour savoir si gauche)
    const h0Transform = handleGroup.getAttribute('transform') || ''
    const m0 = h0Transform.match(/translate\((-?[\d.]+)\s+(-?[\d.]+)\)/)
    const dx0 = m0 ? Number(m0[1]) : 0
    const dy0 = m0 ? Number(m0[2]) : 0

    // Angle par défaut : cornée (gauche) = 180°, face arrière (droite) = 0°
    expect(Number(handleGroup.getAttribute('data-handle-angle'))).toBe(dx0 < 0 ? 180 : 0)

    // v1 (face arrière verre) = octogone standard (1 seul <g> = la poignée)
    const v1Oct = [...v1.querySelectorAll('polygon')].find(p => p.getAttribute('fill') === IVORY)
    expect(v1Oct).toBeTruthy()
    const g1 = v1Oct.closest('g')
    expect(g1.hasAttribute('data-handle-rot')).toBe(true)
    expect(Number(g1.getAttribute('data-handle-angle'))).toBe(0)

    // Les deux sont horizontaux et opposés (dx opposé, dy ≈ 0) — lecture sur les poignées de drag
    const t1 = g1.getAttribute('transform') || ''
    const m1 = t1.match(/translate\((-?[\d.]+)\s+(-?[\d.]+)\)/)
    const dx1 = m1 ? Number(m1[1]) : 0
    const dy1 = m1 ? Number(m1[2]) : 0

    expect(dy0).toBeCloseTo(0, 1)
    expect(dy1).toBeCloseTo(0, 1)
    expect(Math.sign(dx0)).toBe(-Math.sign(dx1))
    expect(Math.abs(dx0)).toBeCloseTo(Math.abs(dx1), 0)
  })

  it("sommet de l'angle pantoscopique : poignée VERTICALE", async () => {
    const { container } = await withEveryHandle()
    const sommet = byType(container, 'angle')[1]
    expect(angleOf(sommet)).toBe(270)
    const { dx, dy } = octOffset(sommet)
    expect(dx).toBeCloseTo(0, 1)          // pas d'écart horizontal…
    expect(dy).toBeLessThan(0)            // …verticalement vers le haut
    expect(connectSeg(sommet)).toBeTruthy()
  })

  it("angle pantoscopique : octogone SUR le point pour les 2 extrémités (orange, bleu)", async () => {
    const { container } = await withEveryHandle()
    const angle = byType(container, 'angle')
    expect(angle.length).toBe(3)
    expect(octOffset(angle[0])).toEqual({ dx: 0, dy: 0 })   // 🟠 branche
    expect(octOffset(angle[2])).toEqual({ dx: 0, dy: 0 })   // 🔵 plan du verre
    expect(connectSeg(angle[0])).toBeUndefined()
    expect(connectSeg(angle[2])).toBeUndefined()
  })

  it('aucune bascule automatique : la direction ne change pas près du bord', async () => {
    // Point tout près du bord droit du cadre : on reste à droite (c'est à l'utilisateur de pivoter)
    const { container } = await renderBase()
    expect(angleOf(handleOf(container))).toBe(0)
    expect(octOffset(handleOf(container)).dx).toBeGreaterThan(0)
  })

  it('le point de mesure exact garde son réticule (croix + point)', async () => {
    const { container } = await renderBase()
    const handle = handleOf(container)
    const reticleLines = [...handle.querySelectorAll('line')].filter(l =>
      ['x1', 'x2', 'y1', 'y2'].every(a => Math.abs(Number(l.getAttribute(a))) <= 7.5))
    expect(reticleLines.length).toBe(4)
    expect([...handle.querySelectorAll('circle')].filter(c => c.getAttribute('r') === '1.7').length).toBe(2)
  })

  it('le fond de la poignée est translucide (30 %) et se renforce pendant le drag', async () => {
    const { container } = await renderBase()
    const opacityOf = () => octagonOf(handleOf(container)).getAttribute('fill-opacity')

    expect(opacityOf()).toBe('0.3')
    fireEvent.pointerDown(handleOf(container), { clientX: 100, clientY: 150 })
    await waitFor(() => expect(opacityOf()).toBe('0.5'))
    fireEvent.pointerUp(window, { clientX: 100, clientY: 150 })
    await waitFor(() => expect(opacityOf()).toBe('0.3'))
  })

  it('zones tactiles : 48 px sur le point, 44 px sur la poignée', async () => {
    const { container } = await renderBase()
    const handle = handleOf(container)
    const rect = [...handle.querySelectorAll('rect')].find(r => r.getAttribute('width') === '48')
    expect(rect).toBeTruthy()
    expect(rect.getAttribute('height')).toBe('48')
    expect([...handle.querySelectorAll('circle')].some(c => c.getAttribute('r') === '22')).toBe(true)
  })

  it('le conteneur du marqueur est transparent aux events (pas de zone morte)', async () => {
    const { container } = await renderBase()
    expect(handleOf(container).style.pointerEvents).toBe('none')
  })

  it('double-tap sur un octogone : rotation de 45°, orientation mémorisée', async () => {
    const { container } = await renderBase()          // mire → 0° (droite)
    const handle = handleOf(container)
    expect(angleOf(handle)).toBe(0)

    doubleTapOctagon(handle)
    await waitFor(() => expect(angleOf(handle)).toBe(45))
    const { dx, dy } = octOffset(handle)
    expect(dx).toBeGreaterThan(0)                             // toujours à droite…
    expect(dy).toBeGreaterThan(0)                             // …mais descendu → diagonale
    expect(Math.hypot(dx, dy)).toBeCloseTo(OFF, 0)            // distance au point conservée
  })

  it('le segment suit la rotation (il reste aligné avec la poignée)', async () => {
    const { container } = await renderBase()
    const handle = handleOf(container)
    doubleTapOctagon(handle)
    await waitFor(() => expect(angleOf(handle)).toBe(45))

    const seg = connectSeg(handle)
    expect(seg).toBeTruthy()
    const x1 = Number(seg.getAttribute('x1')), y1 = Number(seg.getAttribute('y1'))
    const x2 = Number(seg.getAttribute('x2')), y2 = Number(seg.getAttribute('y2'))
    expect(x2 / x1).toBeCloseTo(y2 / y1, 1)
    expect(y1).toBeGreaterThan(0)
  })

  it('8 double-taps = tour complet, retour à l’orientation de départ', async () => {
    const { container } = await renderBase()
    const handle = handleOf(container)
    for (let n = 0; n < 8; n++) doubleTapOctagon(handle)
    await waitFor(() => expect(angleOf(handle)).toBe(0))
  })

  it('chaque poignée garde sa propre orientation', async () => {
    const { container } = await renderBase()
    const [m0, m1] = byType(container, 'verify')
    doubleTapOctagon(m0)
    await waitFor(() => expect(angleOf(m0)).toBe(45))
    expect(angleOf(m1)).toBe(0)                 // la 2e mire n'a pas bougé
  })

  it("les 2 extrémités de l'angle (posées sur le point) ne sont pas pivotables", async () => {
    const { container } = await withEveryHandle()
    const angle = byType(container, 'angle')
    expect(rotatable(angle[0])).toBe(false)     // 🟠 branche
    expect(rotatable(angle[2])).toBe(false)     // 🔵 plan du verre
    expect(rotatable(angle[1])).toBe(true)      // 🟣 sommet, lui, se pivote
  })

  it('un drag de l’octogone déplace le point SANS le faire pivoter', async () => {
    const { container } = await renderBase()
    const handle = handleOf(container)
    const before = handle.style.left

    fireEvent.pointerDown(octagonOf(handle), { clientX: 100, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 140, clientY: 190 })
    fireEvent.pointerUp(window, { clientX: 140, clientY: 190 })

    await waitFor(() => expect(handle.style.left).not.toBe(before))
    expect(angleOf(handle)).toBe(0)             // orientation inchangée
  })

  it('un drag déplace le point', async () => {
    const { container } = await renderBase()
    const before = handleOf(container).style.left

    fireEvent.pointerDown(handleOf(container), { clientX: 100, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 180, clientY: 240 })
    fireEvent.pointerUp(window, { clientX: 180, clientY: 240 })

    await waitFor(() => expect(handleOf(container).style.left).not.toBe(before))
  })

  it('un clic < 300 ms après un drag ne crée PAS de point fantôme', async () => {
    const { container, stage } = await renderBase()

    fireEvent.pointerDown(handleOf(container), { clientX: 100, clientY: 150 })
    fakeNow += 50
    fireEvent.pointerMove(window, { clientX: 180, clientY: 240 })
    fireEvent.pointerUp(window, { clientX: 180, clientY: 240 })

    fakeNow += 100  // < 300 ms
    fireEvent.click(stage, { clientX: 180, clientY: 240 })

    expect(byType(container, 'verify').length).toBe(2)
  })

  it('un tap après un drag n’ajoute aucun point (groupes complets)', async () => {
    const { container, stage } = await renderBase()

    fireEvent.pointerDown(handleOf(container), { clientX: 100, clientY: 150 })
    fakeNow += 50
    fireEvent.pointerMove(window, { clientX: 180, clientY: 240 })
    fireEvent.pointerUp(window, { clientX: 180, clientY: 240 })

    fakeNow += 500  // > 300 ms
    fireEvent.click(stage, { clientX: 300, clientY: 400 })

    await waitFor(() => expect(byType(container, 'verify').length).toBe(2))
  })
})
