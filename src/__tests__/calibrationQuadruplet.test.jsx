/**
 * Calibrage automatique — contrat avec le backend du clip v19.5.
 *
 * Le clip v19.5 porte une QUATRIÈME mire faciale (surélevée) : le backend renvoie
 * donc 4 repères, et non 3. L'overlay exigeait `markers.length === 3` et rejetait
 * une détection pourtant RÉUSSIE — la détection serveur passait pour un échec.
 *
 * Le calibrage lui-même n'a besoin que de la rangée (gauche / centre / droite) ;
 * la 4ᵉ mire sert à l'auto-contrôle des étalons et à la mesure du roll du clip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor, configure } from '@testing-library/react'
import CalibrationOverlay from '../CalibrationOverlay'

configure({ asyncUtilTimeout: 3000 })

const { reponse } = vi.hoisted(() => ({ reponse: { value: null } }))

vi.mock('../services/api', () => ({
  analyzeCalibration: vi.fn(async () => reponse.value),
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

function detection(nbMires, quadCheck = null) {
  const base = [
    { x: 299, y: 700 }, { x: 499, y: 700 }, { x: 699, y: 700 },
  ]
  return {
    markers: nbMires === 4 ? [...base, { x: 620, y: 644 }] : base,
    scale_mm_per_px: 0.25,
    spacing_px: 200,
    detection_confidence: 0.96,
    face_used: true,
    width: 1000,
    height: 1333,
    facial_quad_check: quadCheck,
  }
}

describe('CalibrationOverlay — clip v19.5 à 4 mires', () => {
  beforeEach(() => {
    stubImageLoad()
    // jsdom n'implémente pas fetch('blob:...') : sans ce stub, l'overlay part en
    // repli AVANT même d'appeler l'analyse mockée, et le test ne prouverait rien.
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['x']) })))
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, left: 0, top: 0, right: CW, bottom: CH, width: CW, height: CH, toJSON() {} }
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: CW })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: CH })
  })
  afterEach(() => vi.unstubAllGlobals())

  function monter() {
    return render(
      <CalibrationOverlay imageUrl="blob:fake" onCalibrated={() => {}} onSkip={() => {}} />
    )
  }

  it('accepte 4 mires : la détection réussie ne doit pas passer pour un échec', async () => {
    reponse.value = detection(4, { n_points: 4, roll_deg: 0.11, roll_consistent: true })
    const { container } = monter()
    const indicateur = await waitFor(() => {
      const el = container.querySelector('[data-detect="method"]')
      expect(el).toBeTruthy()
      expect(el.textContent).toMatch(/Détection serveur/)
      return el
    })
    expect(indicateur.textContent).not.toMatch(/infructueuse/)
  })

  it('ne pose que les 3 mires de la rangée (la 4e n’est pas un repère de calibrage)', async () => {
    reponse.value = detection(4, { n_points: 4, roll_deg: 0.11, roll_consistent: true })
    const { container } = monter()
    await waitFor(() =>
      expect(container.querySelectorAll('[data-markerid]').length).toBe(3))
    expect(container.querySelector('[data-markerid="3"]')).toBeNull()
    // les libellés de la rangée restent alignés (un 4e point les décalerait)
    expect(container.textContent).toMatch(/Gauche/)
    expect(container.textContent).toMatch(/Droite/)
  })

  it('signale la 4e mire et le roll mesuré sur le clip', async () => {
    reponse.value = detection(4, { n_points: 4, roll_deg: 0.11, roll_consistent: true })
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/4 mires/)
      return e
    })
    expect(el.textContent).toMatch(/clip \+0\.1°/)
  })

  it('affiche le roll négatif avec son signe', async () => {
    reponse.value = detection(4, { n_points: 4, roll_deg: -3.42, roll_consistent: true })
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/clip/)
      return e
    })
    expect(el.textContent).toMatch(/clip -3\.4°/)
  })

  it('un désaccord entre les deux références de roll passe en alerte', async () => {
    reponse.value = detection(4, { n_points: 4, roll_deg: -5.9, roll_consistent: false })
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/clip/)
      return e
    })
    // couleur d'alerte, pas le vert de validation
    expect(el.querySelector('p').style.color).toMatch(/red/)
  })

  it('accepte toujours un clip à 3 mires (rétro-compatible)', async () => {
    reponse.value = detection(3)
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/Détection serveur/)
      return e
    })
    expect(el.textContent).not.toMatch(/4 mires/)
    await waitFor(() =>
      expect(container.querySelectorAll('[data-markerid]').length).toBe(3))
  })

  it('sans diagnostic du quadrilatère, aucun roll n’est inventé', async () => {
    reponse.value = detection(3, null)
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/Détection serveur/)
      return e
    })
    expect(el.textContent).not.toMatch(/clip/)
  })

  it('4e mire vue mais REJETÉE : l’app le dit, et n’invente pas de roll', async () => {
    // Cas de la photo réelle : le détecteur voit une 4ᵉ mire dont la géométrie ne
    // colle pas (dispersion 50 %) → le backend ne publie que la rangée, sans roll.
    reponse.value = {
      ...detection(3),
      facial_quad_check: {
        n_points: 4, quad_valid: false, roll_deg: null,
        roll_consistent: null, ratio_spread: 0.5,
      },
    }
    const { container } = monter()
    const el = await waitFor(() => {
      const e = container.querySelector('[data-detect="method"]')
      expect(e.textContent).toMatch(/4e mire écartée/)
      return e
    })
    expect(el.textContent).not.toMatch(/clip \+|clip -/)
    expect(container.querySelectorAll('[data-markerid]').length).toBe(3)
  })

  it('2 mires seulement ne suffisent pas : pointage manuel', async () => {
    reponse.value = { ...detection(3), markers: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }
    const { container } = monter()
    await waitFor(() => {
      const el = container.querySelector('[data-detect="method"]')
      expect(el.textContent).toMatch(/infructueuse/)
    })
    expect(container.querySelectorAll('[data-markerid]').length).toBe(0)
  })
})
