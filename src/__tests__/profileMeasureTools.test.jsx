import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Barre d'outils de l'écran « Mesures latérales » (choix Driss) :
 *   4 boutons INTERRUPTEURS — ils activent ET désactivent l'outil.
 *     · 📏 Échelle   → les 2 marqueurs ; affiche les px/mm mesurés entre eux
 *     · 📐 Réglette  → la réglette métrologique
 *     · ↔ Vertex     → les 2 poignées du vertex
 *     · ∠ Angle pantoscopique → les 3 poignées de l'angle
 */

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

describe('ProfileMeasure — barre d’outils', () => {
  beforeEach(() => {
    stubImageLoad()
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 533, width: 400, height: 533, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 533 })
  })
  afterEach(() => vi.unstubAllGlobals())

  const renderPM = () =>
    render(<ProfileMeasure imageUrl="blob:fake" onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />)

  const btn = (container, label) =>
    [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label))
  const clickTool = (container, label) => fireEvent.click(btn(container, label))
  // Actif = le style porte une vraie couleur de liseré (sinon « transparent »)
  const isOn = (b) => !(b.getAttribute('style') || '').includes('transparent')

  async function placePoints(clicks) {
    const utils = renderPM()
    const { container } = utils
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const stage = container.querySelector('.aspect-\\[3\\/4\\]')
    for (const [x, y] of clicks) {
      fireEvent.pointerDown(stage, { clientX: x, clientY: y })
      fireEvent.click(stage, { clientX: x, clientY: y })
    }
    return { ...utils, stage }
  }
  const MIRES = [[100, 150], [300, 160]]
  const withMires = () => placePoints(MIRES)

  it('on a bien les 4 boutons demandés, présents dès le début', async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    for (const label of ['Échelle', 'Réglette', 'Vertex', 'Angle pantoscopique']) {
      expect(btn(container, label), `bouton « ${label} » manquant`).toBeTruthy()
    }
    expect(btn(container, 'Angle pantoscopique').textContent).toContain('—')
    expect(btn(container, 'Vertex').textContent).toContain('—')
  })

  it("à l'arrivée, SEULE l'Échelle est active (les 3 autres s'activent à la demande)", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    expect(isOn(btn(container, 'Échelle'))).toBe(true)
    expect(isOn(btn(container, 'Réglette'))).toBe(false)
    expect(isOn(btn(container, 'Vertex'))).toBe(false)
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(false)
  })

  it('la Réglette s’active à la demande', async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    clickTool(container, 'Réglette')
    await waitFor(() => expect(isOn(btn(container, 'Réglette'))).toBe(true))
    expect(container.querySelector('.mr-ruler')).toBeTruthy()

    clickTool(container, 'Réglette')
    await waitFor(() => expect(container.querySelector('.mr-ruler')).toBeFalsy())
  })

  it("le bouton Échelle affiche les px/mm mesurés entre les 2 marqueurs", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    // Les 2 poignées sont créées dès l'arrivée → px/mm affiché immédiatement
    await waitFor(() => expect(btn(container, 'Échelle').textContent).toMatch(/\d+\.\d+ px\/mm/))
    expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2)
  })

  it("désactiver puis réactiver l'Échelle garde ses 2 poignées", async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2))

    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(0))
    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2))
  })

  it("le bouton Angle pantoscopique active PUIS désactive les 3 poignées", async () => {
    const { container } = await withMires()
    expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0)

    clickTool(container, 'Angle pantoscopique')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(3))
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(true)

    clickTool(container, 'Angle pantoscopique')          // on désactive
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0))
    expect(isOn(btn(container, 'Angle pantoscopique'))).toBe(false)
  })

  it("le bouton Vertex active puis désactive les 2 poignées", async () => {
    const { container } = await withMires()
    clickTool(container, 'Vertex')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="vertex"]').length).toBe(2))

    clickTool(container, 'Vertex')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="vertex"]').length).toBe(0))
  })

  it("désactiver l'échelle masque ses 2 marqueurs", async () => {
    const { container } = await withMires()
    expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2)

    clickTool(container, 'Échelle')
    await waitFor(() => expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(0))
  })

  it('les mesures restent affichées quand on masque l’outil', async () => {
    const { container } = await withMires()
    clickTool(container, 'Angle pantoscopique')
    await waitFor(() => expect(btn(container, 'Angle pantoscopique').textContent).toMatch(/\d+(\.\d+)?°/))

    const av = btn(container, 'Angle pantoscopique').textContent
    clickTool(container, 'Angle pantoscopique')   // masqué
    expect(btn(container, 'Angle pantoscopique').textContent).toBe(av)
  })

  it("le tap ne pose un point que pour un outil ACTIF (l'angle est désactivé par défaut)", async () => {
    const { container } = await placePoints([[100, 150], [300, 160], [120, 420]])
    expect(container.querySelectorAll('[data-pt-type="verify"]').length).toBe(2)
    expect(container.querySelectorAll('[data-pt-type="angle"]').length).toBe(0)
  })
})
