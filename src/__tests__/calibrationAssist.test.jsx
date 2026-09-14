/**
 * Écran de CALIBRAGE — pointage assisté.
 *
 * Le calibrage est l'étape la plus sensible : son échelle se répercute sur toutes
 * les mesures. Le doigt masquant le bord de la cale qu'il vise, on vise d'abord
 * (loupe) et on pose au relâchement — comme sur l'écran des repères, avec la même
 * loupe (components/PrecisionLoupe).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, configure } from '@testing-library/react'
import CalibrationOverlay from '../CalibrationOverlay'

configure({ asyncUtilTimeout: 3000 })

// L'analyse serveur échoue → c'est le cas « détection infructueuse », qui doit
// activer le pointage assisté d'office.
vi.mock('../services/api', () => ({
  analyzeCalibration: vi.fn(async () => { throw new Error('indisponible') }),
}))

const CW = 520, CH = 693

function stubImageLoad() {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = 1000
      this.naturalHeight = 1333
      setTimeout(() => { if (this.onload) this.onload() }, 0)
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

describe('CalibrationOverlay — pointage assisté', () => {
  beforeEach(() => {
    stubImageLoad()
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: CW, bottom: CH, width: CW, height: CH, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: CW })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: CH })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function mount() {
    const utils = render(
      <CalibrationOverlay imageUrl="blob:fake" onCalibrated={() => {}} onSkip={() => {}} />
    )
    const { container } = utils
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    const stage = container.querySelector('img').parentElement
    const bouton = container.querySelector('button[data-tool="assist"]')
    expect(bouton).toBeTruthy()
    return { container, stage, bouton, utils }
  }

  it('activé d’office quand la détection de calibrage échoue', async () => {
    const { bouton } = await mount()
    await waitFor(() => expect(bouton.dataset.assist).toBe('1'))
  })

  it('un contact VISE : loupe ouverte, aucun repère posé', async () => {
    const { container, stage } = await mount()
    await waitFor(() => expect(container.querySelector('button[data-tool="assist"]').dataset.assist).toBe('1'))

    fireEvent.pointerDown(stage, { clientX: 200, clientY: 300 })
    expect(container.querySelector('[data-loupe]')).toBeTruthy()
    expect(container.querySelector('[data-markerid]')).toBeNull()
  })

  it('la pose a lieu au relâchement', async () => {
    const { container, stage } = await mount()
    await waitFor(() => expect(container.querySelector('button[data-tool="assist"]').dataset.assist).toBe('1'))

    fireEvent.pointerDown(stage, { clientX: 200, clientY: 300 })
    expect(container.querySelector('[data-markerid]')).toBeNull()
    fireEvent.pointerUp(stage, { clientX: 200, clientY: 300 })
    await waitFor(() => expect(container.querySelector('[data-markerid="0"]')).toBeTruthy())
    expect(container.querySelector('[data-loupe]')).toBeNull()
  })

  it('la loupe suit le doigt pendant la visée', async () => {
    const { container, stage } = await mount()
    await waitFor(() => expect(container.querySelector('button[data-tool="assist"]').dataset.assist).toBe('1'))

    fireEvent.pointerDown(stage, { clientX: 150, clientY: 260 })
    const l1 = container.querySelector('[data-loupe]').style.left
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 380 })
    expect(container.querySelector('[data-loupe]').style.left).not.toBe(l1)
  })

  it('la loupe apparaît aussi en GLISSANT un repère déjà posé', async () => {
    const { container, stage } = await mount()
    await waitFor(() => expect(container.querySelector('button[data-tool="assist"]').dataset.assist).toBe('1'))

    // Deux repères posés (contact + relâchement)
    for (const [x, y] of [[160, 260], [340, 260]]) {
      fireEvent.pointerDown(stage, { clientX: x, clientY: y })
      fireEvent.pointerUp(stage, { clientX: x, clientY: y })
      await new Promise((r) => setTimeout(r, 20))
    }
    const marqueur = container.querySelector('[data-markerid="0"]')
    await waitFor(() => expect(marqueur).toBeTruthy())
    expect(container.querySelector('[data-loupe]')).toBeNull()

    // On attrape le repère : la loupe doit s'ouvrir, même sans visée en cours
    fireEvent.pointerDown(marqueur, { clientX: 160, clientY: 260 })
    await waitFor(() => expect(container.querySelector('[data-loupe]')).toBeTruthy())
    fireEvent.pointerUp(window, { clientX: 160, clientY: 260 })
  })

  it('le bouton rend la pose directe', async () => {
    const { container, stage, bouton } = await mount()
    await waitFor(() => expect(bouton.dataset.assist).toBe('1'))
    fireEvent.click(bouton)
    await waitFor(() => expect(bouton.dataset.assist).toBe('0'))

    fireEvent.pointerDown(stage, { clientX: 200, clientY: 300 })
    await waitFor(() => expect(container.querySelector('[data-markerid="0"]')).toBeTruthy())
    expect(container.querySelector('[data-loupe]')).toBeNull()
  })

  it('aucune cale 1 mm tant qu’aucune échelle n’est validée', async () => {
    const { container } = await mount()
    // On ne dessine pas un instrument gradué sur une échelle qui n'existe pas encore.
    expect(container.querySelector('[data-mm-bar]')).toBeNull()
  })
})
