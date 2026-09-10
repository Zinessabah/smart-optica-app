import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Bandeau d'outils de l'écran « Mesures latérales » (choix Driss) :
 * les 3 mesures — échelle (réglette), distance vertex, angle pantoscopique —
 * doivent être affichées DÈS LE DÉBUT, et non au fur et à mesure des étapes.
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

describe('ProfileMeasure — bandeau d’outils', () => {
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

  it('les 3 outils sont affichés dès le début, avant tout point', async () => {
    const { container } = await renderPM()
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const txt = container.textContent

    expect(txt).toContain('Réglette')   // échelle
    expect(txt).toContain('📐')         // angle pantoscopique
    expect(txt).toContain('↔')          // distance vertex
    // Tant qu'aucune mesure n'est possible : des tirets, pas d'outil masqué
    expect(txt).toContain('—')
  })

  it('les emplacements pantoscopique et vertex survivent aux étapes intermédiaires', async () => {
    const { container } = await placePoints([[100, 150], [300, 160]])
    const txt = container.textContent

    expect(txt).toContain('📐')
    expect(txt).toContain('↔')
    expect(txt).toContain('Réglette')
    // 2 points posés mais aucune mesure encore calculable
    expect(txt).toContain('—')
  })

  it("l'angle pantoscopique s'affiche dès qu'il devient calculable", async () => {
    const { container } = await placePoints([[100, 150], [300, 160], [120, 420], [240, 330], [330, 470]])
    await waitFor(() => expect(container.textContent).toMatch(/📐\s*\d+(\.\d+)?°/))
  })
})
