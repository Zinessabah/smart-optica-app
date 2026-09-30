import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import ProfileMeasure from '../ProfileMeasure'

/**
 * Câblage de l'amorçage depuis le backend (`/api/analyze-profile`) :
 * les mires du clip détectées deviennent les marqueurs de l'échelle, et leur hauteur
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
const LEFT_0 = 43, LEFT_1 = 57     // repli proportionnel des 2 premiers marqueurs

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

  it('pose les 3 marqueurs sur les mires détectées (base ET surélevée)', async () => {
    // La surélevée est construite avec les COTES du clip : 20,3039 mm de chaque mire basse.
    const [m0, m1] = REPONSE.lateral_markers
    const basePx = Math.hypot(m1[0] - m0[0], m1[1] - m0[1])
    const mid = [(m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2]
    const h = Math.sqrt((basePx * (20.3039 / 25)) ** 2 - (basePx / 2) ** 2)
    const perp = [(m1[1] - m0[1]) / basePx, -(m1[0] - m0[0]) / basePx]
    const raised = [Math.round(mid[0] + perp[0] * h), Math.round(mid[1] + perp[1] * h)]
    analyzeProfileMock.mockResolvedValue({ ...REPONSE, lateral_raised: raised })
    const { container } = renderPM()

    await waitFor(() => {
      const pts = byType(container, 'verify').map((p) => [
        Math.round(pctLeft(p) * W), Math.round(pctTop(p) * H)])
      expect(pts).toHaveLength(3)
      expect(pts).toEqual(expect.arrayContaining([m0, m1, raised]))
    })
  })

  it('une NOUVELLE photo repart de ZÉRO (détection relancée, rien de la précédente)', async () => {
    // Photo A : détectée, 2 mires verticales → ~9,6 px/mm
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const vue = (url) => <ProfileMeasure imageUrl={url}
      onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />
    const { container, rerender } = render(vue('blob:A'))
    await waitFor(() => expect(analyzeProfileMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.textContent).toMatch(/9\.\d+ px\/mm/))

    // L'utilisateur REPREND la photo : nouvelle imageUrl, MÊME instance de composant
    analyzeProfileMock.mockResolvedValue({
      ...REPONSE, lateral_markers: [[1000, 900], [1400, 900]], scale_mm_per_px: 0.0625,
    })
    rerender(vue('blob:B'))

    // 1. La détection doit être RELANCÉE pour la nouvelle photo
    await waitFor(() => expect(analyzeProfileMock).toHaveBeenCalledTimes(2))
    // 2. Les marqueurs doivent être ceux de B, jamais ceux de A
    await waitFor(() => {
      const pts = byType(container, 'verify').map((p) => [
        Math.round(pctLeft(p) * W), Math.round(pctTop(p) * H)])
      expect(pts).toContainEqual([1000, 900])
      expect(pts).not.toContainEqual([2484, 989])
    })
  })

  // Le mode strict est ACTIF dans main.jsx : React monte chaque composant DEUX fois en dev et
  // rejoue tous les effets. C'est ce double passage qui replaçait les marqueurs provisoires
  // par-dessus une détection réussie (marqueurs à 1734/2298 px → 22,56 px/mm) — invisible en test,
  // car jsdom n'est pas en StrictMode.
  it('en StrictMode (double montage), les marqueurs restent ceux de la DÉTECTION', async () => {
    // Surélevée construite avec les cotes du clip, pour que le triangle soit CONFORME
    // (sinon le contrôle du placement refuse l'échelle — c'est son rôle, pas un défaut).
    const [m0, m1] = REPONSE.lateral_markers
    const basePx = Math.hypot(m1[0] - m0[0], m1[1] - m0[1])
    const mid = [(m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2]
    const h = Math.sqrt((basePx * (20.3039 / 25)) ** 2 - (basePx / 2) ** 2)
    const perp = [(m1[1] - m0[1]) / basePx, -(m1[0] - m0[0]) / basePx]
    const raised = [Math.round(mid[0] + perp[0] * h), Math.round(mid[1] + perp[1] * h)]
    analyzeProfileMock.mockResolvedValue({ ...REPONSE, lateral_raised: raised })
    const { container } = render(
      <StrictMode>
        <ProfileMeasure imageUrl="blob:fake"
          onCapture={() => {}} onSkip={() => {}} onBack={() => {}} />
      </StrictMode>
    )
    await waitFor(() => {
      const pts = byType(container, 'verify').map((p) => [
        Math.round(pctLeft(p) * W), Math.round(pctTop(p) * H)])
      expect(pts).toContainEqual(m0)
      expect(pts).toContainEqual(m1)
      expect(pts).toContainEqual(raised)
    })
    // et JAMAIS les positions provisoires (0,43 / 0,57 de la largeur)
    const provisoire = Math.round(0.43 * W)
    const pts2 = byType(container, 'verify').map((p) => Math.round(pctLeft(p) * W))
    expect(pts2).not.toContain(provisoire)
    // l'échelle affichée est celle des mires (239,8 px pour 25 mm), pas celle des provisoires
    await waitFor(() => expect(container.textContent).toMatch(/9\.\d+ px\/mm/))
  })

  it("branche MESURÉE : l'outil d'angle ne demande que la LIGNE DU VERRE (2 points)", async () => {
    analyzeProfileMock.mockResolvedValue(REPONSE)
    const { container } = renderPM()
    await waitFor(() => expect(container.textContent).toMatch(/mires détectées/))

    clickTool(container, 'Angle pantoscopique')
    // 2 points seulement : la branche vient des mires MESURÉES, elle ne se pose plus au doigt.
    await waitFor(() => expect(byType(container, 'angle').length).toBe(2))
    expect(container.textContent).toMatch(/branche est[^.]{0,40}mesurée/i)
    // Et le tiret tant que la ligne du verre n'a pas été POSÉE.
    expect(container.textContent).toContain('—')

    // On pose la ligne du verre : la valeur apparaît. La ligne par défaut est perpendiculaire à la
    // base mesurée, donc la pantoscopie lue est 0 — c'est un point de départ, pas une mesure.
    for (const h of byType(container, 'angle')) {
      fireEvent.pointerDown(h, { clientX: 100, clientY: 150 })
      fireEvent.pointerMove(window, { clientX: 130, clientY: 160 })
      fireEvent.pointerUp(window, { clientX: 130, clientY: 160 })
    }
    await waitFor(() => expect(container.textContent).toMatch(/∠\s*0(\.0)?°/))
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

    await waitFor(() => expect(byType(container, 'verify').length).toBe(3))
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
