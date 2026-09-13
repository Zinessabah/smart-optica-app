import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import PupilMarker from '../PupilMarker'

/**
 * Loupe de précision de l'écran facial.
 * Règle fondatrice : le point de mesure reste EXACTEMENT au centre de la bulle,
 * et la loupe ne doit JAMAIS intercepter le doigt (pointerEvents: none).
 */

function stubImageLoad(w = 1000, h = 1333) {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = w
      this.naturalHeight = h
      // Le composant assigne onload APRÈS img.src → on diffère l'appel
      setTimeout(() => { if (this.onload) this.onload() }, 0)
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

const CW = 400
const CH = 533
const IW = 1000
const IH = 1333

describe('PupilMarker — loupe de précision', () => {
  beforeEach(() => {
    stubImageLoad(IW, IH)
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: CW, bottom: CH, width: CW, height: CH, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: CW })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: CH })
  })
  afterEach(() => vi.unstubAllGlobals())

  const renderPM = () =>
    render(<PupilMarker imageUrl="blob:fake" calibration={{ scalePxToMm: 0.25 }}
      onConfirm={() => {}} onBack={() => {}} />)

  async function mountWithMarkers() {
    const utils = renderPM()
    const { container } = utils
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const stage = container.querySelector('#pupil-image-container')
    const btn = (t) => [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(t))

    // Pont (marqueur actif par défaut) → OD → OG
    fireEvent.pointerDown(stage, { clientX: 90, clientY: 140 })
    fireEvent.click(btn('OD')); fireEvent.pointerDown(stage, { clientX: 120, clientY: 150 })
    fireEvent.click(btn('OG')); fireEvent.pointerDown(stage, { clientX: 260, clientY: 152 })

    await waitFor(() => expect(container.querySelector('[data-markerid="left"]')).toBeTruthy())
    return { ...utils, stage, handle: (id) => container.querySelector(`[data-markerid="${id}"]`) }
  }

  it('aucune loupe tant qu’on ne fait que poser les repères', async () => {
    const { container } = await mountWithMarkers()
    expect(container.querySelector('[data-loupe="1"]')).toBeFalsy()
  })

  it('la loupe apparaît pendant le drag d’un repère et disparaît au relâchement', async () => {
    const { container, handle } = await mountWithMarkers()

    fireEvent.pointerDown(handle('left'), { clientX: 120, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 158 })
    await waitFor(() => expect(container.querySelector('[data-loupe="1"]')).toBeTruthy())

    fireEvent.pointerUp(window)
    await waitFor(() => expect(container.querySelector('[data-loupe="1"]')).toBeFalsy())
  })

  it('le point mesuré tombe exactement au centre de la bulle (invariant géométrique)', async () => {
    const { container, handle } = await mountWithMarkers()

    // On déplace OD : +10 px écran en X, +8 en Y
    fireEvent.pointerDown(handle('left'), { clientX: 120, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 158 })
    const loupe = await waitFor(() => container.querySelector('[data-loupe="1"]'))
    const style = loupe.getAttribute('style') || ''

    const bgSize = /background-size: ([\d.]+)px ([\d.]+)px/.exec(style)
    const bgPos = /background-position: (-?[\d.]+)px (-?[\d.]+)px/.exec(style)
    const leftPx = parseFloat(/left: (-?[\d.]+)px/.exec(style)[1])
    expect(bgSize && bgPos).toBeTruthy()

    const zoom = parseFloat(bgSize[1]) / IW
    const bgX = parseFloat(bgPos[1])
    const bgY = parseFloat(bgPos[2])

    // Position image du repère, lue sur son propre rendu (aucun nombre en dur)
    const pctX = parseFloat(handle('left').parentElement.style.left)
    const pctY = parseFloat(handle('left').parentElement.style.top)
    const posX = (pctX / 100) * IW
    const posY = (pctY / 100) * IH

    // INVARIANT : le point mesuré est exactement au centre de la bulle
    expect(posX * zoom + bgX).toBeCloseTo(62, 4)
    expect(posY * zoom + bgY).toBeCloseTo(62, 4)

    // La bulle est bien centrée sur ce point à l'écran
    const drWidth = (leftPx * IW) / posX
    expect(leftPx).toBeCloseTo((posX / IW) * drWidth, 4)

    // Champ de vision physique : 12 mm, quel que soit l'affichage (mm/px = 0.25)
    const expectedZoom = Math.min(20, Math.max(1, 124 / (12 / 0.25)))
    expect(zoom).toBeCloseTo(expectedZoom, 6)
  })

  it('la loupe porte une cale étalon de 1 mm (échelle physique)', async () => {
    const { container, handle } = await mountWithMarkers()
    fireEvent.pointerDown(handle('left'), { clientX: 120, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 124, clientY: 153 })
    const loupe = await waitFor(() => container.querySelector('[data-loupe="1"]'))

    // 1 mm = (1 / 0.25) px image × zoom
    const zoom = 124 / (12 / 0.25)
    const bar = loupe.querySelector('[data-mm-bar]')
    expect(bar).toBeTruthy()
    expect(parseFloat(bar.getAttribute('data-mm-bar'))).toBeCloseTo((1 / 0.25) * zoom, 2)
    expect(loupe.textContent).toContain('12 mm')
  })

  it('la loupe n’intercepte jamais le doigt', async () => {
    const { container, handle } = await mountWithMarkers()
    fireEvent.pointerDown(handle('right'), { clientX: 260, clientY: 152 })
    fireEvent.pointerMove(window, { clientX: 262, clientY: 154 })
    const loupe = await waitFor(() => container.querySelector('[data-loupe="1"]'))
    expect((loupe.getAttribute('style') || '')).toContain('pointer-events: none')
  })

  it('plus de poignée déportée : la cible tactile EST sur le point mesuré', async () => {
    const { handle } = await mountWithMarkers()
    const hit = handle('left')
    const style = hit.getAttribute('style') || ''
    // La cible est centrée sur le point (aucun déport vers le haut)
    expect(style).toContain('top: 0px')
    expect(style).not.toContain('-75')
    expect(style).toContain('pointer-events: auto')
    // Son parent porte la position mesurée et ne capte aucun événement
    const wrapper = hit.parentElement
    expect(wrapper.style.pointerEvents).toBe('none')
    expect(parseFloat(wrapper.style.left)).toBeGreaterThan(0)
    expect(parseFloat(wrapper.style.top)).toBeGreaterThan(0)
  })

  it('un tap ne déplace plus un repère existant : seul le drag le règle', async () => {
    const { stage, handle } = await mountWithMarkers()
    const before = handle('left').parentElement.style.left
    const beforeTop = handle('left').parentElement.style.top

    // Tap loin du repère (OG est l'outil actif, il existe déjà) → rien ne bouge
    fireEvent.pointerDown(stage, { clientX: 340, clientY: 430 })
    fireEvent.click(stage, { clientX: 340, clientY: 430 })

    expect(handle('left').parentElement.style.left).toBe(before)
    expect(handle('left').parentElement.style.top).toBe(beforeTop)
  })

  it('le drag sur le petit cercle déplace bien le point et suit la loupe', async () => {
    const { container, handle } = await mountWithMarkers()
    const before = parseFloat(handle('left').parentElement.style.left)

    fireEvent.pointerDown(handle('left'), { clientX: 120, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 160, clientY: 150 })   // +40 px écran
    await waitFor(() => expect(container.querySelector('[data-loupe="1"]')).toBeTruthy())

    const after = parseFloat(handle('left').parentElement.style.left)
    expect(after).toBeGreaterThan(before)                            // le point a suivi le doigt

    // La bulle est centrée horizontalement sur le point déplacé.
    // dr.width = « contain » de l'image (1000×1333) dans le cadre de test (400×533)
    const drWidth = 533 * (IW / IH)
    const loupeLeft = parseFloat(/left: (-?[\d.]+)px/.exec(
      container.querySelector('[data-loupe="1"]').getAttribute('style'))[1])
    expect(loupeLeft).toBeCloseTo((after / 100) * drWidth, 1)
  })
})
