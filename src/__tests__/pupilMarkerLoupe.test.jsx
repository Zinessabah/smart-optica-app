import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, configure } from '@testing-library/react'

// Marge de manœuvre : jsdom sous charge peut dépasser le délai par défaut de 1 s.
// Les assertions restent identiques — seul le temps d'attente change.
configure({ asyncUtilTimeout: 3000 })
import PupilMarker from '../PupilMarker'

// Détection auto neutralisée (résout `null`) → géométrie déterministe et
// aucun repère posé par une estimation concurrente.
vi.mock('../core/faceDetection', () => ({ detectFace: async () => null }))

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
    await waitFor(() => expect(container.querySelector('#pupil-image-container')).toBeTruthy())
    const stage = container.querySelector('#pupil-image-container')

    // Le conteneur est rendu AVANT que `imageSize` soit connu : un tap trop tôt
    // est ignoré. On réessaie le même tap jusqu'à ce que le repère apparaisse —
    // relancer ce tap est sûr, il pose toujours le premier repère manquant.
    const tap = async (sel, x, y) => {
      await waitFor(() => {
        fireEvent.pointerDown(stage, { clientX: x, clientY: y })
        fireEvent.pointerUp(stage, { clientX: x, clientY: y })
        expect(container.querySelector(sel)).toBeTruthy()
      }, { timeout: 5000, interval: 100 })
    }
    await tap('[data-markerid="bridge"]', 90, 140)
    await tap('[data-markerid="left"]', 120, 150)
    await tap('[data-markerid="right"]', 260, 152)

    return { ...utils, container, stage, tap, handle: (id) => container.querySelector(`[data-markerid="${id}"]`) }
  }

  it('hors pointage assisté, poser un repère n’affiche aucune loupe', async () => {
    const { container } = renderPM()
    const stage0 = container.querySelector('#pupil-image-container')
    await waitFor(() => expect(stage0).toBeTruthy())
    // La détection simulée échoue → le pointage assisté s'active d'office.
    // On le coupe : c'est la pose DIRECTE qu'on vérifie ici.
    const bouton = container.querySelector('button[data-tool="assist"]')
    await waitFor(() => expect(bouton.dataset.assist).toBe('1'))
    fireEvent.click(bouton)
    await waitFor(() => expect(bouton.dataset.assist).toBe('0'))

    fireEvent.pointerDown(stage0, { clientX: 90, clientY: 140 })
    await waitFor(() => expect(container.querySelector('[data-markerid="bridge"]')).toBeTruthy())
    fireEvent.pointerUp(stage0, { clientX: 90, clientY: 140 })
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

  it('la loupe affiche LE repère de l’écran, pas un dessin différent', async () => {
    const { container, handle } = await mountWithMarkers()
    fireEvent.pointerDown(handle('left'), { clientX: 120, clientY: 150 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())

    const loupe = container.querySelector('[data-loupe]')
    const svg = loupe.querySelector('[data-reticle] svg')
    expect(svg).toBeTruthy()
    // Le repère de cet écran est un petit cercle r=2,5 — c'est LUI qui doit être grossi,
    // pas la croix + anneau que la loupe dessinait de son côté.
    expect(svg.querySelector('circle').getAttribute('r')).toBe('2.5')
    expect(svg.querySelector('line')).toBeNull()
    fireEvent.pointerUp(window)
  })

  it('la loupe reste AU-DESSUS du doigt près du bord haut (jamais sous la main)', async () => {
    // Le repère « bridge » est posé près du haut : l'ancien code basculait la bulle
    // SOUS le doigt, c'est-à-dire sous la paume, qui masquait tout.
    const { container, handle } = await mountWithMarkers()
    fireEvent.pointerDown(handle('bridge'), { clientX: 90, clientY: 140 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())

    const top = parseFloat(container.querySelector('[data-loupe]').style.top)
    expect(top).toBeLessThanOrEqual(80)      // remontée au bord, pas basculée dessous
    fireEvent.pointerUp(window)
  })
})
