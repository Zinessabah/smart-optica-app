import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Câblage de l'amorçage depuis le backend (`/api/analyze-profile`) :
 * les 2 mires du clip détectées deviennent les 2 poignées de l'échelle, et leur hauteur
 * moyenne sert de ligne d'œil au vertex.
 *
 * L'API est SIMULÉE avec la réponse RÉELLE relevée sur une photo du projet.
 */

const { analyzeProfileMock } = vi.hoisted(() => ({ analyzeProfileMock: vi.fn() }))
vi.mock('../services/api', () => ({ analyzeProfile: analyzeProfileMock }))

const REPONSE = {
  width: 3024,
  height: 4032,
  lateral_markers: [[2484, 989], [2455, 1227]],
  scale_mm_per_px: 0.104271,      // échelle de la PHOTO LATÉRALE (25 mm / 239,8 px)
  scale_plausible: true,
}
// Ce que voit le navigateur : orientation EXIF appliquée → même espace que le backend.
const W = 3024, H = 4032
const EYE_LINE = 1108              // (989 + 1227) / 2
const LEFT_0 = 43, LEFT_1 = 57     // repli proportionnel des 2 poignées de l'échelle

function stubImageLoad() {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = W
      this.naturalHeight = H
      if (this.onload) this.onload()
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

const renderPM = (props = {}) =>
  render(<ProfileMeasure imageUrl="blob:fake"
    onCapture={() => {}} onSkip={() => {}} onBack={() => {}} {...props} />)

const byType = (container, type) => [...container.querySelectorAll(`[data-pt-type="${type}"]`)]
const pctLeft = (el) => parseFloat(el.style.left) / 100
const pctTop = (el) => parseFloat(el.style.top) / 100
const clickTool = (container, label) =>
  fireEvent.click([...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(label)))

describe('ProfileMeasure — amorçage depuis les mires détectées', () => {
  beforeEach(() => {
    stubImageLoad()
    analyzeProfileMock.mockReset()
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 533, width: 400, height: 533, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 533 })
    // fetch(imageUrl) → blob : l'image est déjà en mémoire côté client
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => ({ size: 1 }) })))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('pose les 2 poignées de l’échelle SUR les mires détectées', async () => {
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const { container } = renderPM()

    await waitFor(() => expect(analyzeProfileMock).toHaveBeenCalledTimes(1))
    // L'appel ne porte AUCUNE échelle : la détection latérale est indépendante de la photo de
    // face (les 2 clichés sont pris à des distances différentes). Avant, l'app transmettait
    // l'échelle frontale et refusait même d'appeler sans elle.
    expect(analyzeProfileMock.mock.calls[0]).toHaveLength(1)

    await waitFor(() => {
      const [m0, m1] = byType(container, 'verify')
      expect(pctLeft(m0)).toBeCloseTo(2484 / W, 4)
      expect(pctLeft(m1)).toBeCloseTo(2455 / W, 4)
    })
  })

  it('l’échelle déduite des mires est correcte (25 mm entre les 2 points)', async () => {
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const { container } = renderPM()

    // 2 mires à ~240 px pour 25 mm → ~0,104 mm/px → ~9,6 px/mm
    await waitFor(() => {
      const txt = container.textContent || ''
      expect(txt).toMatch(/9\.\d+ px\/mm/)
      expect(txt).toMatch(/mires détectées/)
    })
  })

  it('DÉTECTE et amorce SANS aucune calibration frontale (l’endpoint n’en a pas besoin)', async () => {
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const { container } = renderPM()          // aucune échelle frontale nulle part
    await waitFor(() => expect(analyzeProfileMock).toHaveBeenCalledTimes(1))
    // …et sans jamais lui transmettre d'échelle : la détection est indépendante
    expect(analyzeProfileMock.mock.calls[0]).toHaveLength(1)
    await waitFor(() => {
      const [m0, m1] = byType(container, 'verify')
      expect(pctLeft(m0)).toBeCloseTo(2484 / W, 4)
      expect(pctLeft(m1)).toBeCloseTo(2455 / W, 4)
    })
    expect(container.textContent).toMatch(/mires détectées/)
  })

  it('en cas d’échec de l’API, les poignées gardent leurs positions proportionnelles', async () => {
    analyzeProfileMock.mockRejectedValue(new Error('HTTP 500'))
    const { container } = renderPM()

    await waitFor(() => expect(analyzeProfileMock).toHaveBeenCalled())
    await waitFor(() => {
      const [m0, m1] = byType(container, 'verify')
      expect(pctLeft(m0)).toBeCloseTo(LEFT_0 / 100, 3)
      expect(pctLeft(m1)).toBeCloseTo(LEFT_1 / 100, 3)
      expect(container.textContent).toMatch(/mires non détectées/)
    })
  })

  it('ne reprend PAS les poignées à l’utilisateur s’il les a déjà déplacées', async () => {
    let resolveIt
    analyzeProfileMock.mockReturnValue(new Promise(r => { resolveIt = r }))
    const { container } = renderPM()

    await waitFor(() => expect(byType(container, 'verify').length).toBe(2))
    const handle = byType(container, 'verify')[0]
    // L'utilisateur déplace une poignée AVANT l'arrivée de la réponse
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 140, clientY: 150 })
    fireEvent.pointerUp(window, { clientX: 140, clientY: 150 })
    await waitFor(() => expect(pctLeft(handle)).not.toBeCloseTo(LEFT_0 / 100, 3))
    const moved = pctLeft(handle)

    await act(async () => { resolveIt(REPONSE) })

    expect(pctLeft(byType(container, 'verify')[0])).toBeCloseTo(moved, 4)   // position conservée
    expect(pctLeft(byType(container, 'verify')[0])).not.toBeCloseTo(2484 / W, 3)
  })

  it('place le vertex sur la LIGNE D’ŒIL des mires (et non sur un ratio de l’image)', async () => {
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const { container } = renderPM()

    await waitFor(() => expect(container.textContent).toMatch(/mires détectées/))
    clickTool(container, 'Angle pantoscopique')
    clickTool(container, 'Vertex')

    await waitFor(() => {
      const [v0] = byType(container, 'vertex')
      expect(pctTop(v0)).toBeCloseTo(EYE_LINE / H, 4)        // 1108/4032 ≈ 27,5 %
      // …et centré sur le clip, pas sur le milieu de l'image (50 %)
      expect(pctLeft(v0)).toBeLessThan(2482 / W)
    })
    // Le repli par ratio (40 % de la hauteur) n'est PAS utilisé quand la détection a réussi
    expect(pctTop(byType(container, 'vertex')[0])).not.toBeCloseTo(0.40, 2)
  })
})
